import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";
import { joinOrigin, serverAppOrigin } from "@/lib/app-origin";

/**
 * An auth-admin error, worded for the admin who clicked. "Invalid API key" is
 * Supabase refusing the SERVER's own key (SUPABASE_SERVICE_ROLE_KEY on the
 * host) — not the person being invited — and said that way it read like a
 * problem with the invite (staging, 27 Oct).
 */
export function authAdminError(message: string, keyShape?: string): Error {
  if (/invalid api key|legacy api keys are disabled|no api key found/i.test(message)) {
    return new Error(
      "The server's database key is not valid (the service key set on the hosting). Nothing was sent — ask whoever manages the deployment to fix the key." +
        (keyShape ? ` (Check: ${keyShape}.)` : ""),
    );
  }
  return new Error(message);
}

/** authAdminError, plus what the running server's key looks like (never the key). */
async function authAdminFailure(message: string): Promise<Error> {
  const { serviceKeyShape } = await import("./service-key-shape.server");
  return authAdminError(message, serviceKeyShape());
}

/**
 * Server-side privilege gate. RLS is still the boundary; this second check
 * only exists to reject unprivileged calls before we touch the auth admin
 * API (which bypasses RLS entirely).
 */
async function assertPrivileged(supabase: SupabaseClient<Database>, userId: string) {
  const { data, error } = await supabase.from("user_roles").select("role").eq("user_id", userId);
  if (error) throw new Error(error.message);
  const roles = (data ?? []).map((r) => r.role as string);
  if (!roles.includes("admin") && !roles.includes("owner")) {
    throw new Error("Not authorized");
  }
}

export interface AdminUserRow {
  user_id: string;
  full_name: string | null;
  email: string | null;
  is_active: boolean;
  roles: string[];
  location_ids: string[];
  location_roles: string[];
  region_ids: string[];
  last_sign_in_at: string | null;
  auth_created_at: string | null;
  /** 'pending' | 'approved' | 'rejected' — the admin approval gate. */
  approval_status: string;
  /** Null when the user has never confirmed their email address. */
  email_confirmed_at: string | null;
}

export interface AdminUserListResult {
  users: AdminUserRow[];
  /** Non-fatal: last-sign-in enrichment failed; the list is still complete. */
  enrichmentWarning: string | null;
}

/**
 * Returns one row per user: profile + roles + memberships from the RPC.
 * Auth-admin enrichment (last sign-in) is optional — if it fails the list
 * must still render, with a warning instead of an empty screen.
 */
export const adminListUsers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<AdminUserListResult> => {
    await assertPrivileged(context.supabase, context.userId);

    const { data: usersData, error } = await context.supabase.rpc("admin_list_users");
    if (error) throw new Error(error.message);

    // Auth admin API is capped at 1k per page. Recovery Hub is ~250 users,
    // so one page is fine; add pagination if that ever grows past a page.
    const authById = new Map<
      string,
      {
        email?: string;
        last_sign_in_at?: string;
        created_at?: string;
        email_confirmed_at?: string;
      }
    >();
    let enrichmentWarning: string | null = null;
    try {
      if (!process.env["SUPABASE_SERVICE_ROLE_KEY"] || !process.env["SUPABASE_URL"]) {
        throw new Error("Service role key is not configured on this environment");
      }
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { data: authData, error: aErr } = await supabaseAdmin.auth.admin.listUsers({
        perPage: 1000,
      });
      if (aErr) throw new Error(aErr.message);
      for (const u of authData.users) authById.set(u.id, u);
    } catch (e) {
      enrichmentWarning = e instanceof Error ? e.message : String(e);
      console.error("[adminListUsers] last-sign-in enrichment failed:", e);
    }

    const users = (usersData ?? []).map((u) => {
      const au = authById.get(u.user_id);
      return {
        user_id: u.user_id,
        full_name: u.full_name,
        email: u.email ?? au?.email ?? null,
        is_active: u.is_active,
        roles: (u.roles ?? []) as string[],
        location_ids: (u.location_ids ?? []) as string[],
        location_roles: (u.location_roles ?? []) as string[],
        region_ids: (u.region_ids ?? []) as string[],
        last_sign_in_at: au?.last_sign_in_at ?? null,
        auth_created_at: au?.created_at ?? null,
        approval_status: (u as { approval_status?: string }).approval_status ?? "approved",
        email_confirmed_at: au?.email_confirmed_at ?? null,
      };
    });

    return { users, enrichmentWarning };
  });

/**
 * Sends a Supabase invite email and applies the initial scope in one call.
 *
 * At least one location membership is REQUIRED: a user with a role but no
 * location membership passes RLS on nothing and sees an empty app, which
 * reads as a broken product rather than a misconfiguration. Roles and
 * memberships are written through the CALLER's client (not the admin one)
 * so RLS still applies and the audit triggers capture a real actor_id.
 */
export const adminInviteUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) =>
    z
      .object({
        email: z.string().email(),
        fullName: z.string().min(1).max(200).optional(),
        roles: z.array(z.string()).default([]),
        locations: z
          .array(
            z.object({
              location_id: z.string().uuid(),
              role: z.string(),
            }),
          )
          .min(1, "At least one location is required"),
        regionIds: z.array(z.string().uuid()).default([]),
        /** Defaults to the first location given — every invitee gets one. */
        primaryLocationId: z.string().uuid().optional(),
      })
      .parse(data),
  )
  .handler(async ({ context, data }) => {
    await assertPrivileged(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: inv, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(data.email, {
      data: data.fullName ? { full_name: data.fullName } : undefined,
    });
    if (error) throw new Error(error.message);
    const newUserId = inv.user?.id ?? null;
    if (!newUserId) throw new Error("Invite succeeded but returned no user id");

    const warnings: string[] = [];

    if (data.roles.length > 0) {
      const { error: rErr } = await context.supabase.from("user_roles").insert(
        data.roles.map((role) => ({
          user_id: newUserId,
          role: role as Database["public"]["Enums"]["app_role"],
        })),
      );
      if (rErr) warnings.push(`Roles not applied: ${rErr.message}`);
    }

    const { error: lErr } = await context.supabase.from("location_members").insert(
      data.locations.map((l) => ({
        user_id: newUserId,
        location_id: l.location_id,
        role: l.role as Database["public"]["Enums"]["location_member_role"],
      })),
    );
    if (lErr) warnings.push(`Locations not applied: ${lErr.message}`);

    // The office that pre-fills their forms. The membership trigger already
    // sets the first one; this only matters when the admin picked a specific
    // primary or the trigger has not shipped yet. A missing column is not a
    // failed invite — the profile may also not exist until first sign-in.
    const primaryLocationId =
      data.primaryLocationId && data.locations.some((l) => l.location_id === data.primaryLocationId)
        ? data.primaryLocationId
        : data.locations[0]?.location_id;
    if (primaryLocationId) {
      const { error: pErr } = await supabaseAdmin
        .from("profiles")
        .update({ primary_location_id: primaryLocationId })
        .eq("user_id", newUserId);
      if (pErr && !/does not exist|schema cache/i.test(pErr.message)) {
        warnings.push(`Primary location not set: ${pErr.message}`);
      }
    }

    if (data.regionIds.length > 0) {
      const { error: gErr } = await context.supabase.from("region_members").insert(
        data.regionIds.map((region_id) => ({
          user_id: newUserId,
          region_id,
        })),
      );
      if (gErr) warnings.push(`Regions not applied: ${gErr.message}`);
    }

    return { user_id: newUserId, warnings };
  });

/**
 * Nominatim (OSM) reverse geocoder. Free, no key. Only exposed to admins
 * so we don't leak an outbound rate limit to arbitrary users.
 */
export const adminGeocode = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => z.object({ address: z.string().min(3).max(500) }).parse(data))
  .handler(async ({ context, data }) => {
    await assertPrivileged(context.supabase, context.userId);
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(
      data.address,
    )}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "RecoveryHub-Admin/1.0 (contact: ops@goldstarrestoration.com)",
      },
    });
    if (!res.ok) throw new Error(`Geocoder returned ${res.status}`);
    const json = (await res.json()) as Array<{
      lat: string;
      lon: string;
      display_name: string;
    }>;
    if (json.length === 0) return null;
    return {
      lat: Number(json[0].lat),
      lon: Number(json[0].lon),
      display_name: json[0].display_name,
    };
  });

/**
 * Marks a user's email confirmed without an email round-trip.
 *
 * Supabase's built-in SMTP is capped at ~2 messages/hour, so confirmation
 * mail routinely never arrives. The admin approval gate is the real control
 * on who gets in, so confirming by hand here is safe.
 */
export const adminConfirmEmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => z.object({ userId: z.string().uuid() }).parse(data))
  .handler(async ({ context, data }) => {
    await assertPrivileged(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.auth.admin.updateUserById(data.userId, {
      email_confirm: true,
    });
    if (error) throw await authAdminFailure(error.message);
    return { ok: true };
  });

/**
 * Re-sends the invite (never signed in) or the confirmation email.
 * Subject to the same provider rate limit — the caller sees the error.
 */
export const adminResendInvite = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => z.object({ userId: z.string().uuid() }).parse(data))
  .handler(async ({ context, data }) => {
    await assertPrivileged(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: got, error: gErr } = await supabaseAdmin.auth.admin.getUserById(data.userId);
    if (gErr) throw await authAdminFailure(gErr.message);
    const email = got.user?.email;
    if (!email) throw new Error("That user has no email address on file");
    if (got.user?.email_confirmed_at) {
      throw new Error("This email is already confirmed — send a password reset instead");
    }

    const { error: iErr } = await supabaseAdmin.auth.admin.inviteUserByEmail(email);
    if (iErr) {
      const { error: rErr } = await supabaseAdmin.auth.resend({
        type: "signup",
        email,
      });
      if (rErr) throw await authAdminFailure(rErr.message);
    }
    return { ok: true, email };
  });

/**
 * A link the admin copies and sends themselves — text, WhatsApp, Teams —
 * when the invite email does not arrive (27 Oct). It is a set-password link
 * to /reset-password, the one public route that sets a password from a
 * recovery session (see AGENTS.md: no administrative password override); the
 * person chooses their own password there, and following it confirms their
 * email. It works once and expires on the project's email-link expiry.
 */
export const adminInviteLink = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => z.object({ userId: z.string().uuid() }).parse(data))
  .handler(async ({ context, data }): Promise<{ link: string; email: string }> => {
    await assertPrivileged(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: got, error: gErr } = await supabaseAdmin.auth.admin.getUserById(data.userId);
    if (gErr) throw await authAdminFailure(gErr.message);
    const email = got.user?.email;
    if (!email) throw new Error("That user has no email address on file");
    const { data: gen, error } = await supabaseAdmin.auth.admin.generateLink({
      type: "recovery",
      email,
      options: { redirectTo: joinOrigin(serverAppOrigin(), "/reset-password") },
    });
    if (error) throw await authAdminFailure(error.message);
    const link = gen.properties?.action_link;
    if (!link) throw new Error("No link came back. Try again, or use Resend invite.");
    return { link, email };
  });

/**
 * Approves a pending signup: applies role + location scope through the
 * CALLER's client (so RLS and the audit triggers see a real actor) and
 * flips the profile out of `pending`.
 */
export const adminApproveUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) =>
    z
      .object({
        userId: z.string().uuid(),
        roles: z.array(z.string()).min(1, "Pick at least one role"),
        locations: z
          .array(z.object({ location_id: z.string().uuid(), role: z.string() }))
          .min(1, "Pick at least one location"),
        regionIds: z.array(z.string().uuid()).default([]),
        confirmEmail: z.boolean().default(true),
      })
      .parse(data),
  )
  .handler(async ({ context, data }) => {
    await assertPrivileged(context.supabase, context.userId);
    const warnings: string[] = [];

    const { error: rErr } = await context.supabase.from("user_roles").upsert(
      data.roles.map((role) => ({
        user_id: data.userId,
        role: role as Database["public"]["Enums"]["app_role"],
      })),
      { onConflict: "user_id,role", ignoreDuplicates: true },
    );
    if (rErr) throw new Error(`Roles not applied: ${rErr.message}`);

    const { error: lErr } = await context.supabase.from("location_members").upsert(
      data.locations.map((l) => ({
        user_id: data.userId,
        location_id: l.location_id,
        role: l.role as Database["public"]["Enums"]["location_member_role"],
      })),
      { onConflict: "user_id,location_id", ignoreDuplicates: true },
    );
    if (lErr) throw new Error(`Locations not applied: ${lErr.message}`);

    if (data.regionIds.length > 0) {
      const { error: gErr } = await context.supabase.from("region_members").upsert(
        data.regionIds.map((region_id) => ({ user_id: data.userId, region_id })),
        { onConflict: "user_id,region_id", ignoreDuplicates: true },
      );
      if (gErr) warnings.push(`Regions not applied: ${gErr.message}`);
    }

    const { error: pErr } = await context.supabase
      .from("profiles")
      .update({
        approval_status: "approved",
        approved_at: new Date().toISOString(),
        approved_by: context.userId,
        rejected_reason: null,
        is_active: true,
      })
      .eq("user_id", data.userId);
    if (pErr) throw new Error(pErr.message);

    if (data.confirmEmail) {
      try {
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { error } = await supabaseAdmin.auth.admin.updateUserById(data.userId, {
          email_confirm: true,
        });
        if (error) throw new Error(error.message);
      } catch (e) {
        warnings.push(`Email not confirmed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    await context.supabase.from("notifications").insert({
      user_id: data.userId,
      type: "user_signup",
      title: "Your account was approved",
      body: "You now have access to Recovery Hub.",
      href: "/",
    });

    return { ok: true, warnings };
  });

/** Rejects a pending signup: no role, no scope, account deactivated. */
export const adminRejectUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) =>
    z
      .object({
        userId: z.string().uuid(),
        reason: z.string().max(500).optional(),
      })
      .parse(data),
  )
  .handler(async ({ context, data }) => {
    await assertPrivileged(context.supabase, context.userId);
    const { error } = await context.supabase
      .from("profiles")
      .update({
        approval_status: "rejected",
        rejected_reason: data.reason ?? null,
        is_active: false,
      })
      .eq("user_id", data.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
