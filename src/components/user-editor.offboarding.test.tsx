import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("react", async (original) => ({
  ...(await original<object>()),
  useState: (initial: unknown) => [initial, vi.fn()],
}));
const state = vi.hoisted(() => ({
  mutations: [] as Array<{ mutationFn: (active: boolean) => Promise<void> }>,
  update: vi.fn(),
  restore: vi.fn(),
  deactivate: vi.fn(),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: null }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: (options: { mutationFn: (active: boolean) => Promise<void> }) => {
    state.mutations.push(options);
    return { isPending: false, mutate: vi.fn() };
  },
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => ({ update: (values: unknown) => ({ eq: async () => state.update(values) }) }),
  },
}));
vi.mock("@/lib/offboarding.functions", () => ({
  restoreUserSignIn: state.restore,
  deactivateUserNow: state.deactivate,
}));
vi.mock("@/components/app-context", () => ({
  useAppContext: () => ({ userId: "admin", allLocations: [], regions: [], writesDisabled: false }),
}));
vi.mock("@/components/user-permissions", () => ({ UserPermissionsSection: () => null }));
vi.mock("@/components/access/access-history", () => ({ AccessHistory: () => null }));
vi.mock("@/components/multi-location-select", () => ({ MultiLocationSelect: () => null }));
import { UserEditor } from "./user-editor";
import type { AdminUserRow } from "@/lib/admin.functions";
const user = {
  user_id: "person",
  is_active: false,
  roles: [],
  location_ids: [],
  region_ids: [],
  location_roles: [],
} as unknown as AdminUserRow;
beforeEach(() => {
  state.mutations.length = 0;
  state.update.mockReset().mockResolvedValue({ error: null });
  state.restore.mockReset().mockResolvedValue({ signInBlocked: false });
  state.deactivate.mockReset().mockResolvedValue({ signInBlocked: true });
});
const action = () => {
  UserEditor({ user, onChange: vi.fn() });
  // Primary location, role grant, role revoke, then the Active control.
  return state.mutations[3].mutationFn;
};
describe("user editor offboarding integration", () => {
  it("restores the profile before restoring Auth sign-in", async () => {
    await action()(true);
    expect(state.update).toHaveBeenCalledWith({ is_active: true });
    expect(state.restore).toHaveBeenCalledWith({ data: { userId: "person" } });
    expect(state.update.mock.invocationCallOrder[0]).toBeLessThan(
      state.restore.mock.invocationCallOrder[0],
    );
  });
  it("does not unban when the profile write fails", async () => {
    state.update.mockResolvedValue({ error: new Error("profile denied") });
    await expect(action()(true)).rejects.toThrow("profile denied");
    expect(state.restore).not.toHaveBeenCalled();
  });
  it("rolls back the toggle on an Auth failure so reactivation can be retried", async () => {
    state.restore.mockRejectedValue(new Error("Auth unavailable"));
    await expect(action()(true)).rejects.toThrow("Auth unavailable");
    expect(state.update.mock.calls.map(([value]) => value)).toEqual([
      { is_active: true },
      { is_active: false },
    ]);
  });
  it("reports inconsistent profile state explicitly if rollback also fails", async () => {
    state.restore.mockRejectedValue(new Error("Auth unavailable"));
    state.update
      .mockResolvedValueOnce({ error: null })
      .mockResolvedValueOnce({ error: new Error("DB unavailable") });
    await expect(action()(true)).rejects.toThrow("Use Restore sign-in to retry");
  });
  it("deactivates through the protected server endpoint rather than only a profile toggle", async () => {
    await action()(false);
    expect(state.deactivate).toHaveBeenCalledWith({ data: { userId: "person" } });
    expect(state.update).not.toHaveBeenCalled();
  });
});
