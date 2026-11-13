import { createFileRoute } from "@tanstack/react-router";

import { denyUnlessCron } from "@/lib/cron-auth";

/**
 * Daily nudge on unsigned paperwork.
 *
 * An unsigned work authorisation is the single most common reason a job stalls
 * before mitigation starts, so the office is told rather than left to notice.
 * The reminder goes to the person who sent the packet — not the customer — and
 * fires at most once per `reminder_days` interval so nobody gets pestered.
 *
 * Auth: the `x-cron-secret` shared secret, compared in constant time by
 * denyUnlessCron (src/lib/cron-auth.ts). It fails closed when CRON_SECRET
 * is unset. The publishable key this once accepted is not a secret.
 */

const MAX_REMINDERS = 4;

export const Route = createFileRoute("/api/public/hooks/document-signature-reminders")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const denied = denyUnlessCron(request);
        if (denied) return denied;

        /* After the credential check, never before: a database round trip per
           anonymous request would be the amplification the limiter exists to
           stop. Volumetric floods belong to Cloudflare WAF. */
        const { throttleWebhook } = await import("@/lib/rate-limit.server");
        const throttled = await throttleWebhook(request, "document-signature-reminders", true);
        if (throttled) return throttled;

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const now = Date.now();
        const nowIso = new Date(now).toISOString();

        const { data: packets, error } = await supabaseAdmin
          .from("document_send_packets")
          .select(
            "id, job_id, subject, recipient_email, recipient_name, sent_at, reminder_days, reminder_count, last_reminder_at, created_by, expires_at",
          )
          .is("completed_at", null)
          .is("revoked_at", null)
          .gt("expires_at", nowIso)
          .not("sent_at", "is", null);
        if (error) return Response.json({ error: error.message }, { status: 500 });

        const due = (packets ?? []).filter((p) => {
          if (p.reminder_count >= MAX_REMINDERS) return false;
          const since = new Date(p.last_reminder_at ?? p.sent_at!).getTime();
          return now - since >= p.reminder_days * 86_400_000;
        });

        const notifications = due
          .filter((p) => p.created_by)
          .map((p) => {
            const days = Math.floor((now - new Date(p.sent_at!).getTime()) / 86_400_000);
            return {
              user_id: p.created_by!,
              type: "record_stalled" as const,
              title: `Unsigned ${days} days: ${p.recipient_name ?? p.recipient_email}`,
              body: `${p.subject} has not been signed. Follow up or re-send the link.`,
              entity_type: p.job_id ? "job" : "document",
              entity_id: p.job_id ?? p.id,
              href: p.job_id ? `/jobs/${p.job_id}` : "/documents",
              priority: "normal" as const,
            };
          });

        if (notifications.length) {
          await supabaseAdmin.from("notifications").insert(notifications);
        }

        for (const p of due) {
          await supabaseAdmin
            .from("document_send_packets")
            .update({ last_reminder_at: nowIso, reminder_count: p.reminder_count + 1 })
            .eq("id", p.id);
        }

        return Response.json({ ok: true, reminded: due.length });
      },
    },
  },
});
