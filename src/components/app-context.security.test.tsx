// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  from: vi.fn(),
  onAuth: vi.fn(),
  impersonation: vi.fn(),
  endImpersonation: vi.fn(),
  getSession: vi.fn(),
  cache: { cancelQueries: vi.fn(), clear: vi.fn() },
  router: { clearCache: vi.fn(), invalidate: vi.fn() },
}));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => mocks.cache }));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => mocks.router }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getUser: mocks.getUser,
      getSession: mocks.getSession,
      onAuthStateChange: mocks.onAuth,
    },
    from: mocks.from,
  },
}));
vi.mock("@/integrations/supabase/session-cookie", () => ({ syncDocumentSessionCookie: vi.fn() }));
vi.mock("@/lib/activity", () => ({ logSignInOnce: vi.fn() }));
vi.mock("@/lib/impersonation", () => ({
  fetchActiveImpersonation: mocks.impersonation,
  endImpersonation: mocks.endImpersonation,
}));
import { AppContextProvider, identityRetry, useAppContext } from "./app-context";
import {
  clearViewAsSession,
  currentViewAsReadOnlyReason,
  rememberViewAsSession,
} from "@/lib/view-as";
let root: Root;
let latest: ReturnType<typeof useAppContext>;
let authEvent: (event: string, session: unknown) => void;
let profile: unknown;
let profileError: unknown;
let roles: unknown;
let locations: unknown[];
let membersByUser: Record<string, unknown[]>;
let primaryByUser: Record<string, string | null>;
function Probe() {
  latest = useAppContext();
  return null;
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  profile = { full_name: "A", approval_status: "approved", is_active: true, rejected_reason: null };
  profileError = null;
  mocks.cache.cancelQueries.mockResolvedValue(undefined);
  mocks.router.invalidate.mockResolvedValue(undefined);
  roles = { data: [{ role: "admin" }], error: null };
  mocks.getUser.mockResolvedValue({
    data: { user: { id: "a", email: "a@example.test" } },
    error: null,
  });
  mocks.impersonation.mockResolvedValue(null);
  mocks.endImpersonation.mockResolvedValue(undefined);
  mocks.getSession.mockResolvedValue({ data: { session: null } });
  locations = [];
  membersByUser = {};
  primaryByUser = {};
  // Run the error-retry path in full, but without its production back-off, so
  // the assertions below observe the settled outcome rather than a sleep.
  identityRetry.baseDelayMs = 0;
  mocks.onAuth.mockImplementation((fn) => {
    authEvent = fn;
    return { data: { subscription: { unsubscribe: vi.fn() } } };
  });
  mocks.from.mockImplementation((table: string) => {
    let selection = "";
    let forUser = "a";
    const result = () =>
      table === "profiles"
        ? {
            data:
              selection === "primary_location_id"
                ? { primary_location_id: primaryByUser[forUser] ?? null }
                : profile,
            error: profileError,
          }
        : table === "user_roles"
          ? roles
          : table === "locations"
            ? { data: locations, error: null }
            : table === "location_members"
              ? { data: membersByUser[forUser] ?? [], error: null }
              : { data: [], error: null };
    const builder = {
      select: (columns: string) => {
        selection = columns;
        return builder;
      },
      eq: (column: string, value: unknown) => {
        if (column === "user_id") forUser = String(value);
        return builder;
      },
      order: () => builder,
      maybeSingle: () => Promise.resolve(result()),
      then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
        Promise.resolve(result()).then(resolve, reject),
    };
    return builder;
  });
  root = createRoot(document.createElement("div"));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.clearAllMocks();
  clearViewAsSession();
});
const mount = () =>
  act(async () => {
    root.render(
      <AppContextProvider>
        <Probe />
      </AppContextProvider>,
    );
    await tick();
  });
describe("identity context", () => {
  it("publishes an approved active identity", async () => {
    await mount();
    expect(latest.userId).toBe("a");
    expect(latest.realRoles).toEqual(["admin"]);
    expect(latest.loading).toBe(false);
  });
  it.each(["missing", "error", "inactive", "pending"])(
    "withholds roles for %s profile",
    async (kind) => {
      if (kind === "missing") profile = null;
      if (kind === "error") profileError = new Error("unavailable");
      if (kind === "inactive") profile = { is_active: false, approval_status: "approved" };
      if (kind === "pending") profile = { is_active: true, approval_status: "pending" };
      await mount();
      // An errored read is retried before it is refused (see identityRetry).
      // Wait for the identity read to settle instead of racing it: the point
      // of this test is what the context publishes once it has decided.
      await act(async () => {
        for (let i = 0; i < 30 && latest.loading; i++) await tick();
      });
      expect(latest.realRoles).toEqual([]);
      expect(latest.approvalStatus).not.toBe("approved");
      expect(latest.loading).toBe(false);
    },
  );
  it("clears identity and scope on signout", async () => {
    await mount();
    await act(async () => authEvent("SIGNED_OUT", null));
    expect(latest.userId).toBeNull();
    expect(latest.roles).toEqual([]);
    expect(latest.visibleLocations).toEqual([]);
    expect(latest.impersonation).toBeNull();
  });
  it("discards an earlier account's delayed role response after switching", async () => {
    let finish!: (value: unknown) => void;
    roles = new Promise((resolve) => {
      finish = resolve;
    });
    await mount();
    expect(latest.loading).toBe(true);
    roles = { data: [{ role: "crew" }], error: null };
    mocks.getUser.mockResolvedValue({ data: { user: { id: "b" } }, error: null });
    await act(async () => {
      authEvent("SIGNED_IN", { user: { id: "b" } });
      await tick();
    });
    await act(async () => {
      await tick();
    });
    expect(latest.userId).toBe("b");
    expect(latest.roles).toEqual(["crew"]);
    await act(async () => {
      finish({ data: [{ role: "admin" }], error: null });
      await tick();
    });
    expect(latest.userId).toBe("b");
    expect(latest.roles).toEqual(["crew"]);
  });
  it("ignores an in-flight Auth response after signout", async () => {
    let finish!: (value: unknown) => void;
    mocks.getUser.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await mount();
    await act(async () => authEvent("SIGNED_OUT", null));
    await act(async () => {
      finish({ data: { user: { id: "a" } }, error: null });
      await tick();
    });
    expect(latest.userId).toBeNull();
    expect(latest.roles).toEqual([]);
  });
});

/*
 * "View as person" — Mark, 11 Oct: "I also want to be able to view as
 * specific people." The context is where "who am I" is decided, so this is
 * where the preview is proved: the viewed person's roles, offices and "my"
 * scope flow out; authorship (userId) never changes; writes are off.
 */
describe("view as person", () => {
  const token = (sessionId: string) =>
    `h.${btoa(JSON.stringify({ session_id: sessionId })).replace(/=+$/, "")}.s`;
  const personView = {
    id: "imp-1",
    started_at: new Date().toISOString(),
    target_user_id: "dana",
    preview_role: null,
    target_scope: {
      user_id: "dana",
      full_name: "Dana Ruiz",
      email: null,
      is_active: true,
      roles: ["sales_person"],
      location_ids: ["nwk"],
      region_ids: [],
    },
  };

  beforeEach(() => {
    locations = [
      { id: "nwk", code: "NWK", name: "Newark", region_id: null },
      { id: "tre", code: "TRE", name: "Trenton", region_id: null },
    ];
    membersByUser = { dana: [{ location_id: "nwk", role: "manager" }] };
    primaryByUser = { dana: "nwk" };
    mocks.getSession.mockResolvedValue({ data: { session: { access_token: token("s-1") } } });
  });

  it("simulates their roles, offices, own office and 'my' scope; authorship stays yours", async () => {
    rememberViewAsSession("imp-1", "s-1");
    mocks.impersonation.mockResolvedValue(personView);
    await mount();
    expect(latest.userId).toBe("a");
    expect(latest.viewerUserId).toBe("dana");
    expect(latest.realRoles).toEqual(["admin"]);
    expect(latest.roles).toEqual(["sales_person"]);
    expect(latest.memberships).toEqual([{ location_id: "nwk", role: "manager" }]);
    expect(latest.primaryLocationId).toBe("nwk");
    expect(latest.visibleLocations.map((l) => l.id)).toEqual(["nwk"]);
    expect(latest.viewingAsPerson).toEqual({
      userId: "dana",
      name: "Dana Ruiz",
      roles: ["sales_person"],
      officeName: "Newark",
    });
  });

  it("is read only: the switch-back sentence on every disabled write, and the mutation net", async () => {
    rememberViewAsSession("imp-1", "s-1");
    mocks.impersonation.mockResolvedValue(personView);
    await mount();
    expect(latest.writesDisabled).toBe(true);
    expect(latest.writesDisabledReason).toBe("Viewing as Dana Ruiz — switch back to make changes");
    expect(currentViewAsReadOnlyReason()).toBe(latest.writesDisabledReason);
  });

  it("is ended, not resumed, when it was started in another sign-in", async () => {
    rememberViewAsSession("imp-1", "s-old");
    mocks.impersonation.mockResolvedValue(personView);
    await mount();
    expect(mocks.endImpersonation).toHaveBeenCalledTimes(1);
    expect(latest.impersonation).toBeNull();
    expect(latest.viewerUserId).toBe("a");
    expect(latest.roles).toEqual(["admin"]);
    expect(currentViewAsReadOnlyReason()).toBeNull();
  });

  it("is ended after a working day even within the same sign-in", async () => {
    rememberViewAsSession("imp-1", "s-1");
    mocks.impersonation.mockResolvedValue({
      ...personView,
      started_at: new Date(Date.now() - 9 * 60 * 60 * 1000).toISOString(),
    });
    await mount();
    expect(mocks.endImpersonation).toHaveBeenCalledTimes(1);
    expect(latest.viewingAsPerson).toBeNull();
  });

  it("a role preview keeps your own 'my' scope and its old wording", async () => {
    mocks.impersonation.mockResolvedValue({
      id: "imp-2",
      started_at: new Date().toISOString(),
      target_user_id: null,
      preview_role: "crew",
      target_scope: null,
    });
    await mount();
    expect(latest.roles).toEqual(["crew"]);
    expect(latest.viewerUserId).toBe("a");
    expect(latest.viewingAsPerson).toBeNull();
    expect(latest.writesDisabledReason).toMatch(/View As is active/);
    expect(currentViewAsReadOnlyReason()).toBeNull();
  });

  it("is cleared on sign-out", async () => {
    rememberViewAsSession("imp-1", "s-1");
    mocks.impersonation.mockResolvedValue(personView);
    await mount();
    expect(latest.viewingAsPerson).not.toBeNull();
    await act(async () => authEvent("SIGNED_OUT", null));
    expect(latest.viewingAsPerson).toBeNull();
    expect(latest.viewerUserId).toBeNull();
    expect(latest.writesDisabled).toBe(false);
    expect(currentViewAsReadOnlyReason()).toBeNull();
  });
});
