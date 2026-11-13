import { supabase } from "@/integrations/supabase/client";
import { isMissingSchema } from "@/lib/schema-fallback";
import {
  ACCESS_PAGE_ID,
  PAGES,
  PAGE_KEY_PREFIX,
  isPagePermissionKey,
  pagePermissionKey,
} from "@/lib/page-access";
import type { AppRole } from "@/lib/roles";
import type { AuditRow } from "@/lib/access-history";

/**
 * Reads and writes for the Access screen. Everything here goes through the
 * tables the capability model already uses — there is no page-specific table —
 * so an administrator editing page access and an administrator editing a
 * capability are doing the same kind of write.
 *
 * Every read degrades: the page catalogue rows arrive in a migration that is
 * written but not applied, so `seeded: false` is a normal answer and the screen
 * has to say so rather than showing an empty list or an error.
 */

export type RolePageState = {
  /** True once the `page.*` rows exist in `permissions`. */
  seeded: boolean;
  /** role -> page ids stored in role_permissions. */
  byRole: Map<AppRole, Set<string>>;
  /** role -> capability keys stored in role_permissions. */
  capabilitiesByRole: Map<AppRole, Set<string>>;
  /** Page ids present in the catalogue. Empty when not seeded. */
  known: Set<string>;
  /**
   * Personal overrides on `page.admin-access` only — user id -> grant/revoke.
   *
   * The lockout check has to know about them: a single personal grant is
   * enough to keep somebody in, and a personal revoke takes an otherwise
   * qualified administrator out. Expired rows are dropped, because an expired
   * override is not access.
   */
  accessPageOverrides: Map<string, "grant" | "revoke">;
};

const EMPTY_STATE: RolePageState = {
  seeded: false,
  byRole: new Map(),
  capabilitiesByRole: new Map(),
  known: new Set(),
  accessPageOverrides: new Map(),
};

/**
 * One read for the whole role view. Returns `seeded: false` — never throws —
 * when the catalogue rows are not there yet, which is what makes the screen
 * usable before the migration is applied.
 */
export async function fetchRolePageState(): Promise<RolePageState> {
  const cat = await supabase.from("permissions").select("key").like("key", `${PAGE_KEY_PREFIX}%`);
  if (cat.error) {
    if (isMissingSchema(cat.error)) return EMPTY_STATE;
    throw cat.error;
  }

  const known = new Set(
    (cat.data ?? [])
      .map((r) => r.key)
      .filter(isPagePermissionKey)
      .map((k) => k.slice(PAGE_KEY_PREFIX.length)),
  );

  const rows = await supabase.from("role_permissions").select("role,permission_key");
  if (rows.error) {
    if (isMissingSchema(rows.error)) return { ...EMPTY_STATE, seeded: known.size > 0, known };
    throw rows.error;
  }

  const accessPageOverrides = await fetchAccessPageOverrides();

  const byRole = new Map<AppRole, Set<string>>();
  const capabilitiesByRole = new Map<AppRole, Set<string>>();
  for (const r of rows.data ?? []) {
    const role = r.role as AppRole;
    if (isPagePermissionKey(r.permission_key)) {
      const id = r.permission_key.slice(PAGE_KEY_PREFIX.length);
      const set = byRole.get(role) ?? new Set<string>();
      set.add(id);
      byRole.set(role, set);
    } else {
      const set = capabilitiesByRole.get(role) ?? new Set<string>();
      set.add(r.permission_key);
      capabilitiesByRole.set(role, set);
    }
  }

  return { seeded: known.size > 0, byRole, capabilitiesByRole, known, accessPageOverrides };
}

/**
 * Personal grants and revokes on the Access page itself.
 *
 * Read on its own and degraded to "none" rather than thrown: a missing table or
 * a refused read must not stop the role screen loading. The consequence of the
 * empty answer is a confirm step that is slightly keener than it needs to be,
 * which is the right way round.
 */
async function fetchAccessPageOverrides(): Promise<Map<string, "grant" | "revoke">> {
  const key = pagePermissionKey(ACCESS_PAGE_ID);
  const { data, error } = await supabase
    .from("user_permissions")
    .select("user_id,effect,expires_at")
    .eq("permission_key", key);
  const out = new Map<string, "grant" | "revoke">();
  if (error || !data) return out;
  const now = Date.now();
  for (const r of data) {
    if (r.expires_at && new Date(r.expires_at).getTime() <= now) continue;
    // A revoke always wins, exactly as the database resolves it.
    if (r.effect === "revoke") out.set(r.user_id, "revoke");
    else if (r.effect === "grant" && out.get(r.user_id) !== "revoke") out.set(r.user_id, "grant");
  }
  return out;
}

/** Grant or clear one page for one role. */
export async function setRolePageAccess(role: AppRole, pageId: string, on: boolean) {
  const key = pagePermissionKey(pageId);
  if (on) {
    const { error } = await supabase.from("role_permissions").insert({ role, permission_key: key });
    // Unique violation just means someone else ticked it first.
    if (error && error.code !== "23505") throw asFriendly(error);
    return;
  }
  const { error } = await supabase
    .from("role_permissions")
    .delete()
    .eq("role", role)
    .eq("permission_key", key);
  if (error) throw asFriendly(error);
}

/**
 * Apply one decision to a whole area at once. The role view's "allow all" and
 * "clear" buttons — the reason an admin does not tick forty boxes by hand.
 */
export async function setRoleAreaAccess(role: AppRole, pageIds: readonly string[], on: boolean) {
  const keys = pageIds.map(pagePermissionKey);
  if (keys.length === 0) return;
  if (on) {
    const { error } = await supabase.from("role_permissions").upsert(
      keys.map((permission_key) => ({ role, permission_key })),
      { onConflict: "role,permission_key", ignoreDuplicates: true },
    );
    if (error) throw asFriendly(error);
    return;
  }
  const { error } = await supabase
    .from("role_permissions")
    .delete()
    .eq("role", role)
    .in("permission_key", keys);
  if (error) throw asFriendly(error);
}

/**
 * A foreign-key failure here means one thing and only one thing: the seed
 * migration has not been applied, so there is no `page.<id>` row to point at.
 * Saying that is far more use than "violates foreign key constraint".
 */
function asFriendly(error: { code?: string; message?: string }): Error {
  if (error.code === "23503") {
    return new Error(
      "Page rules are not enabled on this database yet. Apply the pending " +
        "page-access migration, then try again.",
    );
  }
  return new Error(error.message ?? "Could not save");
}

/** Pages grouped by area, in catalogue order — what both views render. */
export function pagesByArea() {
  const out = new Map<string, (typeof PAGES)[number][]>();
  for (const p of PAGES) {
    const arr = out.get(p.area) ?? [];
    arr.push(p);
    out.set(p.area, arr);
  }
  return out;
}

// ----------------------------------------------------------------- history

export type AccessHistoryFilter =
  | { kind: "role"; role: AppRole }
  | { kind: "person"; userId: string; entities?: readonly string[] };

/** Query key prefix. Any write that touches access invalidates it. */
export const ACCESS_HISTORY_KEY = "access-history";

export function accessHistoryKey(filter: AccessHistoryFilter) {
  return filter.kind === "role"
    ? [ACCESS_HISTORY_KEY, "role", filter.role]
    : [ACCESS_HISTORY_KEY, "person", filter.userId, ...(filter.entities ?? [])];
}

export type AccessHistory = {
  /** True when the audit table cannot be read yet — say so, never throw. */
  unavailable: boolean;
  rows: AuditRow[];
  /** actor_id -> display name, for "by Mark". */
  actors: Record<string, string>;
};

/**
 * Who changed what, and when, for one role or one person.
 *
 * Nothing new is written for this: every change made on the Access screen or
 * the user page is an ordinary row in `role_permissions`, `user_permissions`
 * or `user_roles`, and each of those tables already has a SECURITY DEFINER
 * trigger that copies the before/after row into `role_change_audit`. Reading
 * that table is the whole feature. Only Owner/Admin/Dev can read it (RLS), and
 * they are the only ones who reach the screens that show it.
 */
export async function fetchAccessHistory(filter: AccessHistoryFilter): Promise<AccessHistory> {
  let q = supabase
    .from("role_change_audit")
    .select("id,action,entity,actor_id,target_user_id,old_value,new_value,occurred_at")
    .order("occurred_at", { ascending: false })
    .limit(40);

  if (filter.kind === "role") {
    // Role rules carry no target user; the role sits inside the stored row.
    q = q
      .eq("entity", "role_permissions")
      .or(`new_value->>role.eq.${filter.role},old_value->>role.eq.${filter.role}`);
  } else {
    q = q.eq("target_user_id", filter.userId);
    if (filter.entities && filter.entities.length > 0) q = q.in("entity", [...filter.entities]);
  }

  const { data, error } = await q;
  if (error) {
    if (isMissingSchema(error)) return { unavailable: true, rows: [], actors: {} };
    throw error;
  }
  const rows = (data ?? []) as AuditRow[];

  const ids = [...new Set(rows.map((r) => r.actor_id).filter((x): x is string => !!x))];
  let actors: Record<string, string> = {};
  if (ids.length > 0) {
    const names = await supabase.from("profiles").select("user_id, full_name").in("user_id", ids);
    // A missing name is "an admin", not a failed history.
    if (!names.error) {
      actors = Object.fromEntries(
        (names.data ?? []).map((p) => [p.user_id, p.full_name ?? "an admin"]),
      );
    }
  }
  return { unavailable: false, rows, actors };
}
