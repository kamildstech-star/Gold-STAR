import { supabase } from "@/integrations/supabase/client";
import type { AppRole } from "@/lib/roles";
import { clearViewAsSession, currentAuthSessionId, rememberViewAsSession } from "@/lib/view-as";

/**
 * Impersonation state kept server-side in impersonation_audit, keyed to
 * the real actor's auth.uid(). All entry points below are SECURITY DEFINER
 * RPCs; they enforce the real user is admin / owner / dev, that at most one
 * open session exists at a time, and cannot be forged from the client.
 *
 * View As is a NARROWING filter applied on top of the real user's RLS:
 * data still comes back through the actor's normal permissions. The client
 * uses the returned scope to intersect what the UI shows.
 */

export interface TargetScope {
  user_id: string;
  full_name: string | null;
  email: string | null;
  is_active: boolean;
  roles: AppRole[];
  location_ids: string[];
  region_ids: string[];
}

export interface ActiveImpersonation {
  id: string;
  started_at: string;
  target_user_id: string | null;
  preview_role: AppRole | null;
  target_scope: TargetScope | null;
}

export async function fetchActiveImpersonation(): Promise<ActiveImpersonation | null> {
  const { data, error } = await supabase.rpc("get_active_impersonation");
  if (error) throw error;
  return (data as ActiveImpersonation | null) ?? null;
}

export async function startImpersonationAs(targetUserId: string): Promise<string> {
  const { data, error } = await supabase.rpc("start_impersonation", {
    _target_user_id: targetUserId,
    _preview_role: null as unknown as AppRole,
  });
  if (error) throw error;
  // A person view lasts as long as the sign-in that started it — see
  // view-as.ts. Noted for every doorway (sidebar picker, Users, Test users).
  rememberViewAsSession(data as string, await currentAuthSessionId());
  return data as string;
}

export async function startImpersonationPreview(role: AppRole): Promise<string> {
  const { data, error } = await supabase.rpc("start_impersonation", {
    _target_user_id: null as unknown as string,
    _preview_role: role,
  });
  if (error) throw error;
  return data as string;
}

export async function endImpersonation(): Promise<void> {
  const { error } = await supabase.rpc("end_impersonation");
  if (error) throw error;
  clearViewAsSession();
}

/**
 * Sign-out ends any open View As first, while there is still a session to
 * end it with — otherwise the audit row would stay open until the next
 * sign-in noticed it. Never blocks the sign-out.
 */
export async function endImpersonationForSignOut(): Promise<void> {
  try {
    await endImpersonation();
  } catch {
    /* the next sign-in ends it (different session) */
  }
  clearViewAsSession();
}

export async function fetchStaffUserIds(): Promise<string[]> {
  const { data, error } = await supabase.rpc("staff_user_ids");
  if (error) throw error;
  return ((data ?? []) as { staff_user_ids: string } | string[])
    ? (data as unknown as string[])
    : [];
}

/** Return path helpers so Exit returns the actor to where they came from. */
const RETURN_KEY = "rh:impersonation-return";

export function rememberReturnPath(path: string) {
  try {
    sessionStorage.setItem(RETURN_KEY, path);
  } catch {
    /* noop */
  }
}

export function popReturnPath(): string | null {
  try {
    const v = sessionStorage.getItem(RETURN_KEY);
    sessionStorage.removeItem(RETURN_KEY);
    return v;
  } catch {
    return null;
  }
}
