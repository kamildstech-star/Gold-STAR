import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";

type NotificationType = Database["public"]["Enums"]["notification_type"];
type Priority = Database["public"]["Enums"]["notification_priority"];

export type NotifyInput = {
  userIds: string[];
  type: NotificationType;
  title: string;
  body?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  href?: string | null;
  priority?: Priority;
};

/** Notifications are chrome for the app, not a redirector. */
export function safeHref(href: string | null | undefined): string | null {
  if (!href) return null;
  const value = href.trim();
  if (!value.startsWith("/")) return null;
  // `//host` and `/\host` are protocol-relative — the browser leaves the site.
  if (/^\/[/\\]/.test(value)) return null;
  // Control characters have no place in a route and can break the renderer.
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return null;
  }
  return value.slice(0, 500);
}

/**
 * Which of the requested recipients this caller is actually allowed to put a
 * notification in front of. Notifications carry attacker-chosen text into a
 * trusted surface and out through our own mail domain, so the recipient list
 * has to be earned, not asserted.
 *
 * Earned by: it's you; you are an owner/admin/dev; or you share a location
 * with them. That covers every real fan-out we do — a supply request pinging
 * its office managers, a decision pinging the requester, a manager updating a
 * rep's goals — and stops "notify the whole company" cold.
 *
 * Checked against the service-role client on purpose: this is an
 * authorization decision about `callerId`, not a read that should inherit
 * whatever the caller's RLS happens to allow.
 */
export async function allowedTargets(
  admin: SupabaseClient<Database>,
  callerId: string,
  requested: string[],
): Promise<string[]> {
  const self = requested.filter((id) => id === callerId);
  const others = requested.filter((id) => id !== callerId);
  if (others.length === 0) return self;

  const { data: privileged } = await admin.rpc("is_privileged", { _user_id: callerId });
  if (privileged === true) return requested;

  const { data: mine } = await admin
    .from("location_members")
    .select("location_id")
    .eq("user_id", callerId);
  const locationIds = [...new Set((mine ?? []).map((r) => r.location_id))];
  if (locationIds.length === 0) return self;

  const { data: peers } = await admin
    .from("location_members")
    .select("user_id")
    .in("location_id", locationIds)
    .in("user_id", others);
  const reachable = new Set((peers ?? []).map((p) => p.user_id));
  return [...self, ...others.filter((id) => reachable.has(id))];
}

/**
 * Fan out one notification to several users, honouring each user's
 * preferences. A type a user turned off is never written and never emailed.
 * Quiet hours suppress the email channel only — the in-app record still
 * lands so nothing is lost, it just does not interrupt.
 *
 * The recipient list is intersected with who the caller may reach; `skipped`
 * reports how many were dropped so a legitimate caller losing recipients is
 * visible rather than silent.
 */
export const notifyUsers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: NotifyInput) => data)
  .handler(async ({ data, context }) => {
    const requested = [...new Set(data.userIds.filter(Boolean))];
    if (requested.length === 0) return { inApp: 0, emailed: 0, skipped: 0 };
    if (requested.length > 200) throw new Error("Too many notification recipients.");
    if (!data.title.trim()) throw new Error("A notification needs a title.");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const targets = await allowedTargets(supabaseAdmin, context.userId, requested);
    const skipped = requested.length - targets.length;
    if (skipped > 0) {
      console.warn(
        `[notifications] dropped ${skipped} recipient(s) outside ${context.userId}'s reach`,
      );
    }
    if (targets.length === 0) return { inApp: 0, emailed: 0, skipped };

    const title = data.title.slice(0, 200);
    const body = data.body ? data.body.slice(0, 2000) : null;
    const href = safeHref(data.href);

    const { data: prefs } = await supabaseAdmin
      .from("notification_preferences")
      .select("user_id, in_app, email, delivery, quiet_hours_start, quiet_hours_end")
      .in("user_id", targets)
      .eq("type", data.type);

    const prefByUser = new Map((prefs ?? []).map((p) => [p.user_id, p]));
    const hour = new Date().getHours();

    const inQuietHours = (start: number | null, end: number | null) => {
      if (start == null || end == null) return false;
      return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
    };

    const inAppRows: {
      user_id: string;
      type: NotificationType;
      title: string;
      body: string | null;
      entity_type: string | null;
      entity_id: string | null;
      href: string | null;
      priority: Priority;
    }[] = [];
    const emailTargets: string[] = [];

    for (const userId of targets) {
      const pref = prefByUser.get(userId);
      const delivery = pref?.delivery ?? "immediate";
      if (delivery === "off") continue;
      const inApp = pref?.in_app ?? true;
      const email = pref?.email ?? false;

      if (inApp) {
        inAppRows.push({
          user_id: userId,
          type: data.type,
          title,
          body,
          entity_type: data.entityType ?? null,
          entity_id: data.entityId ?? null,
          href,
          priority: data.priority ?? "normal",
        });
      }

      if (
        email &&
        delivery === "immediate" &&
        !inQuietHours(pref?.quiet_hours_start ?? null, pref?.quiet_hours_end ?? null)
      ) {
        emailTargets.push(userId);
      }
    }

    if (inAppRows.length > 0) {
      const { error } = await supabaseAdmin.from("notifications").insert(inAppRows);
      if (error) throw new Error(error.message);
    }

    let emailed = 0;
    if (emailTargets.length > 0) {
      const { resendConfigured, sendViaResend } = await import("./email.server");
      if (resendConfigured()) {
        const { data: profiles } = await supabaseAdmin
          .from("profiles")
          .select("user_id, email")
          .in("user_id", emailTargets);
        const addresses = (profiles ?? []).map((p) => p.email).filter((e): e is string => !!e);
        if (addresses.length > 0) {
          try {
            await sendViaResend({
              to: addresses,
              subject: title,
              html: `<p>${escapeHtml(title)}</p>${body ? `<p>${escapeHtml(body)}</p>` : ""}`,
            });
            emailed = addresses.length;
          } catch (error) {
            // A failed notification email must not fail the originating action.
            console.error("[notifications] email delivery failed", error);
          }
        }
      }
    }

    return { inApp: inAppRows.length, emailed, skipped };
  });

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
