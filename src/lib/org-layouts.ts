import { supabase } from "@/integrations/supabase/client";

/**
 * Organisation default layouts.
 *
 * An admin arranges a dashboard, the sidebar or a record page's sections and
 * publishes it as the org default, optionally for one role. Personal layouts
 * always win: a published default only applies to people who never customised.
 * "Reset everyone to this layout" is the explicit escape hatch — it clears
 * personal overrides through a security-definer function that checks the
 * caller is an admin, and logs the action.
 */

export type LayoutScope = "dashboard" | "sidebar" | "sections";

/** role_key value meaning "applies to every role". */
export const ALL_ROLES = "all";

export type OrgDefault<T> = {
  scope: LayoutScope;
  roleKey: string;
  payload: T;
  publishedBy: string | null;
  publishedAt: string;
};

/** True for admins/owners — the only people who may publish a default. */
export function canPublishLayouts(roles: readonly string[]): boolean {
  return roles.includes("admin") || roles.includes("owner");
}

/**
 * Best-matching published default: an exact role match first (in the order the
 * caller's roles are given), then the "all roles" default.
 */
export async function loadOrgDefault<T>(
  scope: LayoutScope,
  roleKeys: readonly string[],
): Promise<OrgDefault<T> | null> {
  const { data, error } = await supabase
    .from("layout_defaults")
    .select("scope,role_key,payload,published_by,published_at")
    .eq("scope", scope);
  if (error || !data || data.length === 0) return null;

  const pick =
    roleKeys.map((r) => data.find((d) => d.role_key === r)).find(Boolean) ??
    data.find((d) => d.role_key === ALL_ROLES);
  if (!pick) return null;

  return {
    scope,
    roleKey: pick.role_key,
    payload: pick.payload as T,
    publishedBy: pick.published_by,
    publishedAt: pick.published_at,
  };
}

export async function publishOrgDefault(
  scope: LayoutScope,
  roleKey: string,
  payload: unknown,
  actorId: string,
): Promise<void> {
  const { error } = await supabase.from("layout_defaults").upsert(
    {
      scope,
      role_key: roleKey,
      payload: payload as never,
      published_by: actorId,
      published_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "scope,role_key" },
  );
  if (error) throw error;

  await supabase.from("layout_default_events").insert({
    scope,
    role_key: roleKey,
    action: "publish",
    actor_id: actorId,
    payload: payload as never,
  });
}

/** How many people currently hold a personal override for this scope/role. */
export async function countLayoutOverrides(scope: LayoutScope, roleKey: string): Promise<number> {
  const { data, error } = await supabase.rpc("count_layout_overrides", {
    _scope: scope,
    _role_key: roleKey,
  });
  if (error) throw error;
  return (data as number) ?? 0;
}

/** Clears personal overrides so the published default applies to everyone. */
export async function resetLayoutOverrides(scope: LayoutScope, roleKey: string): Promise<number> {
  const { data, error } = await supabase.rpc("reset_layout_overrides", {
    _scope: scope,
    _role_key: roleKey,
  });
  if (error) throw error;
  return (data as number) ?? 0;
}

export type LayoutEvent = {
  id: string;
  scope: string;
  role_key: string;
  action: string;
  affected_users: number | null;
  created_at: string;
  actor_name: string | null;
};

/** Publish/reset history, newest first. */
export async function loadLayoutEvents(limit = 8): Promise<LayoutEvent[]> {
  const { data } = await supabase
    .from("layout_default_events")
    .select("id,scope,role_key,action,affected_users,created_at,actor_id")
    .order("created_at", { ascending: false })
    .limit(limit);
  const rows = data ?? [];
  const ids = [...new Set(rows.map((r) => r.actor_id).filter(Boolean))] as string[];
  const names = new Map<string, string>();
  if (ids.length > 0) {
    const { data: profs } = await supabase
      .from("profiles")
      .select("user_id,full_name")
      .in("user_id", ids);
    for (const p of profs ?? []) names.set(p.user_id, p.full_name ?? "");
  }
  return rows.map((r) => ({
    id: r.id,
    scope: r.scope,
    role_key: r.role_key,
    action: r.action,
    affected_users: r.affected_users,
    created_at: r.created_at,
    actor_name: r.actor_id ? names.get(r.actor_id) || null : null,
  }));
}
