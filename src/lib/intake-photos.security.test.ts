import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ sign: vi.fn() }));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    const builder = {
      middleware: () => builder,
      inputValidator: () => builder,
      handler: (fn: unknown) => fn,
    };
    return builder;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    storage: { from: () => ({ createSignedUrls: mocks.sign }) },
  },
}));
import { intakePhotoUrls } from "./intake-photos.functions";

const requestId = "11111111-1111-1111-1111-111111111111";
const ownPath = `${requestId}/22222222-2222-2222-2222-222222222222.jpg`;
const foreignPath = "33333333-3333-3333-3333-333333333333/22222222-2222-2222-2222-222222222222.jpg";
beforeEach(() => mocks.sign.mockReset().mockResolvedValue({ data: [] }));

async function invoke(row: unknown, requestVisible = true) {
  const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: row, error: null }) };
  const requestQuery = {
    select: () => requestQuery,
    eq: () => requestQuery,
    maybeSingle: async () => ({ data: requestVisible ? { id: requestId } : null, error: null }),
  };
  return (intakePhotoUrls as unknown as (input: unknown) => Promise<unknown>)({
    data: { submissionId: "submission" },
    context: {
      supabase: { from: (table: string) => (table === "intake_requests" ? requestQuery : q) },
    },
  });
}
it("never signs a foreign request's photo on a visible submission", async () => {
  await invoke({
    request_id: requestId,
    photos: [ownPath, foreignPath].map((path) => ({ path, size: 100 })),
  });
  // Ten minutes, the signed-URL default (src/lib/signed-url.ts; was an hour).
  expect(mocks.sign).toHaveBeenCalledWith([ownPath], 600);
});
it("never signs anything for a hidden submission", async () => {
  await expect(invoke(null)).rejects.toThrow("Not authorized");
  expect(mocks.sign).not.toHaveBeenCalled();
});
it("refuses a visible submission retargeted to an inaccessible request", async () => {
  await expect(
    invoke({ request_id: requestId, photos: [{ path: ownPath, size: 100 }] }, false),
  ).rejects.toThrow("Not authorized");
  expect(mocks.sign).not.toHaveBeenCalled();
});
