import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  claims: vi.fn(),
  user: vi.fn(),
  profile: vi.fn(),
}));
vi.mock("@tanstack/react-start", () => ({
  createMiddleware: () => ({ server: (handler: unknown) => handler }),
}));
vi.mock("@tanstack/react-start/server", () => ({ getRequest: mocks.request }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: { getClaims: mocks.claims, getUser: mocks.user },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: mocks.profile }) }) }),
  }),
}));
import { requireSupabaseAuth } from "./auth-middleware";
const run = requireSupabaseAuth as unknown as (input: {
  next: ReturnType<typeof vi.fn>;
}) => Promise<unknown>;

beforeEach(() => {
  vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
  mocks.request.mockReturnValue(
    new Request("https://example.test", { headers: { authorization: "Bearer a.b.c" } }),
  );
  mocks.claims.mockResolvedValue({ data: { claims: { sub: "user-a", aal: "aal1" } }, error: null });
  mocks.user.mockResolvedValue({ data: { user: { id: "user-a", factors: [] } }, error: null });
  mocks.profile.mockResolvedValue({
    data: { is_active: true, approval_status: "approved" },
    error: null,
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("server function authorization", () => {
  it("allows an active approved user without an enrolled factor", async () => {
    const next = vi.fn();
    await run({ next });
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ context: expect.objectContaining({ userId: "user-a" }) }),
    );
  });
  it.each([
    null,
    { is_active: false, approval_status: "approved" },
    { is_active: true, approval_status: "pending" },
    { is_active: true, approval_status: "rejected" },
  ])("denies inaccessible, inactive or unapproved profiles: %j", async (profile) => {
    mocks.profile.mockResolvedValue({ data: profile, error: null });
    const next = vi.fn();
    await expect(run({ next })).rejects.toThrow("Account access");
    expect(next).not.toHaveBeenCalled();
  });
  it("fails closed on a profile read error even with data", async () => {
    mocks.profile.mockResolvedValue({
      data: { is_active: true, approval_status: "approved" },
      error: new Error("unavailable"),
    });
    await expect(run({ next: vi.fn() })).rejects.toThrow("Account access");
  });
  it.each([null, { id: "another-user" }])(
    "rejects removed or mismatched Auth users: %j",
    async (user) => {
      mocks.user.mockResolvedValue({ data: { user }, error: null });
      await expect(run({ next: vi.fn() })).rejects.toThrow("User is no longer available");
    },
  );
  it("rejects a user lookup error", async () => {
    mocks.user.mockResolvedValue({ data: { user: null }, error: new Error("offline") });
    await expect(run({ next: vi.fn() })).rejects.toThrow("User is no longer available");
  });
  it("rejects invalid claims before reading the account", async () => {
    mocks.claims.mockResolvedValue({ data: null, error: new Error("invalid JWT") });
    await expect(run({ next: vi.fn() })).rejects.toThrow("Invalid token");
    expect(mocks.user).not.toHaveBeenCalled();
  });
  it.each(["aal1", undefined])(
    "requires a second factor for enrolled users with assurance %s",
    async (aal) => {
      mocks.user.mockResolvedValue({
        data: { user: { id: "user-a", factors: [{ status: "verified" }] } },
        error: null,
      });
      mocks.claims.mockResolvedValue({ data: { claims: { sub: "user-a", aal } }, error: null });
      const next = vi.fn();
      await expect(run({ next })).rejects.toThrow("two-factor");
      expect(next).not.toHaveBeenCalled();
    },
  );
  it("refuses a customer portal token before reading the account", async () => {
    mocks.claims.mockResolvedValue({
      data: { claims: { sub: "cust-a", role: "portal_customer", aal: "aal1" } },
      error: null,
    });
    const next = vi.fn();
    await expect(run({ next })).rejects.toThrow("Customer portal sessions");
    expect(mocks.user).not.toHaveBeenCalled();
    expect(mocks.profile).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });
  it("refuses a customer portal user even if the token's role claim were wrong", async () => {
    mocks.user.mockResolvedValue({
      data: { user: { id: "user-a", role: "portal_customer", factors: [] } },
      error: null,
    });
    const next = vi.fn();
    await expect(run({ next })).rejects.toThrow("Customer portal sessions");
    expect(next).not.toHaveBeenCalled();
  });
  it("accepts completed MFA", async () => {
    mocks.user.mockResolvedValue({
      data: { user: { id: "user-a", factors: [{ status: "verified" }] } },
      error: null,
    });
    mocks.claims.mockResolvedValue({
      data: { claims: { sub: "user-a", aal: "aal2" } },
      error: null,
    });
    const next = vi.fn();
    await run({ next });
    expect(next).toHaveBeenCalledOnce();
  });
});
