import { supabase } from "@/integrations/supabase/client";
import { isPrivileged, primaryRole, ROLE_LABELS, ROLE_PRIORITY, type AppRole } from "@/lib/roles";

/*
 * "View as person" — Mark, 11 Oct: "I also want to be able to view as
 * specific people."
 *
 * The mechanism underneath is the View As that already existed on the Users
 * page: `start_impersonation(target)` opens a row in `impersonation_audit`
 * (who, whom, when — and `end_impersonation` stamps when it stopped), and
 * `get_active_impersonation()` hands back the person's roles and offices.
 * Those rows are already in the Activity log as "View As" sessions, so the
 * audit needs nothing new.
 *
 * What it is NOT is a sign-in. Nobody mints a token for the other person; the
 * database session stays the admin's, and every row is still fetched through
 * the ADMIN's RLS. So the preview is the person's experience as far as the UI
 * decides it — roles, page access, offices, and every "my …" scope that keys
 * off who you are — and an approximation of what RLS would have refused them.
 * VIEW_AS_CAVEAT says exactly that, in the banner's tooltip.
 *
 * This module holds the pieces that are not React: the session rule, the
 * write guard, the picker's list, and the banner's words.
 */

export type Membership = { location_id: string; role: string };

/** What the person-view needs beyond `get_active_impersonation()`'s scope. */
export type ViewAsDetail = {
  /** location_members WITH the per-office role, which the scope leaves out. */
  memberships: Membership[];
  /** The person's own office — what their forms and reports default to. */
  primaryLocationId: string | null;
};

/** Who is being viewed as, as the banner and the tooltips name them. */
export type ViewAsPerson = {
  userId: string;
  name: string;
  roles: AppRole[];
  officeName: string | null;
};

export const VIEW_AS_CAVEAT =
  "Preview only — you are still signed in as yourself. Pages, roles, offices and every " +
  '"my" list follow this person, but rows are fetched with your own access, so data ' +
  "they could not read may still appear where a page does not already filter by person " +
  "or office. Nothing can be changed while viewing as someone.";

/** The tooltip on every disabled write while viewing as someone. */
export function viewAsReadOnlyReason(name: string): string {
  return `Viewing as ${name} — switch back to make changes`;
}

/** A role preview or a person view older than a working day is ended, not resumed. */
export const VIEW_AS_MAX_AGE_MS = 8 * 60 * 60 * 1000;

export function viewAsExpired(startedAt: string | null | undefined, now = Date.now()): boolean {
  if (!startedAt) return false;
  const started = new Date(startedAt).getTime();
  return Number.isFinite(started) && now - started > VIEW_AS_MAX_AGE_MS;
}

/* -------------------------------------------------------------------------- */
/* One sign-in session, no further                                            */
/* -------------------------------------------------------------------------- */

/*
 * The open row lives in the database, keyed to the admin, so on its own it
 * would follow them into tomorrow's sign-in. Mark's rule is that a person view
 * ends with the session that started it. Supabase stamps every access token
 * with the auth session's id (`session_id`); we note which session started the
 * view, and a view found under a different session — or with no note at all —
 * is ended on load. localStorage rather than sessionStorage so a second tab of
 * the SAME sign-in agrees with the first; the note is two ids and nothing
 * else, and sign-out removes it.
 */
const SESSION_KEY = "rh:view-as-session";

export function jwtSessionId(token: string | null | undefined): string | null {
  if (!token) return null;
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const claims = JSON.parse(atob(padded)) as { session_id?: unknown };
    return typeof claims.session_id === "string" ? claims.session_id : null;
  } catch {
    return null;
  }
}

export async function currentAuthSessionId(): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getSession();
    return jwtSessionId(data.session?.access_token ?? null);
  } catch {
    return null;
  }
}

export function rememberViewAsSession(impersonationId: string, sessionId: string | null) {
  if (!sessionId) return;
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ impersonationId, sessionId }));
  } catch {
    /* private mode: the 8-hour cap still ends it */
  }
}

export function clearViewAsSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* noop */
  }
}

/**
 * true = started in this sign-in; false = started in another one (or never
 * noted), so it must be ended; "unknown" = this browser cannot tell (no token
 * claim, storage blocked) — kept, and the 8-hour cap is the backstop.
 */
export function viewAsBelongsToSession(
  impersonationId: string,
  sessionId: string | null,
): boolean | "unknown" {
  if (!sessionId) return "unknown";
  let raw: string | null;
  try {
    raw = localStorage.getItem(SESSION_KEY);
  } catch {
    return "unknown";
  }
  if (!raw) return false;
  try {
    const note = JSON.parse(raw) as { impersonationId?: string; sessionId?: string };
    return note.impersonationId === impersonationId && note.sessionId === sessionId;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Read-only, everywhere                                                      */
/* -------------------------------------------------------------------------- */

/*
 * `writesDisabled` greys out the buttons that know about it (600-odd of
 * them). This is the net under the ones that do not: while a person view is
 * on, the query client refuses to START any mutation (router.tsx), with the
 * same sentence as the tooltip. Only the two actions that are about the view
 * itself — switching person and switching back — carry `VIEW_AS_ALLOWED_META`.
 *
 * It is set by the app context, never by a component.
 */
let readOnlyReason: string | null = null;

export function setViewAsReadOnly(reason: string | null) {
  readOnlyReason = reason;
}

export function currentViewAsReadOnlyReason(): string | null {
  return readOnlyReason;
}

export class ViewAsReadOnlyError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ViewAsReadOnlyError";
  }
}

export const VIEW_AS_ALLOWED_META = { viewAsAllowed: true } as const;

/** The MutationCache's onMutate: throws before mutationFn can run. */
export function guardMutationWhileViewingAs(meta: Record<string, unknown> | undefined) {
  const reason = readOnlyReason;
  if (!reason) return;
  if (meta?.viewAsAllowed === true) return;
  throw new ViewAsReadOnlyError(reason);
}

/* -------------------------------------------------------------------------- */
/* Whose detail, and how the banner names them                                */
/* -------------------------------------------------------------------------- */

/**
 * The person's office memberships with their per-office role, and their own
 * office. Read through the admin's RLS (privileged callers read every row of
 * location_members and profiles); a failed read is an empty answer, so the
 * preview falls back to the scope's office list rather than breaking.
 */
export async function fetchViewAsDetail(targetUserId: string): Promise<ViewAsDetail> {
  const [members, profile] = await Promise.all([
    supabase.from("location_members").select("location_id, role").eq("user_id", targetUserId),
    supabase
      .from("profiles")
      .select("primary_location_id")
      .eq("user_id", targetUserId)
      .maybeSingle(),
  ]);
  return {
    memberships: members.error ? [] : ((members.data ?? []) as Membership[]),
    primaryLocationId: profile.error ? null : (profile.data?.primary_location_id ?? null),
  };
}

type NamedLocation = { id: string; code: string; name: string };

/** Their own office if set; else their only office; else "N offices"; else null. */
export function officeLabel(
  primaryLocationId: string | null,
  locationIds: readonly string[],
  locations: readonly NamedLocation[],
): string | null {
  const byId = new Map(locations.map((l) => [l.id, l]));
  const primary = primaryLocationId ? byId.get(primaryLocationId) : undefined;
  if (primary) return primary.name;
  const known = [...new Set(locationIds)].map((id) => byId.get(id)).filter(Boolean);
  if (known.length === 1) return known[0]!.name;
  if (known.length > 1) return `${known.length} offices`;
  return null;
}

export function sortRoles(roles: readonly AppRole[]): AppRole[] {
  return [...new Set(roles)].sort((a, b) => ROLE_PRIORITY.indexOf(a) - ROLE_PRIORITY.indexOf(b));
}

export function roleListLabel(roles: readonly AppRole[]): string {
  const sorted = sortRoles(roles);
  return sorted.length ? sorted.map((r) => ROLE_LABELS[r] ?? r).join(", ") : "no roles";
}

/** "Viewing as Dana Ruiz (Sales Person, Newark) — Read only" */
export function viewAsBannerText(person: ViewAsPerson): string {
  const bits = [roleListLabel(person.roles), person.officeName].filter(Boolean).join(", ");
  return `Viewing as ${person.name} (${bits}) — Read only`;
}

/* -------------------------------------------------------------------------- */
/* The picker's list                                                          */
/* -------------------------------------------------------------------------- */

export type PickablePerson = {
  userId: string;
  name: string;
  roles: AppRole[];
  primaryRole: AppRole | null;
  officeName: string | null;
  /** One lowercase string the search box matches against. */
  haystack: string;
};

type ProfileRow = {
  user_id: string;
  full_name: string | null;
  is_active: boolean | null;
  approval_status: string | null;
  primary_location_id?: string | null;
};

/**
 * Active, approved staff — the same two flags the app checks before it lets
 * anyone in (app-context's identity read) — minus yourself, since
 * start_impersonation refuses a view of yourself. A profile with no name is a
 * half-finished account, not a person you would pick, so it is left out too.
 */
export function pickablePeople(input: {
  profiles: readonly ProfileRow[];
  roles: readonly { user_id: string; role: string }[];
  memberships: readonly { user_id: string; location_id: string }[];
  locations: readonly NamedLocation[];
  selfId: string | null;
}): PickablePerson[] {
  const rolesBy = new Map<string, AppRole[]>();
  for (const r of input.roles) {
    const list = rolesBy.get(r.user_id) ?? [];
    list.push(r.role as AppRole);
    rolesBy.set(r.user_id, list);
  }
  const officesBy = new Map<string, string[]>();
  for (const m of input.memberships) {
    const list = officesBy.get(m.user_id) ?? [];
    list.push(m.location_id);
    officesBy.set(m.user_id, list);
  }
  return input.profiles
    .filter(
      (p) =>
        p.is_active === true &&
        p.approval_status === "approved" &&
        p.user_id !== input.selfId &&
        !!p.full_name?.trim(),
    )
    .map((p) => {
      const roles = sortRoles(rolesBy.get(p.user_id) ?? []);
      const officeName = officeLabel(
        p.primary_location_id ?? null,
        officesBy.get(p.user_id) ?? [],
        input.locations,
      );
      const name = p.full_name!.trim();
      return {
        userId: p.user_id,
        name,
        roles,
        primaryRole: primaryRole(roles),
        officeName,
        haystack: [name, roleListLabel(roles), officeName ?? ""].join(" ").toLowerCase(),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

export async function fetchPickablePeople(
  selfId: string | null,
  locations: readonly NamedLocation[],
): Promise<PickablePerson[]> {
  const [profiles, roles, memberships] = await Promise.all([
    supabase
      .from("profiles")
      .select("user_id, full_name, is_active, approval_status, primary_location_id")
      .eq("is_active", true)
      .eq("approval_status", "approved"),
    supabase.from("user_roles").select("user_id, role"),
    supabase.from("location_members").select("user_id, location_id"),
  ]);
  if (profiles.error) throw profiles.error;
  if (roles.error) throw roles.error;
  if (memberships.error) throw memberships.error;
  return pickablePeople({
    profiles: (profiles.data ?? []) as ProfileRow[],
    roles: roles.data ?? [],
    memberships: memberships.data ?? [],
    locations,
    selfId,
  });
}

/** Every word must appear somewhere in name / roles / office. */
export function searchPeople(people: readonly PickablePerson[], query: string): PickablePerson[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...people];
  return people.filter((p) => words.every((w) => p.haystack.includes(w)));
}

/**
 * The offices a list's "All my locations" should mean while viewing as a
 * person: theirs. For anyone who is not privileged that is what RLS would
 * have done for them; under View As the rows come through the admin's RLS,
 * so the list narrows itself. null = do not narrow (no person view, or the
 * person sees every office anyway). An empty array is a real answer: a
 * person with no office sees no office-scoped rows.
 */
export function previewOfficeScope(input: {
  viewingAsPerson: ViewAsPerson | null;
  roles: readonly AppRole[];
  visibleLocationIds: readonly string[];
}): string[] | null {
  if (!input.viewingAsPerson) return null;
  if (isPrivileged([...input.roles])) return null;
  return [...input.visibleLocationIds].sort();
}
