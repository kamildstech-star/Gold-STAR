import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { transitionIdentityCaches } from "@/lib/identity-cache";
import { supabase } from "@/integrations/supabase/client";
import { syncDocumentSessionCookie } from "@/integrations/supabase/session-cookie";
import { isPrivileged, primaryRole, type AppRole } from "@/lib/roles";
import { logSignInOnce } from "@/lib/activity";
import {
  endImpersonation,
  fetchActiveImpersonation,
  type ActiveImpersonation,
} from "@/lib/impersonation";
import {
  clearViewAsSession,
  currentAuthSessionId,
  fetchViewAsDetail,
  officeLabel,
  previewOfficeScope,
  setViewAsReadOnly,
  sortRoles,
  viewAsBelongsToSession,
  viewAsExpired,
  viewAsReadOnlyReason,
  type ViewAsDetail,
  type ViewAsPerson,
} from "@/lib/view-as";

export type Location = {
  id: string;
  code: string;
  name: string;
  /** @deprecated legacy single region — use region_ids */
  region_id: string | null;
  region_ids: string[];
  lat?: number | null;
  lon?: number | null;
};

export type Membership = { location_id: string; role: string };

export type Region = { id: string; name: string };

type AppCtx = {
  loading: boolean;
  /**
   * The SIGNED-IN user — always, View As or not. Anything written (author_id,
   * created_by, actor_id, a row's user_id) takes this one.
   */
  userId: string | null;
  /**
   * Whose "my …" views these are: the person being viewed as, otherwise the
   * signed-in user. Read scopes only — my jobs, my tasks, assigned to me, my
   * commissions, the home dashboard. NEVER put it in a write: the database
   * session is still the admin's, and a row must never claim to be by
   * someone who did not make it (view-as.wiring.test.ts holds this).
   */
  viewerUserId: string | null;
  /** The person being viewed as ("View as person"), or null. */
  viewingAsPerson: ViewAsPerson | null;
  email: string | null;
  fullName: string | null;
  /** Admin approval gate: 'pending' | 'approved' | 'rejected'. */
  approvalStatus: string;
  rejectedReason: string | null;

  /** Real roles the signed-in user actually holds. */
  realRoles: AppRole[];
  /** Effective roles — real, or the impersonation target's roles when View As is active. */
  roles: AppRole[];
  /** Effective primary — same idea. */
  primary: AppRole | null;

  /** Effective office memberships — the viewed person's while viewing as someone. */
  memberships: Membership[];
  /**
   * The user's own office (`profiles.primary_location_id`) — what forms
   * default to. Null until the profile migration lands or an admin sets one.
   */
  primaryLocationId: string | null;
  regions: Region[];
  regionMemberships: string[];

  /** Locations the effective identity can see (intersects target with real when impersonating). */
  visibleLocations: Location[];
  allLocations: Location[];
  currentLocationId: string | null; // null ="All"
  setCurrentLocationId: (id: string | null) => void;

  /** Impersonation state and helpers. */
  impersonation: ActiveImpersonation | null;
  isImpersonating: boolean;
  writesDisabled: boolean;
  writesDisabledReason: string | null;
  refreshImpersonation: () => Promise<void>;

  refresh: () => Promise<void>;
};

const Ctx = createContext<AppCtx | null>(null);

const STORAGE_KEY = "rh:currentLocationId";

/**
 * How the identity read behaves when a query errors: total attempts and the
 * base back-off (multiplied by the attempt number). Exported so tests can run
 * the retry path without sleeping through it; production keeps the defaults.
 */
export const identityRetry = { attempts: 3, baseDelayMs: 400 };

export function AppContextProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [fullName, setFullName] = useState<string | null>(null);
  const [approvalStatus, setApprovalStatus] = useState<string>("pending");
  const [rejectedReason, setRejectedReason] = useState<string | null>(null);
  const [realRoles, setRealRoles] = useState<AppRole[]>([]);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [primaryLocationId, setPrimaryLocationId] = useState<string | null>(null);
  const [regions, setRegions] = useState<Region[]>([]);
  const [regionMemberships, setRegionMemberships] = useState<string[]>([]);
  const [allLocations, setAllLocations] = useState<Location[]>([]);
  const [impersonation, setImpersonation] = useState<ActiveImpersonation | null>(null);
  const [viewAsDetail, setViewAsDetail] = useState<ViewAsDetail | null>(null);
  const generation = useRef(0);
  /*
   * Who the last auth event was about. `undefined` until the first one, so an
   * INITIAL_SESSION still counts as a change and loads normally; after that,
   * only a genuinely different user tears the context down. See the listener.
   */
  const lastUserId = useRef<string | null | undefined>(undefined);
  const impersonationRequest = useRef(0);

  const clearIdentity = useCallback(() => {
    setUserId(null);
    setEmail(null);
    setFullName(null);
    setApprovalStatus("pending");
    setRejectedReason(null);
    setRealRoles([]);
    setMemberships([]);
    setPrimaryLocationId(null);
    setRegions([]);
    setRegionMemberships([]);
    setAllLocations([]);
    setImpersonation(null);
    setViewAsDetail(null);
  }, []);

  const [currentLocationId, setCurrentLocId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return window.localStorage.getItem(STORAGE_KEY) || null;
  });

  const setCurrentLocationId = (id: string | null) => {
    setCurrentLocId(id);
    if (typeof window !== "undefined") {
      if (id) window.localStorage.setItem(STORAGE_KEY, id);
      else window.localStorage.removeItem(STORAGE_KEY);
    }
  };

  const refreshImpersonation = useCallback(async () => {
    const identityVersion = generation.current;
    const requestVersion = ++impersonationRequest.current;
    const current = () =>
      generation.current === identityVersion && impersonationRequest.current === requestVersion;
    const endIt = async () => {
      try {
        await endImpersonation();
      } catch {
        /* ignore — fall through and keep the app usable */
      }
      if (current()) {
        setImpersonation(null);
        setViewAsDetail(null);
      }
    };
    try {
      const active = await fetchActiveImpersonation();
      if (!current()) return;
      // A View As must never silently persist: an admin who previewed `crew`
      // days ago would keep seeing a narrowed app. Anything older than the
      // working day is ended automatically — role previews and person views.
      if (active && viewAsExpired(active.started_at)) {
        await endIt();
        return;
      }
      if (active?.target_user_id && !active.preview_role) {
        // A person view ends with the sign-in that started it (view-as.ts).
        const belongs = viewAsBelongsToSession(active.id, await currentAuthSessionId());
        if (!current()) return;
        if (belongs === false) {
          await endIt();
          return;
        }
        let detail: ViewAsDetail;
        try {
          detail = await fetchViewAsDetail(active.target_user_id);
        } catch {
          detail = { memberships: [], primaryLocationId: null };
        }
        if (!current()) return;
        setViewAsDetail(detail);
      } else {
        setViewAsDetail(null);
      }
      if (current()) setImpersonation(active);
    } catch {
      if (current()) {
        setImpersonation(null);
        setViewAsDetail(null);
      }
    }
  }, []);

  /**
   * `quiet` re-reads the identity WITHOUT emptying the context first.
   *
   * The loud version is right for a sign-in: nothing below should render
   * against the previous account while the new one is being read. It is wrong
   * for a token refresh, because `loading` is what PageAccessGate waits on,
   * and while it waits the authenticated outlet is replaced by "Loading…" —
   * every component under it unmounts and every `useState` in them is gone.
   * See the listener below for the measurement.
   */
  const load = useCallback(
    async (opts?: { quiet?: boolean }) => {
      const version = ++generation.current;
      const current = () => generation.current === version;
      if (!opts?.quiet) {
        setLoading(true);
        clearIdentity();
      }
      try {
        const { data: userData, error: userError } = await supabase.auth.getUser();
        if (!current()) return;
        if (userError) throw userError;
        const uid = userData.user?.id ?? null;
        await transitionIdentityCaches(queryClient, router, uid);
        if (!current()) return;
        setUserId(uid);
        setEmail(userData.user?.email ?? null);
        if (!uid) {
          setLoading(false);
          return;
        }
        // A transient failure (statement timeout, dropped connection) must not be
        // mistaken for a rejected account, so the whole identity read is retried
        // a couple of times before we refuse. Only a persistent failure denies.
        const readIdentity = async () =>
          await Promise.all([
            supabase.from("user_roles").select("role").eq("user_id", uid),
            supabase.from("location_members").select("location_id, role").eq("user_id", uid),
            supabase.from("regions").select("id, name").order("name"),
            supabase.from("region_members").select("region_id").eq("user_id", uid),
            supabase.from("locations").select("id, code, name, region_id, lat, lon").order("code"),
            supabase.from("location_regions").select("location_id, region_id"),
            supabase
              .from("profiles")
              .select("full_name, approval_status, rejected_reason, is_active")
              .eq("user_id", uid)
              .maybeSingle(),
          ]);

        let results = await readIdentity();
        for (let attempt = 1; attempt < identityRetry.attempts; attempt++) {
          if (!current()) return;
          // Only an *error* is worth retrying. A profile row that is simply not
          // there (no error, no data) is a definitive answer from the database,
          // and asking again just delays the refusal the security tests expect.
          if (!results.some((r) => r.error)) break;
          await new Promise((r) => setTimeout(r, identityRetry.baseDelayMs * attempt));
          if (!current()) return;
          results = await readIdentity();
        }
        const [
          rolesRes,
          membersRes,
          regionsRes,
          regionMembersRes,
          locsRes,
          locRegionsRes,
          profileRes,
        ] = results;
        if (!current()) return;
        if (results.some((r) => r.error) || !profileRes.data) {
          throw new Error("Account access could not be verified. Please try signing in again.");
        }

        const profile = profileRes.data;
        if (profile.is_active !== true || profile.approval_status !== "approved") {
          setApprovalStatus(profile.is_active !== true ? "rejected" : profile.approval_status);
          setRejectedReason(
            profile.is_active !== true
              ? "This account is inactive. Contact an administrator."
              : profile.rejected_reason,
          );
          return;
        }
        setRealRoles((rolesRes.data ?? []).map((r) => r.role as AppRole));
        setMemberships((membersRes.data ?? []) as Membership[]);
        setRegions((regionsRes.data ?? []) as Region[]);
        setRegionMemberships((regionMembersRes.data ?? []).map((r) => r.region_id as string));
        const byLoc = new Map<string, string[]>();
        for (const lr of locRegionsRes.data ?? []) {
          const arr = byLoc.get(lr.location_id) ?? [];
          arr.push(lr.region_id);
          byLoc.set(lr.location_id, arr);
        }
        setAllLocations(
          (locsRes.data ?? []).map((l) => ({
            ...l,
            region_ids: byLoc.get(l.id) ?? (l.region_id ? [l.region_id] : []),
          })) as Location[],
        );
        setFullName(profileRes.data?.full_name ?? null);
        setApprovalStatus(profile.approval_status);
        setRejectedReason(profileRes.data?.rejected_reason ?? null);
        // Read separately from the profile above: the column ships in a migration
        // that is written but not applied, and one unknown column would fail the
        // whole profile read — approval status included. A missing column simply
        // means no primary yet.
        const primaryRes = await supabase
          .from("profiles")
          .select("primary_location_id")
          .eq("user_id", uid)
          .maybeSingle();
        if (!current()) return;
        setPrimaryLocationId(
          primaryRes.error ? null : (primaryRes.data?.primary_location_id ?? null),
        );
        await refreshImpersonation();
      } catch {
        if (current()) {
          clearIdentity();
          setApprovalStatus("rejected");
          setRejectedReason("Account access could not be verified. Please try signing in again.");
        }
      } finally {
        if (current()) setLoading(false);
      }
    },
    [clearIdentity, refreshImpersonation, queryClient, router],
  );

  useEffect(() => {
    void load();
    let pendingLoad: ReturnType<typeof setTimeout> | undefined;
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      // The document file route is fetched by the browser itself, which will not
      // attach the bearer header serverFns get. Mirroring the token here covers
      // sign-in, every refresh, and sign-out (which clears it).
      syncDocumentSessionCookie(session);
      // Sign-ins are the one auth event nothing else records; once per session.
      if ((event === "SIGNED_IN" || event === "INITIAL_SESSION") && session?.user)
        logSignInOnce(session.user.id);

      /*
       * A TOKEN REFRESH IS NOT A CHANGE OF IDENTITY.
       *
       * David, 17 Sep: he switches to a spreadsheet in another tab, comes back,
       * and the app has thrown away where he was. "Even if I go to another
       * tab... I'm coming back, it's gone."
       *
       * This was the mechanism. Supabase fires TOKEN_REFRESHED when a
       * backgrounded tab comes forward and the access token is due, and every
       * auth event ran the full sign-in teardown: clearIdentity() emptied the
       * context and setLoading(true) put the whole authenticated tree behind a
       * loading shell. Everything below it unmounted — which page of a list he
       * was on, how far he had scrolled, which record he had open — and came
       * back fresh. Nothing about who he was had changed.
       *
       * transitionIdentityCaches already knew this: it returns early when the
       * user id is unchanged. The teardown above it did not.
       *
       * So the teardown now runs only when the SIGNED-IN USER actually differs.
       * A refresh still syncs the document cookie above and still reloads the
       * profile below; it just does it underneath him instead of in front of
       * him.
       *
       * ---
       *
       * Mark, 5 Oct, on the New job form: "when they switch tabs, it doesnt
       * keep things in the fields." Same mechanism, still live, because the
       * guard above only covered the teardown written HERE. The `load()`
       * scheduled at the bottom opened with its own `setLoading(true)` and
       * `clearIdentity()`, so every path still went through the loading shell.
       *
       * And it is not only a due token. Measured against @supabase/auth-js
       * 2.112.4 with a session 60 minutes from expiry and the network stubbed
       * to throw: every hidden -> visible transition emits SIGNED_IN, because
       * `_recoverAndRefresh()` ends in an unconditional
       * `_notifyAllSubscribers('SIGNED_IN', currentSession)` for any valid
       * session it did not have to refresh. So this ran on EVERY tab switch,
       * not on the hour. Measured end to end against this provider:
       * `loading` committed true for four renders, PageAccessGate swapped the
       * outlet for "Loading…", and a child's useState came back empty.
       *
       * Hence `{ quiet: true }`: refresh the identity underneath him.
       */
      const nextUserId = session?.user?.id ?? null;
      if (event === "SIGNED_OUT") clearViewAsSession();
      const identityChanged = nextUserId !== lastUserId.current;
      lastUserId.current = nextUserId;

      ++generation.current;
      const resetVersion = generation.current;
      if (identityChanged) {
        clearIdentity();
        setLoading(!!session?.user);
      }
      const reset = transitionIdentityCaches(queryClient, router, session?.user?.id ?? null);
      void reset.catch(() => {
        if (generation.current !== resetVersion) return;
        setApprovalStatus("rejected");
        setRejectedReason("Account data could not be reset safely. Please reload the app.");
      });
      if (pendingLoad) clearTimeout(pendingLoad);
      if (session?.user)
        pendingLoad = setTimeout(() => {
          void load({ quiet: !identityChanged });
        }, 0);
    });
    return () => {
      ++generation.current;
      if (pendingLoad) clearTimeout(pendingLoad);
      sub.subscription.unsubscribe();
    };
  }, [load, clearIdentity, queryClient, router]);

  const value = useMemo<AppCtx>(() => {
    const realPrivileged = isPrivileged(realRoles);
    const realMemberSet = new Set(memberships.map((m) => m.location_id));
    const realRegionMemberSet = new Set(regionMemberships);

    // Locations the REAL user can see. Direct memberships UNION every location
    // in their regions — regions only ever add. No region memberships means no
    // extra locations, never "no locations", and no role is required for a
    // region membership to count.
    const realVisible = realPrivileged
      ? allLocations
      : allLocations.filter(
          (l) =>
            realMemberSet.has(l.id) || l.region_ids.some((rid) => realRegionMemberSet.has(rid)),
        );

    // Effective identity — real, or narrowed via impersonation.
    let effectiveRoles: AppRole[] = realRoles;
    let effectiveVisible = realVisible;
    let effectiveMemberships = memberships;
    let effectiveRegionMemberships = regionMemberships;
    let effectivePrimaryLocationId = primaryLocationId;
    let viewingAsPerson: ViewAsPerson | null = null;

    if (impersonation) {
      if (impersonation.target_scope) {
        const t = impersonation.target_scope;
        // Effective roles = target's roles (never widen).
        effectiveRoles = (t.roles ?? []) as AppRole[];
        // Effective locations = intersect target's locations with what the
        // real user can already see. This is the safety property: View As
        // can only ever subtract.
        const targetLocIds = new Set(t.location_ids ?? []);
        const targetRegionIds = new Set(t.region_ids ?? []);
        effectiveVisible = realVisible.filter(
          (l) => targetLocIds.has(l.id) || l.region_ids.some((rid) => targetRegionIds.has(rid)),
        );
        // If target has no explicit locations but has a broad role, keep
        // realVisible (they'd see everything the actor sees anyway,
        // bounded by the actor).
        if (effectiveVisible.length === 0 && isPrivileged(effectiveRoles)) {
          effectiveVisible = realVisible;
        }
        // "View as person": their offices and their own office too, so every
        // default and every office-scoped list is theirs. Bounded by what the
        // actor can see, like the locations above.
        const visibleIds = new Set(effectiveVisible.map((l) => l.id));
        const detailed = viewAsDetail?.memberships.length
          ? viewAsDetail.memberships
          : (t.location_ids ?? []).map((id) => ({ location_id: id, role: "member" }));
        effectiveMemberships = detailed.filter((m) => visibleIds.has(m.location_id));
        effectiveRegionMemberships = [...(t.region_ids ?? [])];
        const primary = viewAsDetail?.primaryLocationId ?? null;
        effectivePrimaryLocationId = primary && visibleIds.has(primary) ? primary : null;
        viewingAsPerson = {
          userId: t.user_id,
          name: t.full_name?.trim() || t.email || "this person",
          roles: sortRoles(effectiveRoles),
          officeName: officeLabel(
            effectivePrimaryLocationId,
            effectiveMemberships.map((m) => m.location_id),
            allLocations,
          ),
        };
      } else if (impersonation.preview_role) {
        // Role-preview: adopt the previewed role, but only if the actor is
        // already privileged (owner/admin/dev). For anyone else the preview
        // can only ever be the intersection with what they really hold, so
        // previewing a broader role grants nothing.
        effectiveRoles = realPrivileged
          ? [impersonation.preview_role]
          : realRoles.filter((r) => r === impersonation.preview_role);
        // Location scope stays bounded by what the actor already sees.
        effectiveVisible = realVisible;
      }
    }

    return {
      loading,
      userId,
      viewerUserId: viewingAsPerson ? viewingAsPerson.userId : userId,
      viewingAsPerson,
      email,
      fullName,
      approvalStatus,
      rejectedReason,
      realRoles,
      roles: effectiveRoles,
      primary: primaryRole(effectiveRoles),
      memberships: effectiveMemberships,
      primaryLocationId: effectivePrimaryLocationId,
      regions,
      regionMemberships: effectiveRegionMemberships,
      visibleLocations: effectiveVisible,
      allLocations,
      currentLocationId,
      setCurrentLocationId,
      impersonation,
      isImpersonating: !!impersonation,
      writesDisabled: !!impersonation,
      writesDisabledReason: viewingAsPerson
        ? viewAsReadOnlyReason(viewingAsPerson.name)
        : impersonation
          ? "Writes are disabled while View As is active. Exit impersonation to make changes."
          : null,
      refreshImpersonation,
      refresh: load,
    };
  }, [
    loading,
    userId,
    email,
    fullName,
    approvalStatus,
    rejectedReason,
    realRoles,
    memberships,
    primaryLocationId,
    regions,
    regionMemberships,
    allLocations,
    currentLocationId,
    impersonation,
    viewAsDetail,
    load,
    refreshImpersonation,
  ]);

  // The net under every write button that does not know about View As: while
  // a person view is on, the query client refuses to start a mutation
  // (router.tsx → guardMutationWhileViewingAs).
  const readOnlyReason = value.viewingAsPerson ? value.writesDisabledReason : null;
  useEffect(() => {
    setViewAsReadOnly(readOnlyReason);
    return () => setViewAsReadOnly(null);
  }, [readOnlyReason]);

  // A stored office context that the user cannot (or can no longer) see would
  // silently narrow every page to one location. Reset it to "All" instead.
  useEffect(() => {
    if (loading || !currentLocationId || value.allLocations.length === 0) return;
    if (!value.visibleLocations.some((l) => l.id === currentLocationId)) {
      setCurrentLocationId(null);
    }
  }, [loading, currentLocationId, value.allLocations, value.visibleLocations]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** The app context where there may be none (a component also used on public pages). */
export function useOptionalAppContext(): AppCtx | null {
  return useContext(Ctx);
}

export function useAppContext(): AppCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAppContext outside provider");
  return v;
}

/**
 * Small ergonomic wrapper: returns [disabled, reason]. Wrap around any
 * button that mutates data so the UI never lets an impersonating actor
 * write on behalf of someone else.
 */
export function useWritesDisabled(): {
  disabled: boolean;
  reason: string | null;
} {
  const { writesDisabled, writesDisabledReason } = useAppContext();
  return { disabled: writesDisabled, reason: writesDisabledReason };
}

/**
 * View as person: the office ids a list's "All" should be narrowed to, or
 * null for "do not narrow". Stable between renders while the answer is the
 * same, so it can sit in effect and query dependencies. See view-as.ts.
 */
export function usePreviewOfficeScope(): string[] | null {
  const { viewingAsPerson, roles, visibleLocations } = useAppContext();
  const answer = previewOfficeScope({
    viewingAsPerson,
    roles,
    visibleLocationIds: visibleLocations.map((l) => l.id),
  });
  const key = answer === null ? "" : `ids:${answer.join(",")}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => answer, [key]);
}
