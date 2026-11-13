import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => vi.fn());
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc } }));

import {
  REVERSION_CHECKING_REASON,
  REVERSION_MANAGER_ONLY_REASON,
  composeReversionReason,
  isManagerForAccountOffice,
  moveAccountBackToPipeline,
  reversionRights,
  statusAfterReversion,
} from "./pipeline-reversion";

describe("moving a client back to prospecting", () => {
  beforeEach(() => rpc.mockReset());

  it("uses the atomic database operation", async () => {
    rpc.mockResolvedValue({ error: null });

    await moveAccountBackToPipeline({
      accountId: "account",
      stageId: "ready",
      reason: "Moved back to pipeline — Relationship reset",
      status: "active",
    });

    expect(rpc).toHaveBeenCalledWith("move_account_back_to_pipeline", {
      _account_id: "account",
      _stage_id: "ready",
      _reason: "Moved back to pipeline — Relationship reset",
    });
  });

  it("surfaces a database rollback error", async () => {
    const error = new Error("rolled back");
    rpc.mockResolvedValue({ error });
    await expect(
      moveAccountBackToPipeline({
        accountId: "account",
        stageId: "ready",
        reason: "Moved back to pipeline — Deal fell through",
        status: "active",
      }),
    ).rejects.toBe(error);
  });

  it("is a manager's call, not a rep's", () => {
    const office = "office-1";

    // A rep on the account's office: `can_manage_location` says no.
    expect(
      isManagerForAccountOffice({ privileged: false, locationId: office, managesOffice: false }),
    ).toBe(false);
    // A manager over that office.
    expect(
      isManagerForAccountOffice({ privileged: false, locationId: office, managesOffice: true }),
    ).toBe(true);
    // Owner/admin/dev, including on an account with no office at all —
    // `can_manage_location` is false for a null location.
    expect(
      isManagerForAccountOffice({ privileged: true, locationId: null, managesOffice: null }),
    ).toBe(true);
    expect(
      isManagerForAccountOffice({ privileged: false, locationId: null, managesOffice: true }),
    ).toBe(false);
    // Still outstanding stays outstanding.
    expect(
      isManagerForAccountOffice({ privileged: false, locationId: office, managesOffice: null }),
    ).toBeNull();
  });

  it("says why the button is off, and allows nothing until the answer arrives", () => {
    expect(reversionRights(true)).toEqual({ allowed: true, reason: null });
    expect(reversionRights(false)).toEqual({
      allowed: false,
      reason: REVERSION_MANAGER_ONLY_REASON,
    });
    expect(reversionRights(null)).toEqual({ allowed: false, reason: REVERSION_CHECKING_REASON });
  });

  it("keeps the existing reason and status rules", () => {
    expect(composeReversionReason("Other", "new owner")).toBe(
      "Moved back to pipeline — Other: new owner",
    );
    expect(statusAfterReversion("active")).toBe("prospect");
    expect(statusAfterReversion("onboarding")).toBe("prospect");
    expect(statusAfterReversion("prospect")).toBeNull();
  });
});
