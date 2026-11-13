import { supabase } from "@/integrations/supabase/client";
import { loadOrgDefault } from "./org-layouts";

/**
 * Personal sidebar arrangement: which order the section boxes sit in, and the
 * order of the links inside each one. Stored per user in `user_view_prefs`
 * (scope `sidebar_order`) so it follows the person between devices, the same
 * way the dashboard layout does.
 *
 * Role-gating is untouched: this only ever *orders* the groups and items the
 * role already produced. Anything saved that the user can no longer see is
 * dropped on read, and anything new appears at the end.
 */
export type SidebarOrder = {
  groups: string[];
  /** group key -> ordered nav paths */
  items: Record<string, string[]>;
};

export const EMPTY_ORDER: SidebarOrder = { groups: [], items: {} };

const SCOPE = "sidebar_order";

export async function loadSidebarOrder(userId: string): Promise<SidebarOrder> {
  const { data } = await supabase
    .from("user_view_prefs")
    .select("view_mode")
    .eq("user_id", userId)
    .eq("scope", SCOPE)
    .maybeSingle();
  if (!data?.view_mode) return EMPTY_ORDER;
  try {
    const parsed = JSON.parse(data.view_mode) as SidebarOrder;
    return {
      groups: Array.isArray(parsed.groups) ? parsed.groups : [],
      items: parsed.items && typeof parsed.items === "object" ? parsed.items : {},
    };
  } catch {
    return EMPTY_ORDER;
  }
}

/**
 * What to show someone who never rearranged their sidebar: the admin's
 * published default for one of their roles, else the built-in order.
 */
export async function loadEffectiveSidebarOrder(
  userId: string,
  roles: readonly string[],
): Promise<SidebarOrder> {
  const personal = await loadSidebarOrder(userId);
  if (personal.groups.length > 0 || Object.keys(personal.items).length > 0) return personal;
  const published = await loadOrgDefault<SidebarOrder>("sidebar", roles);
  if (!published?.payload) return EMPTY_ORDER;
  return {
    groups: Array.isArray(published.payload.groups) ? published.payload.groups : [],
    items:
      published.payload.items && typeof published.payload.items === "object"
        ? published.payload.items
        : {},
  };
}

export async function saveSidebarOrder(userId: string, order: SidebarOrder): Promise<void> {
  const { error } = await supabase.from("user_view_prefs").upsert(
    {
      user_id: userId,
      scope: SCOPE,
      view_mode: JSON.stringify(order),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,scope" },
  );
  if (error) throw error;
}

export async function resetSidebarOrder(userId: string): Promise<void> {
  await supabase.from("user_view_prefs").delete().eq("user_id", userId).eq("scope", SCOPE);
}

/** Saved order first (only what still exists), then anything new, in default order. */
export function applyOrder<T>(
  list: T[],
  saved: string[] | undefined,
  keyOf: (x: T) => string,
): T[] {
  if (!saved || saved.length === 0) return list;
  const rank = new Map(saved.map((k, i) => [k, i]));
  return [...list].sort((a, b) => {
    const ra = rank.get(keyOf(a));
    const rb = rank.get(keyOf(b));
    if (ra == null && rb == null) return 0;
    if (ra == null) return 1;
    if (rb == null) return -1;
    return ra - rb;
  });
}

/** Broadcast so the sidebar re-reads after a reset from the dashboard menu. */
export const SIDEBAR_ORDER_EVENT = "rh:sidebar-order-changed";
