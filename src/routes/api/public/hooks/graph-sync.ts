/**
 * Scheduled Microsoft Graph reconciliation.
 *
 * Three jobs, all driven by pg_cron:
 *  1. Renew change-notification subscriptions. Mail subscriptions expire in
 *     ~3 days; if renewal fails the feed dies silently, so a failure raises a
 *     notification to admins rather than just logging.
 *  2. Run a delta query per mailbox to catch anything a dropped webhook lost.
 *     Webhooks are never trusted on their own.
 *  3. Drain the outbound calendar queue — every row `calendar.ts` marked
 *     `pending_push` when somebody rescheduled or cancelled in the CRM. The
 *     save already succeeded locally; this is where it reaches the attendees.
 *     Rows that keep failing become `sync_state = 'error'` and are reported
 *     here, because an attendee holding a stale invite is invisible otherwise.
 *
 * In delegated mode a mailbox nobody can currently speak for (person not
 * connected, sign-in expired, shared mailbox without an owner) is SKIPPED and
 * listed under `skipped` — it does not fail the run or page the admins every
 * night, because coverage is voluntary by design. The admin screen shows the
 * same list.
 *
 * Auth: the `x-cron-secret` shared secret, compared in constant time by
 * denyUnlessCron (src/lib/cron-auth.ts) — the same CRON_SECRET every other
 * scheduled hook uses, read by pg_cron from Vault through
 * public.graph_sync_kick() (migration 20261011120000). It fails closed when
 * CRON_SECRET is unset. This hook used to have a secret of its own,
 * GRAPH_SYNC_SECRET, and because no job in the database held it, nothing ever
 * called it: subscriptions lapsed after the first sync and mail stopped. One
 * secret for every cron hook is what lets the scheduler reach it.
 *
 * Before IT has finished (no Outlook app details) or before anyone has
 * registered a mailbox, a run is a cheap 200 `{ ok: true, skipped }`: a
 * schedule that starts early must not page the admins every quarter hour.
 * The Outlook values are read after the credential check through
 * loadOutlookEnv, so the ones an admin typed on the Integrations screen count,
 * and win over deployment secrets of the same name.
 */
import { createFileRoute } from "@tanstack/react-router";

import { denyUnlessCron } from "@/lib/cron-auth";

/** An unread "needs attention" notice younger than this is not repeated. */
const ALERT_QUIET_MS = 24 * 3_600_000;
const ALERT_TITLE = "Outlook sync needs attention";

export const Route = createFileRoute("/api/public/hooks/graph-sync")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const denied = denyUnlessCron(request);
        if (denied) return denied;

        /* After the credential check, never before: a database round trip per
           anonymous request would be the amplification the limiter exists to
           stop. Volumetric floods belong to Cloudflare WAF. */
        const { throttleWebhook } = await import("@/lib/rate-limit.server");
        const throttled = await throttleWebhook(request, "graph-sync", true);
        if (throttled) return throttled;

        // Admin-entered Outlook values (Integrations screen) over process.env,
        // before anything below reads OUTLOOK_*. After the secret check, like
        // the limiter, so an anonymous caller never causes the read.
        const { loadOutlookEnv } = await import("@/lib/microsoft-delegated.server");
        await loadOutlookEnv();

        const { graphConfigured } = await import("@/lib/graph.server");
        if (!graphConfigured()) {
          return Response.json({ ok: true, skipped: "not configured", reason: "no_credentials" });
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { listMailboxRows, refreshMailboxIdentity, ensureSubscriptions, syncMailbox } =
          await import("@/lib/graph-sync.server");

        const mailboxes = (await listMailboxRows()).filter((m) => m.enabled);
        /* Nothing registered yet is a setup step, not a failure: no sync_runs
           row, no admin notice, and the connection's status is left as the
           admin screen set it. Every queued calendar push names a mailbox, so
           there is nothing for the outbound half to do either. */
        if (mailboxes.length === 0) {
          return Response.json({ ok: true, skipped: "not configured", reason: "no_mailboxes" });
        }

        const startedAt = new Date().toISOString();
        const results: Array<Record<string, unknown>> = [];
        const renewalFailures: string[] = [];
        const skippedMailboxes: Array<{ upn: string; problem: string; message: string }> = [];
        let held = 0;

        for (const mailbox of mailboxes) {
          try {
            await refreshMailboxIdentity(mailbox);
            const subs = await ensureSubscriptions(mailbox);
            if (subs.skipped) {
              skippedMailboxes.push(subs.skipped);
              results.push({ upn: mailbox.upn, skipped: subs.skipped.problem });
              continue;
            }
            if (subs.error) renewalFailures.push(`${mailbox.upn}: ${subs.error}`);
            const sync = await syncMailbox(mailbox);
            if (sync.skipped) {
              skippedMailboxes.push(sync.skipped);
              results.push({ upn: mailbox.upn, skipped: sync.skipped.problem });
              continue;
            }
            if (sync.error) renewalFailures.push(`${mailbox.upn}: ${sync.error}`);
            held += sync.calendar?.held ?? 0;
            results.push({
              upn: mailbox.upn,
              subscriptions: { messages: subs.messages, events: subs.events },
              mail: sync.mail,
              calendar: sync.calendar,
              error: sync.error ?? subs.error,
            });
          } catch (e) {
            const message = (e as Error).message;
            renewalFailures.push(`${mailbox.upn}: ${message}`);
            results.push({ upn: mailbox.upn, error: message });
            await supabaseAdmin
              .from("graph_mailboxes")
              .update({ last_error: message })
              .eq("id", mailbox.id);
          }
        }

        /* The outbound half. Runs after ingestion so a row that was just
           reconciled from Graph is pushed against current state, and outside
           the per-mailbox loop because the queue is keyed by event, not by
           mailbox. Its own failures are reported, never thrown — a stuck push
           must not stop the mail feed. */
        const { drainCalendarPushQueue, calendarPushSummary } =
          await import("@/lib/calendar-push.server");
        let push = { pushed: 0, failed: 0, stuck: 0, skipped: 0, waiting: 0, considered: 0 };
        let pushQueue = { pending: 0, stuck: 0 };
        try {
          const drained = await drainCalendarPushQueue({ limit: 200 });
          push = {
            pushed: drained.pushed,
            failed: drained.failed,
            stuck: drained.stuck,
            skipped: drained.skipped,
            waiting: drained.waiting,
            considered: drained.considered,
          };
          const summary = await calendarPushSummary();
          pushQueue = { pending: summary.pending, stuck: summary.stuck };
          if (summary.stuck > 0) {
            renewalFailures.push(
              `${summary.stuck} calendar change(s) could not reach Outlook — attendees still hold the old invite`,
            );
          }
          /* A row can also fail without ever being marked stuck — while the
             attempt counter's migration is unapplied there is nothing to count
             with. An edit still sitting in the queue hours later is the same
             problem wearing a different state, so it is reported the same way. */
          const stale =
            summary.oldest_pending_at &&
            Date.now() - new Date(summary.oldest_pending_at).getTime() > 6 * 3_600_000;
          if (stale) {
            renewalFailures.push(
              `a calendar change has been waiting to reach Outlook since ${summary.oldest_pending_at}`,
            );
          }
        } catch (e) {
          renewalFailures.push(`calendar push: ${(e as Error).message}`);
        }

        await supabaseAdmin.from("sync_runs").insert({
          source_system: "outlook_graph",
          started_at: startedAt,
          finished_at: new Date().toISOString(),
          success: renewalFailures.length === 0,
          source_rows: results.length,
          upserted: results.length,
          errors: renewalFailures as unknown as never,
        });

        if (renewalFailures.length) {
          // A dead subscription is invisible otherwise — tell the admins.
          const { data: admins } = await supabaseAdmin
            .from("user_roles")
            .select("user_id")
            .in("role", ["owner", "admin", "dev"]);
          const adminIds = [...new Set((admins ?? []).map((a) => a.user_id))];
          /* Every quarter hour, a lasting fault would otherwise be 96 notices a
             day per admin. One unread notice stands for the fault until it is
             read or a day old; sync_runs and the admin screen still record
             every run. */
          const { data: recent } = adminIds.length
            ? await supabaseAdmin
                .from("notifications")
                .select("user_id")
                .eq("type", "sync_failed")
                .eq("title", ALERT_TITLE)
                .is("read_at", null)
                .gte("created_at", new Date(Date.now() - ALERT_QUIET_MS).toISOString())
                .in("user_id", adminIds)
            : { data: [] };
          const alerted = new Set((recent ?? []).map((n) => n.user_id));
          const unique = adminIds.filter((id) => !alerted.has(id));
          if (unique.length) {
            await supabaseAdmin.from("notifications").insert(
              unique.map((user_id) => ({
                user_id,
                type: "sync_failed" as const,
                priority: "high" as const,
                title: ALERT_TITLE,
                body: `Microsoft 365 subscription renewal or sync failed for: ${renewalFailures
                  .join(", ")
                  .slice(0, 400)}`,
                href: "/admin/integrations/outlook",
              })),
            );
          }
        }

        await supabaseAdmin
          .from("integration_connections")
          .update({
            last_sync_at: new Date().toISOString(),
            status: renewalFailures.length ? "error" : "connected",
            last_error: renewalFailures.length ? renewalFailures.join(" | ").slice(0, 1000) : null,
          })
          .eq("provider", "outlook");

        return Response.json({
          ok: true,
          mailboxes: results.length,
          meetings_marked_held: held,
          calendar_push: { ...push, queue: pushQueue },
          failures: renewalFailures,
          skipped: skippedMailboxes,
          results,
        });
      },
    },
  },
});
