import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ assurance: vi.fn(), factors: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      mfa: {
        getAuthenticatorAssuranceLevel: mocks.assurance,
        listFactors: mocks.factors,
      },
    },
  },
}));
import { mfaGateForSession } from "./mfa";
beforeEach(() => {
  mocks.assurance.mockResolvedValue({
    data: { currentLevel: "aal1", nextLevel: "aal2" },
    error: null,
  });
  mocks.factors.mockResolvedValue({ data: { totp: [] }, error: null });
});
describe("MFA session gate", () => {
  it("does not bypass required MFA when factor lookup returns no verified factor", async () => {
    await expect(mfaGateForSession()).rejects.toThrow("factor is unavailable");
  });
  it("returns the verified factor when a challenge is required", async () => {
    mocks.factors.mockResolvedValue({
      data: { totp: [{ id: "factor", status: "verified" }] },
      error: null,
    });
    await expect(mfaGateForSession()).resolves.toMatchObject({
      required: true,
      factorId: "factor",
    });
  });
  it("allows a completed challenge", async () => {
    mocks.assurance.mockResolvedValue({
      data: { currentLevel: "aal2", nextLevel: "aal2" },
      error: null,
    });
    await expect(mfaGateForSession()).resolves.toEqual({ required: false });
  });
  it("propagates assurance lookup failures", async () => {
    mocks.assurance.mockResolvedValue({ data: null, error: new Error("lookup failed") });
    await expect(mfaGateForSession()).rejects.toThrow("lookup failed");
  });
});
