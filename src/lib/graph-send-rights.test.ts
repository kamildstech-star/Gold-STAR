import { describe, expect, it } from "vitest";

import { assertCanSendAs } from "./graph.functions";

/**
 * The mailbox row is fetched with the service role, so this check is the only
 * thing deciding whose From: address a caller may use. The bug it replaces was
 * that the check ran only when an optional `accountId` happened to be passed.
 */

type Ctx = Parameters<typeof assertCanSendAs>[0];

function ctx(userId: string, opts: { manages?: string[]; roles?: string[] } = {}): Ctx {
  return {
    userId,
    supabase: {
      rpc: async (fn: string, args: Record<string, string>) => {
        if (fn === "can_manage_location") {
          return { data: (opts.manages ?? []).includes(args["_location_id"] ?? "") };
        }
        if (fn === "has_role") {
          return { data: (opts.roles ?? []).includes(args["_role"] ?? "") };
        }
        return { data: null };
      },
    },
  } as unknown as Ctx;
}

const ownMailbox = { upn: "dana@example.com", user_id: "dana", location_id: null };
const bossMailbox = { upn: "boss@example.com", user_id: "boss", location_id: null };
const officeMailbox = { upn: "brooklyn@example.com", user_id: null, location_id: "bk" };

describe("assertCanSendAs", () => {
  it("allows your own mailbox", async () => {
    await expect(assertCanSendAs(ctx("dana"), ownMailbox)).resolves.toBeUndefined();
  });

  it("refuses someone else's mailbox with no accountId in play", async () => {
    await expect(assertCanSendAs(ctx("dana"), bossMailbox)).rejects.toThrow(
      /cannot send as boss@example.com/,
    );
  });

  it("allows an office mailbox for a location you manage", async () => {
    await expect(
      assertCanSendAs(ctx("dana", { manages: ["bk"] }), officeMailbox),
    ).resolves.toBeUndefined();
  });

  it("refuses an office mailbox for a location you do not manage", async () => {
    await expect(assertCanSendAs(ctx("dana", { manages: ["qns"] }), officeMailbox)).rejects.toThrow(
      /cannot send as/,
    );
  });

  it("allows an owner, admin or dev to send as anything", async () => {
    for (const role of ["owner", "admin", "dev"]) {
      await expect(
        assertCanSendAs(ctx("dana", { roles: [role] }), bossMailbox),
      ).resolves.toBeUndefined();
    }
  });

  it("does not let another role stand in for admin", async () => {
    await expect(
      assertCanSendAs(ctx("dana", { roles: ["sales_manager"] }), bossMailbox),
    ).rejects.toThrow(/cannot send as/);
  });

  it("does not treat an unowned, unscoped mailbox as fair game", async () => {
    const orphan = { upn: "orphan@example.com", user_id: null, location_id: null };
    await expect(assertCanSendAs(ctx("dana"), orphan)).rejects.toThrow(/cannot send as/);
  });
});
