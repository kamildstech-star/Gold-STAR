import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  response: { data: "lead-1", error: null } as {
    data: string | null;
    error: Error | null;
  },
  rpcName: "",
  rpcArgs: null as { _account_id: string } | null,
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: vi.fn(async (name: string, args: { _account_id: string }) => {
      mocks.rpcName = name;
      mocks.rpcArgs = args;
      return mocks.response;
    }),
  },
}));

import { claimLead } from "./new-leads";

describe("claimLead", () => {
  beforeEach(() => {
    mocks.response = { data: "lead-1", error: null };
    mocks.rpcName = "";
    mocks.rpcArgs = null;
  });

  it("asks the authenticated database function to claim the lead", async () => {
    await claimLead("lead-1");

    expect(mocks.rpcName).toBe("claim_new_lead");
    expect(mocks.rpcArgs).toEqual({ _account_id: "lead-1" });
  });

  it("does not overwrite the rep who won a concurrent claim", async () => {
    mocks.response = { data: null, error: null };

    await expect(claimLead("lead-1")).rejects.toThrow(
      "This lead was already claimed by another rep.",
    );
  });

  it("surfaces database failures", async () => {
    mocks.response = { data: null, error: new Error("database unavailable") };

    await expect(claimLead("lead-1")).rejects.toThrow("database unavailable");
  });

  it("does not call the claim RPC while View As disables writes", async () => {
    await expect(
      claimLead("lead-1", {
        disabled: true,
        reason: "Exit View As to make changes.",
      }),
    ).rejects.toThrow("Exit View As to make changes.");

    expect(mocks.rpcName).toBe("");
    expect(mocks.rpcArgs).toBeNull();
  });
});
