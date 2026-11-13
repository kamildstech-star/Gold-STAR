import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAppContext } from "@/components/app-context";
import { isPrivileged, primaryRole, type AppRole } from "@/lib/roles";
import { isBreakGlass } from "@/lib/page-access";

/**
 * Capabilities sit on top of roles. A role grants a default set; a person can
 * be granted or revoked an individual capability, optionally scoped to a
 * location or region and optionally with an expiry.
 *
 * Effective = role defaults + explicit grants − explicit revokes, computed by
 * `has_permission()` in the database. The UI mirrors it via
 * `effective_permissions()` so the same answer drives both.
 */

export type PermissionKey =
  | "fleet.view"
  | "fleet.manage"
  | "job.view_costs"
  /** Billed and paid only — no cost, rates or margin (T11: what a seller sees). */
  | "job.view_billing"
  | "job.view_margin"
  | "labour_rates.view"
  | "commission.view"
  | "data.export"
  | "expenses.approve"
  | "users.manage"
  | "compliance.manage"
  | "automation.manage"
  | "reports.view_all_locations"
  | "chase.view_tracking"
  | "ai.assistant"
  | "director.view"
  | "sales_director.view"
  | "rep_cost.view"
  | "affiliates.manage";

export type PermissionRow = {
  key: string;
  label: string;
  perm_group: string;
  description: string | null;
  sort_order: number;
};

export type EffectivePermission = {
  permission_key: string;
  label: string;
  perm_group: string;
  allowed: boolean;
  /** "role" | "granted" | "revoked" | "none" */
  source: string;
  source_role: AppRole | null;
  location_id: string | null;
  region_id: string | null;
  expires_at: string | null;
  granted_by: string | null;
  reason: string | null;
  override_id: string | null;
};

export async function fetchPermissionCatalogue(): Promise<PermissionRow[]> {
  const { data, error } = await supabase
    .from("permissions")
    .select("key,label,perm_group,description,sort_order")
    .order("perm_group")
    .order("sort_order");
  if (error) throw error;
  return (data ?? []) as PermissionRow[];
}

export async function fetchEffectivePermissions(userId: string): Promise<EffectivePermission[]> {
  const { data, error } = await supabase.rpc("effective_permissions", {
    _user_id: userId,
  });
  if (error) throw error;
  return (data ?? []) as EffectivePermission[];
}

export async function grantPermission(input: {
  userId: string;
  key: string;
  effect: "grant" | "revoke";
  locationId?: string | null;
  regionId?: string | null;
  expiresAt?: string | null;
  reason?: string | null;
}) {
  // One override per user+permission, replaced inside one transaction by
  // `replace_user_permission` (migration 20260908010611). This used to be a
  // delete followed by an insert from the browser, and an insert that failed
  // after the delete — the break-glass trigger refusing a Block on a dev, a
  // dropped connection — silently threw the old override away. When that old
  // row was a revoke, the person got the access back and nobody was told.
  //
  // There is deliberately no `grantedBy` argument any more: the function
  // stamps `granted_by` from auth.uid(), so the audit actor is whoever is
  // actually signed in, not whatever the browser chose to send.
  //
  // Optional arguments go as `undefined`, not null: PostgREST then leaves them
  // out and the function's own DEFAULT NULL applies.
  const { error } = await supabase.rpc("replace_user_permission", {
    _user_id: input.userId,
    _key: input.key,
    _effect: input.effect,
    _location_id: input.locationId ?? undefined,
    _region_id: input.regionId ?? undefined,
    _expires_at: input.expiresAt ?? undefined,
    _reason: input.reason ?? undefined,
  });
  // Never fall back to the old delete-then-insert if the function is missing:
  // that is exactly the write this replaces. Refusing leaves every existing
  // rule as it was.
  if (error && (error.code === "PGRST202" || error.code === "42883")) {
    throw new Error(
      "Permission changes are unavailable until the atomic permission migration is applied. Existing rules were left as they were.",
    );
  }
  if (error) throw error;
}

export async function clearPermissionOverride(overrideId: string) {
  const { error } = await supabase.from("user_permissions").delete().eq("id", overrideId);
  if (error) throw error;
}

export async function fetchRolePermissions(): Promise<
  { id: string; role: AppRole; permission_key: string }[]
> {
  const { data, error } = await supabase.from("role_permissions").select("id,role,permission_key");
  if (error) throw error;
  return (data ?? []) as { id: string; role: AppRole; permission_key: string }[];
}

export async function setRolePermission(role: AppRole, key: string, on: boolean) {
  if (on) {
    const { error } = await supabase.from("role_permissions").insert({ role, permission_key: key });
    if (error) throw error;
  } else {
    const { error } = await supabase
      .from("role_permissions")
      .delete()
      .eq("role", role)
      .eq("permission_key", key);
    if (error) throw error;
  }
}

/**
 * The capability keys a role grants by default — what `effective_permissions`
 * answers for a person holding only that role and no overrides. Read straight
 * from `role_permissions`, which every signed-in user may select.
 */
export async function fetchRoleDefaultPermissionKeys(role: AppRole): Promise<string[]> {
  const { data, error } = await supabase
    .from("role_permissions")
    .select("permission_key")
    .eq("role", role);
  if (error) throw error;
  return (data ?? []).map((row) => row.permission_key as string);
}

/**
 * Re-answer the actor's catalogue rows for a View As identity.
 *
 * A key is allowed when the previewed identity holds it — and, for an actor
 * who is not owner/admin/dev, only when the actor really holds it too, so a
 * preview can never widen (the same rule app-context applies to roles). The
 * source becomes "role"/"none": the previewed identity's own overrides are
 * already folded into `viewAsAllowed`, and page access reads these rows
 * through the same precedence as the database.
 */
export function narrowPermissionsToViewAs(
  real: readonly EffectivePermission[],
  viewAsAllowed: ReadonlySet<string>,
  options: { actorPrivileged: boolean; sourceRole: AppRole | null },
): EffectivePermission[] {
  return real.map((row) => {
    const allowed =
      viewAsAllowed.has(row.permission_key) && (options.actorPrivileged || row.allowed);
    return {
      ...row,
      allowed,
      source: allowed ? "role" : "none",
      source_role: allowed ? options.sourceRole : null,
      location_id: null,
      region_id: null,
      expires_at: null,
      granted_by: null,
      reason: null,
      override_id: null,
    };
  });
}

/**
 * Effective capabilities for the signed-in user, as a Set of keys.
 *
 * Under View As this answers for the PREVIEWED identity. It used to answer
 * for the actor — `effective_permissions(actor)` — which is how an admin
 * previewing Sales Person still saw Internal Cost and Overall Profit on the
 * Job Calculator (QC, 2026-09-09): every `useCan` gate in the app, and page
 * access (which reads `rows`), took the admin's answer. A role preview now
 * reads that role's defaults from `role_permissions`; a user impersonation
 * reads `effective_permissions(target)`. Until that answer arrives nothing is
 * allowed, the same "not yet" rule as first load.
 */
export function useMyPermissions() {
  const app = useAppContext();
  const previewRole = app.impersonation?.preview_role ?? null;
  const targetUserId = previewRole ? null : (app.impersonation?.target_user_id ?? null);
  const viewingAs = Boolean(previewRole || targetUserId);
  const q = useQuery({
    queryKey: ["my-permissions", app.userId],
    enabled: !!app.userId,
    staleTime: 60_000,
    queryFn: () => fetchEffectivePermissions(app.userId!),
  });
  const viewAs = useQuery({
    queryKey: ["view-as-permissions", app.userId, previewRole, targetUserId],
    enabled: !!app.userId && viewingAs,
    staleTime: 60_000,
    queryFn: async () => {
      if (previewRole) return fetchRoleDefaultPermissionKeys(previewRole);
      const target = await fetchEffectivePermissions(targetUserId!);
      return target.filter((p) => p.allowed).map((p) => p.permission_key);
    },
  });
  // React Query keeps prior successful data when a refetch fails. A stale
  // grant must not survive an unavailable authorization response — the
  // actor's or the previewed identity's.
  const unavailable =
    app.loading ||
    !app.userId ||
    q.isError ||
    q.isPending ||
    (viewingAs && (viewAs.isError || viewAs.isPending));
  const realRows = unavailable ? [] : (q.data ?? []);
  const rows =
    viewingAs && !unavailable
      ? narrowPermissionsToViewAs(realRows, new Set(viewAs.data ?? []), {
          actorPrivileged: isPrivileged(app.realRoles ?? []),
          sourceRole: previewRole ?? primaryRole(app.impersonation?.target_scope?.roles ?? []),
        })
      : realRows;
  // The break-glass role carries every capability as well as every page, for
  // the same reason: an escape hatch that reaches a screen but cannot use it is
  // not an escape hatch. Decided from the effective identity's roles, so a
  // preview of another role does not inherit it — and a preview OF `dev` shows
  // what `dev` genuinely sees.
  const breakGlass = !unavailable && isBreakGlass(app.roles);
  const effectiveRows = breakGlass
    ? rows.map((r) => ({ ...r, allowed: true, source: "role", source_role: "dev" as AppRole }))
    : rows;
  const allowed = new Set(effectiveRows.filter((p) => p.allowed).map((p) => p.permission_key));
  return {
    loading: q.isLoading || (viewingAs && viewAs.isLoading),
    error: q.isError || (viewingAs && viewAs.isError),
    allowed,
    rows: effectiveRows,
  };
}

/**
 * Single capability check. While loading it returns false — capabilities are
 * additive, so a brief "not yet" is safe; the alternative leaks.
 */
export function useCan(key: PermissionKey): boolean {
  const { allowed } = useMyPermissions();
  return allowed.has(key);
}

export function useInvalidatePermissions() {
  const qc = useQueryClient();
  return (userId?: string | null) => {
    qc.invalidateQueries({ queryKey: ["my-permissions"] });
    if (userId) qc.invalidateQueries({ queryKey: ["user-permissions", userId] });
  };
}

export const PERMISSION_SOURCE_LABEL: Record<string, string> = {
  role: "from role",
  granted: "granted",
  revoked: "revoked",
  none: "not granted",
};
