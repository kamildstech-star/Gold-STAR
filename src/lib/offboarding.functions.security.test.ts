import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate = (data: unknown) => data;
    const builder = {
      middleware: () => builder,
      inputValidator: (fn: typeof validate) => {
        validate = fn;
        return builder;
      },
      handler: (fn: (args: unknown) => unknown) => async (args: { data: unknown }) =>
        fn({ ...args, data: validate(args.data) }),
    };
    return builder;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
const state = vi.hoisted(() => ({
  update: vi.fn(),
  signOut: vi.fn(),
  roles: vi.fn(),
  adminRpc: vi.fn(),
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => ({ select: () => ({ in: state.roles }) }),
    rpc: state.adminRpc,
    auth: {
      admin: {
        updateUserById: state.update,
        signOut: state.signOut,
      },
    },
  },
}));
import { deactivateUserNow, restoreUserSignIn } from "./offboarding.functions";
const id = "11111111-1111-4111-8111-111111111111";
const rpc = vi.fn();
let active = true;
let admin = true;
const context = {
  userId: "22222222-2222-4222-8222-222222222222",
  supabase: {
    rpc,
    from: (table: string) => ({
      select: () => ({
        eq: () =>
          table === "user_roles"
            ? Promise.resolve({ data: [{ role: admin ? "admin" : "rep" }] })
            : {
                maybeSingle: async () => ({
                  data: { is_active: active, approval_status: "approved" },
                }),
              },
      }),
    }),
  },
};
const invoke = (fn: unknown, userId = id) =>
  (fn as (args: unknown) => Promise<unknown>)({ data: { userId }, context });
beforeEach(() => {
  active = true;
  admin = true;
  state.update.mockReset().mockResolvedValue({ error: null });
  state.signOut.mockReset();
  state.roles.mockReset().mockResolvedValue({ data: [], error: null });
  state.adminRpc.mockReset().mockResolvedValue({ data: 2, error: null });
  rpc.mockReset().mockImplementation(async (name) => ({
    data: name === "is_sales_lead" ? true : { checklist_id: "checklist" },
    error: null,
  }));
});
describe("offboarding Auth ban", () => {
  it.each(["admin", "owner", "dev"])(
    "prevents sales leads banning a target with role %s",
    async (role) => {
      state.roles.mockResolvedValue({
        data: [
          { user_id: id, role },
          { user_id: context.userId, role: "sales_manager" },
        ],
        error: null,
      });
      await expect(invoke(deactivateUserNow)).rejects.toThrow("protected role");
      expect(state.update).not.toHaveBeenCalled();
      expect(rpc).toHaveBeenCalledTimes(1);
    },
  );
  it("prevents an admin banning an owner", async () => {
    state.roles.mockResolvedValue({
      data: [
        { user_id: id, role: "owner" },
        { user_id: context.userId, role: "admin" },
      ],
      error: null,
    });
    await expect(invoke(deactivateUserNow)).rejects.toThrow("protected role");
    expect(state.update).not.toHaveBeenCalled();
  });
  it("permits an owner to deactivate an admin", async () => {
    state.roles.mockResolvedValue({
      data: [
        { user_id: id, role: "admin" },
        { user_id: context.userId, role: "owner" },
      ],
      error: null,
    });
    await expect(invoke(deactivateUserNow)).resolves.toMatchObject({ signInBlocked: true });
  });
  it("fails closed if authoritative roles cannot be read", async () => {
    state.roles.mockResolvedValue({ data: null, error: new Error("unavailable") });
    await expect(invoke(deactivateUserNow)).rejects.toThrow("verify target authority");
    expect(state.update).not.toHaveBeenCalled();
  });
  it("bans before durable deactivation and never sends a UUID to signOut", async () => {
    expect(await invoke(deactivateUserNow)).toMatchObject({
      signInBlocked: true,
      sessionsRevoked: true,
    });
    // Sessions end AFTER the profile is deactivated, through the service-role
    // RPC — never by handing a user id to signOut.
    expect(state.adminRpc).toHaveBeenCalledWith("revoke_user_sessions", { _user_id: id });
    expect(state.adminRpc.mock.invocationCallOrder[0]).toBeGreaterThan(
      rpc.mock.invocationCallOrder[1],
    );
    expect(state.update).toHaveBeenCalledWith(id, { ban_duration: "876000h" });
    expect(state.update.mock.invocationCallOrder[0]).toBeLessThan(rpc.mock.invocationCallOrder[1]);
    expect(state.signOut).not.toHaveBeenCalled();
  });
  it("says so, without failing the deactivation, when sessions could not be ended", async () => {
    state.adminRpc.mockResolvedValue({ data: null, error: new Error("not permitted") });
    expect(await invoke(deactivateUserNow)).toMatchObject({
      signInBlocked: true,
      sessionsRevoked: false,
    });
  });
  it("does not end sessions for a deactivation that was refused", async () => {
    rpc.mockResolvedValue({ data: false });
    await expect(invoke(deactivateUserNow)).rejects.toThrow("Only");
    expect(state.adminRpc).not.toHaveBeenCalled();
  });
  it("does not deactivate if Auth banning fails", async () => {
    state.update.mockResolvedValue({ error: new Error("Auth unavailable") });
    await expect(invoke(deactivateUserNow)).rejects.toThrow("Deactivation was not applied");
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it("retains the ban and describes partial failure if the RPC fails", async () => {
    rpc
      .mockResolvedValueOnce({ data: true })
      .mockResolvedValueOnce({ error: new Error("DB unavailable") });
    await expect(invoke(deactivateUserNow)).rejects.toThrow("Auth ban remains");
    expect(state.update).toHaveBeenCalledTimes(1);
  });
  it("rejects unprivileged callers before Auth mutation", async () => {
    rpc.mockResolvedValue({ data: false });
    await expect(invoke(deactivateUserNow)).rejects.toThrow("Only");
    expect(state.update).not.toHaveBeenCalled();
  });
  it("rejects self-deactivation", async () => {
    await expect(invoke(deactivateUserNow, context.userId)).rejects.toThrow("yourself");
    expect(state.update).not.toHaveBeenCalled();
  });
  it("lets an administrator unban an approved active profile", async () => {
    expect(await invoke(restoreUserSignIn)).toEqual({ signInBlocked: false });
    expect(state.update).toHaveBeenCalledWith(id, { ban_duration: "none" });
  });
  it("does not unban an inactive profile", async () => {
    active = false;
    await expect(invoke(restoreUserSignIn)).rejects.toThrow("Restore and approve");
    expect(state.update).not.toHaveBeenCalled();
  });
  it("does not let ordinary users unban themselves or others", async () => {
    admin = false;
    await expect(invoke(restoreUserSignIn)).rejects.toThrow("Only");
    expect(state.update).not.toHaveBeenCalled();
  });
  it("reports an unban failure explicitly", async () => {
    state.update.mockResolvedValue({ error: new Error("Auth unavailable") });
    await expect(invoke(restoreUserSignIn)).rejects.toThrow("Auth ban may remain");
  });
});
