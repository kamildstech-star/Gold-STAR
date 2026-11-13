// Ban sign-in first, then deactivate the profile and flag integrations, then
// end the sessions already open. Auth signOut requires a JWT, not a user ID, so
// sessions are ended in the database (public.revoke_user_sessions). An access
// token already issued lives until its expiry, but the active-profile guard
// refuses it every row from the moment the profile is inactive.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export const deactivateUserNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { userId: string; reason?: string | null }) => {
    return z
      .object({ userId: z.string().uuid(), reason: z.string().max(2000).nullable().optional() })
      .parse(input);
  })
  .handler(async ({ data, context }) => {
    const { supabase: userClient, userId } = context;
    const { data: allowed } = await userClient.rpc("is_sales_lead", { _user_id: userId });
    if (!allowed)
      throw new Error("Only the Sales Head, an owner or an admin can deactivate a user.");
    if (data.userId === userId) throw new Error("You cannot deactivate yourself.");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // Check target hierarchy BEFORE the Auth mutation. The deactivation RPC
    // only checks is_sales_lead, and caller RLS may hide a target's roles.
    const { data: roleRows, error: rolesError } = await supabaseAdmin
      .from("user_roles")
      .select("user_id, role")
      .in("user_id", [userId, data.userId]);
    if (rolesError)
      throw new Error("Could not verify target authority. No deactivation was applied.");
    const actorRoles = new Set(
      (roleRows ?? []).filter((r) => r.user_id === userId).map((r) => r.role),
    );
    const targetRoles = new Set(
      (roleRows ?? []).filter((r) => r.user_id === data.userId).map((r) => r.role),
    );
    if (
      (targetRoles.has("owner") && !actorRoles.has("owner")) ||
      ((targetRoles.has("admin") || targetRoles.has("dev")) &&
        !actorRoles.has("owner") &&
        !actorRoles.has("admin"))
    )
      throw new Error("You cannot deactivate a user with a protected role.");
    // Long-lived, explicitly reversible ban. Never claim deactivation succeeded
    // if Auth refused it, and never undo a successful ban on a later DB failure.
    const { error: banError } = await supabaseAdmin.auth.admin.updateUserById(data.userId, {
      ban_duration: "876000h",
    });
    if (banError)
      throw new Error("Sign-in could not be blocked. Deactivation was not applied; retry.");

    let result;
    try {
      const response = await userClient.rpc("deactivate_user_now", {
        _user_id: data.userId,
        _reason: data.reason ?? undefined,
      });
      if (response.error) throw response.error;
      result = response.data;
    } catch {
      throw new Error(
        "Sign-in is blocked, but profile deactivation could not be confirmed. The Auth ban remains in place; retry deactivation.",
      );
    }

    // End the sessions already open (20260929121000). The ban stops new
    // sign-ins; this stops the refresh tokens minting more access. The
    // database also does it on its own when the profile goes inactive, so a
    // failure here is reported, not fatal: sessionsRevoked says what is known,
    // and the active-profile guard refuses the old token's reads either way.
    const { error: revokeError } = await supabaseAdmin.rpc(
      "revoke_user_sessions" as never,
      { _user_id: data.userId } as never,
    );

    return {
      ...(result as Record<string, unknown>),
      signInBlocked: true,
      sessionsRevoked: !revokeError,
    };
  });

/** Call after an administrator has restored/reviewed the profile and scope.
 * Merely toggling profiles.is_active cannot remove an Auth ban. */
export const restoreUserSignIn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { userId: string }) =>
    z.object({ userId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: roles, error: roleError } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId);
    if (roleError || !(roles ?? []).some((r) => r.role === "admin" || r.role === "owner"))
      throw new Error("Only an owner or admin can restore sign-in.");
    const { data: profile, error } = await context.supabase
      .from("profiles")
      .select("is_active, approval_status")
      .eq("user_id", data.userId)
      .maybeSingle();
    if (error || !profile?.is_active || profile.approval_status !== "approved")
      throw new Error("Restore and approve the profile before restoring sign-in.");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error: unbanError } = await supabaseAdmin.auth.admin.updateUserById(data.userId, {
      ban_duration: "none",
    });
    if (unbanError)
      throw new Error(
        "The profile is active, but sign-in could not be restored. The Auth ban may remain; retry.",
      );
    return { signInBlocked: false };
  });
