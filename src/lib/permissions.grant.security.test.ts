import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * grantPermission used to delete the override and then insert its
 * replacement from the browser, with a client-chosen `granted_by`. An insert
 * that failed after the delete quietly lost a revoke. These pin the
 * replacement: one RPC, actor taken from the session, no fallback.
 */
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: mocks.rpc, from: mocks.from },
}));
vi.mock("@/components/app-context", () => ({ useAppContext: vi.fn() }));
import { grantPermission } from "./permissions";

beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.from.mockReset();
});

describe("grantPermission", () => {
  it("replaces the override in one RPC and never writes the table directly", async () => {
    mocks.rpc.mockResolvedValue({ data: "override-id", error: null });
    await grantPermission({
      userId: "target",
      key: "users.manage",
      effect: "revoke",
      locationId: "office",
      expiresAt: "2026-12-31T23:59:59.000Z",
      reason: "Left the team",
    });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith("replace_user_permission", {
      _user_id: "target",
      _key: "users.manage",
      _effect: "revoke",
      _location_id: "office",
      _region_id: undefined,
      _expires_at: "2026-12-31T23:59:59.000Z",
      _reason: "Left the team",
    });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("sends no granted_by: the database stamps it from auth.uid()", async () => {
    mocks.rpc.mockResolvedValue({ data: "override-id", error: null });
    // A caller that still tries to name the actor gets nowhere with it.
    await grantPermission({
      userId: "target",
      key: "users.manage",
      effect: "grant",
      grantedBy: "forged",
    } as Parameters<typeof grantPermission>[0]);
    const args = mocks.rpc.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.keys(args).some((k) => k.includes("granted_by"))).toBe(false);
    expect(Object.values(args)).not.toContain("forged");
  });

  it.each(["PGRST202", "42883"])(
    "refuses without touching the table when the function is missing (%s)",
    async (code) => {
      mocks.rpc.mockResolvedValue({ data: null, error: { code, message: "missing" } });
      await expect(
        grantPermission({ userId: "target", key: "users.manage", effect: "revoke" }),
      ).rejects.toThrow("Existing rules were left as they were");
      expect(mocks.from).not.toHaveBeenCalled();
    },
  );

  it("surfaces a refusal from the database (e.g. a Block on a break-glass dev)", async () => {
    const refusal = { code: "42501", message: "this person holds dev, the break-glass role" };
    mocks.rpc.mockResolvedValue({ data: null, error: refusal });
    await expect(
      grantPermission({ userId: "dev-user", key: "users.manage", effect: "revoke" }),
    ).rejects.toBe(refusal);
    expect(mocks.from).not.toHaveBeenCalled();
  });
});

describe("callers", () => {
  const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  it.each(["src/components/access/access-person-panel.tsx", "src/components/user-permissions.tsx"])(
    "%s no longer hands grantPermission an actor",
    (path) => {
      const calls = read(path).match(/grantPermission\(\{[\s\S]*?\}\)/g) ?? [];
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) expect(call).not.toMatch(/grantedBy/);
    },
  );
});
