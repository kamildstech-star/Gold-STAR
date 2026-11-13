import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ app: vi.fn(), query: vi.fn(), rpc: vi.fn() }));
vi.mock("@/components/app-context", () => ({ useAppContext: mocks.app }));
vi.mock("@tanstack/react-query", () => ({ useQuery: mocks.query, useQueryClient: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: mocks.rpc } }));
import { useCan, useMyPermissions } from "./permissions";
import { useMyPageAccess } from "./use-page-access";

function read<T>(hook: () => T): T {
  let result: T;
  function Probe() {
    result = hook();
    return null;
  }
  renderToString(createElement(Probe));
  return result!;
}
const granted = [{ permission_key: "users.manage", allowed: true }];
beforeEach(() => {
  mocks.app.mockReturnValue({ userId: "user-a", loading: false, roles: ["sales_rep"] });
  mocks.query.mockReturnValue({
    data: granted,
    isError: false,
    isPending: false,
    isLoading: false,
  });
});
describe("live authorization hooks", () => {
  it("permits a successfully fetched capability", () => {
    expect(read(() => useCan("users.manage"))).toBe(true);
  });
  it("drops cached grants on a refetch error", () => {
    mocks.query.mockReturnValue({
      data: granted,
      isError: true,
      isPending: false,
      isLoading: false,
    });
    expect(read(() => useCan("users.manage"))).toBe(false);
    expect(read(useMyPermissions).rows).toEqual([]);
    expect(read(useMyPageAccess).canOpen("/pipeline")).toBe(false);
  });
  it("does not reuse cached capabilities without an identity", () => {
    mocks.app.mockReturnValue({ userId: null, loading: false, roles: ["admin"] });
    expect(read(() => useCan("users.manage"))).toBe(false);
    expect(read(useMyPageAccess).canOpen("/admin")).toBe(false);
  });
  it("withholds prior admin page access while a new identity is loading", () => {
    mocks.app.mockReturnValue({ userId: "user-b", loading: true, roles: ["admin"] });
    expect(read(useMyPageAccess).canOpen("/admin")).toBe(false);
  });
  it("keeps structural admin page access but not stale capabilities on permission errors", () => {
    mocks.app.mockReturnValue({ userId: "user-a", loading: false, roles: ["admin"] });
    mocks.query.mockReturnValue({
      data: granted,
      isError: true,
      isPending: false,
      isLoading: false,
    });
    expect(read(useMyPageAccess).canOpen("/admin")).toBe(true);
    expect(read(() => useCan("users.manage"))).toBe(false);
  });
  it("denies unknown paths", () => {
    expect(read(useMyPageAccess).canOpen("/unregistered-screen")).toBe(false);
  });
});

/**
 * View As. The failure this pins (QC, 2026-09-09): an admin previewing Sales
 * Person still saw Internal Cost and Overall Profit on the Job Calculator,
 * because useCan answered with the admin's own effective_permissions.
 */
describe("authorization hooks under View As", () => {
  const adminRows = [
    { permission_key: "job.view_costs", allowed: true, source: "role", source_role: "admin" },
    { permission_key: "job.view_margin", allowed: true, source: "role", source_role: "admin" },
    { permission_key: "ai.assistant", allowed: true, source: "role", source_role: "admin" },
    { permission_key: "page.jobs", allowed: true, source: "role", source_role: "admin" },
    { permission_key: "page.admin", allowed: true, source: "role", source_role: "admin" },
  ];
  const ok = (data: unknown) => ({ data, isError: false, isPending: false, isLoading: false });
  const previewing = (extra: object = {}) => ({
    userId: "admin-a",
    loading: false,
    roles: ["sales_person"],
    realRoles: ["admin"],
    impersonation: {
      id: "imp-1",
      started_at: "2026-09-09T10:00:00Z",
      target_user_id: null,
      preview_role: "sales_person",
      target_scope: null,
    },
    ...extra,
  });
  /** Mock calls accumulate across tests; the one this render made is the last. */
  const lastViewAsCall = () =>
    mocks.query.mock.calls
      .map((call) => call[0] as { queryKey: unknown[]; enabled?: boolean })
      .filter((options) => options.queryKey[0] === "view-as-permissions")
      .at(-1);
  const answer = (real: unknown, viewAs: unknown) =>
    mocks.query.mockImplementation(({ queryKey }: { queryKey: unknown[] }) =>
      queryKey[0] === "view-as-permissions" ? viewAs : real,
    );

  it("answers for the previewed role, not the actor", () => {
    mocks.app.mockReturnValue(previewing());
    answer(ok(adminRows), ok(["ai.assistant", "page.jobs"]));
    expect(read(() => useCan("job.view_costs"))).toBe(false);
    expect(read(() => useCan("job.view_margin"))).toBe(false);
    expect(read(() => useCan("ai.assistant"))).toBe(true);
  });

  it("asks for the previewed role's defaults, keyed to the preview", () => {
    mocks.app.mockReturnValue(previewing());
    answer(ok(adminRows), ok([]));
    read(() => useCan("ai.assistant"));
    const viewAsCall = lastViewAsCall();
    expect(viewAsCall?.queryKey).toEqual(["view-as-permissions", "admin-a", "sales_person", null]);
    expect(viewAsCall?.enabled).toBe(true);
  });

  it("does not query for a preview when nobody is being viewed as", () => {
    mocks.app.mockReturnValue({ userId: "user-a", loading: false, roles: ["admin"] });
    mocks.query.mockReturnValue(ok(adminRows));
    read(() => useCan("job.view_costs"));
    const viewAsCall = lastViewAsCall();
    expect(viewAsCall?.enabled).toBe(false);
  });

  it("narrows page access to the previewed role as well", () => {
    mocks.app.mockReturnValue(previewing());
    answer(ok(adminRows), ok(["page.jobs"]));
    const access = read(useMyPageAccess);
    expect(access.canOpen("/jobs")).toBe(true);
    expect(access.canOpen("/admin")).toBe(false);
  });

  it("allows nothing while the previewed identity's answer is still loading", () => {
    mocks.app.mockReturnValue(previewing());
    answer(ok(adminRows), { data: undefined, isError: false, isPending: true, isLoading: true });
    expect(read(() => useCan("ai.assistant"))).toBe(false);
    expect(read(() => useCan("job.view_costs"))).toBe(false);
  });

  it("allows nothing when the previewed identity's answer failed", () => {
    mocks.app.mockReturnValue(previewing());
    answer(ok(adminRows), { data: undefined, isError: true, isPending: false, isLoading: false });
    expect(read(() => useCan("ai.assistant"))).toBe(false);
    expect(read(useMyPermissions).error).toBe(true);
  });

  it("never widens: a non-privileged actor keeps only what they really hold", () => {
    mocks.app.mockReturnValue(previewing({ realRoles: ["sales_head"] }));
    answer(
      ok([
        { permission_key: "job.view_costs", allowed: false, source: "none" },
        { permission_key: "ai.assistant", allowed: true, source: "role" },
      ]),
      ok(["job.view_costs", "ai.assistant"]),
    );
    expect(read(() => useCan("job.view_costs"))).toBe(false);
    expect(read(() => useCan("ai.assistant"))).toBe(true);
  });

  it("reads a user impersonation from that user's effective permissions", () => {
    mocks.app.mockReturnValue(
      previewing({
        impersonation: {
          id: "imp-2",
          started_at: "2026-09-09T10:00:00Z",
          target_user_id: "rep-1",
          preview_role: null,
          target_scope: { user_id: "rep-1", roles: ["sales_person"] },
        },
      }),
    );
    answer(ok(adminRows), ok(["ai.assistant"]));
    expect(read(() => useCan("job.view_costs"))).toBe(false);
    const viewAsCall = lastViewAsCall();
    expect(viewAsCall?.queryKey).toEqual(["view-as-permissions", "admin-a", null, "rep-1"]);
  });
});
