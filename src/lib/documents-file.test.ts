import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  claims: vi.fn(),
  user: vi.fn(),
  profile: vi.fn(),
  document: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({ createFileRoute: () => (config: unknown) => config }));
vi.mock("@/lib/documents", () => ({
  DOCUMENT_BUCKET: "documents",
  documentMime: () => "application/pdf",
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: { getClaims: mocks.claims, getUser: mocks.user },
    from: (table: string) => ({
      select: () => ({
        eq: () => ({ maybeSingle: table === "profiles" ? mocks.profile : mocks.document }),
      }),
    }),
  }),
}));
import { Route } from "../routes/api/documents.$id.file";
const handler = (
  Route as unknown as {
    server: {
      handlers: { GET: (input: { request: Request; params: { id: string } }) => Promise<Response> };
    };
  }
).server.handlers.GET;
const request = () =>
  handler({
    request: new Request(
      "https://goldstar.test/api/documents/00000000-0000-0000-0000-000000000001/file",
      { headers: { authorization: "Bearer a.b.c" } },
    ),
    params: { id: "00000000-0000-0000-0000-000000000001" },
  });
beforeEach(() => {
  vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
  mocks.claims.mockResolvedValue({ data: { claims: { sub: "a", aal: "aal1" } }, error: null });
  mocks.user.mockResolvedValue({ data: { user: { id: "a", factors: [] } }, error: null });
  mocks.profile.mockResolvedValue({
    data: { is_active: true, approval_status: "approved" },
    error: null,
  });
  mocks.document.mockResolvedValue({
    data: {
      id: "doc",
      name: "sample.pdf",
      mime: "application/pdf",
      storage_bucket: "documents",
      storage_path: "sample.pdf",
    },
    error: null,
  });
  mocks.fetch.mockImplementation(async () => new Response("fixture PDF"));
  vi.stubGlobal("fetch", mocks.fetch);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
describe("document file session gate", () => {
  it.each([
    null,
    { is_active: false, approval_status: "approved" },
    { is_active: true, approval_status: "pending" },
  ])("rejects unavailable or disabled profiles before reading documents: %j", async (profile) => {
    mocks.profile.mockResolvedValue({ data: profile, error: null });
    const response = await request();
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.document).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("rejects incomplete enrolled MFA", async () => {
    mocks.user.mockResolvedValue({
      data: { user: { id: "a", factors: [{ status: "verified" }] } },
      error: null,
    });
    expect((await request()).status).toBe(401);
    expect(mocks.document).not.toHaveBeenCalled();
  });
  it("rejects deleted Auth users", async () => {
    mocks.user.mockResolvedValue({ data: { user: null }, error: null });
    expect((await request()).status).toBe(401);
    expect(mocks.document).not.toHaveBeenCalled();
  });
  it("streams for active approved users with completed MFA", async () => {
    mocks.user.mockResolvedValue({
      data: { user: { id: "a", factors: [{ status: "verified" }] } },
      error: null,
    });
    mocks.claims.mockResolvedValue({ data: { claims: { sub: "a", aal: "aal2" } }, error: null });
    expect((await request()).status).toBe(200);
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });
});

/**
 * When the document viewer showed "This browser will not display the PDF"
 * (Mark, 5 Oct), this route was the first suspect: a `Content-Disposition:
 * attachment` or a wrong `Content-Type` stops any browser rendering a PDF
 * inline however it is embedded. It was innocent — the cause was the app's
 * own `object-src 'none'` — but nothing in the suite said so, and the next
 * person to debug a blank pane deserves to be able to rule this out in a
 * second. These are the headers a PDF actually leaves with.
 */
describe("the headers a PDF leaves with", () => {
  const signedIn = () => {
    mocks.user.mockResolvedValue({
      data: { user: { id: "a", factors: [{ status: "verified" }] } },
      error: null,
    });
    mocks.claims.mockResolvedValue({ data: { claims: { sub: "a", aal: "aal2" } }, error: null });
  };

  it("serves a PDF inline, typed, and byte-rangeable", async () => {
    signedIn();
    const response = await request();
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toMatch(/^inline;/);
    // pdf.js reads a large document by range rather than pulling all of it.
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    // Per-user bytes behind RLS: never in a shared cache, never in the PWA's.
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("switches to attachment only when asked", async () => {
    signedIn();
    const response = await handler({
      request: new Request(
        "https://goldstar.test/api/documents/00000000-0000-0000-0000-000000000001/file?disposition=attachment",
        { headers: { authorization: "Bearer a.b.c" } },
      ),
      params: { id: "00000000-0000-0000-0000-000000000001" },
    });
    expect(response.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(response.headers.get("content-type")).toBe("application/pdf");
  });
});
