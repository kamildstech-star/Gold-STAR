import { createFileRoute } from "@tanstack/react-router";
import { denyUnlessCron } from "@/lib/cron-auth";
import { loadClientHealthSettings } from "@/lib/client-health";
import { planCadenceTasks } from "@/lib/cadence-sweep";

/**
 * Nightly cadence sweep. Turns cadence thresholds into real, assigned tasks —
 * a dashboard tile nobody opens is not a reminder.
 *
 * Creates, idempotently (unique cadence_key per account per period):
 *  - an at-risk task when an account has had no touchpoint for the client
 *    health at-risk threshold (Settings → Client health, default 120 days)
 *  - otherwise a quarterly touch task at the watch threshold (default 90)
 *  - an annual in-person meeting task when none in 365 days
 * The two touch thresholds are the same numbers the Active Clients board and
 * the account header judge health by — src/lib/client-health.ts.
 * Then notifies the assignee for tasks due today and overdue tasks, and warns
 * on vendor documents expiring within 30 days.
 *
 * WHICH ACCOUNTS, AND WHAT COUNTS AS A TOUCH, LIVE IN src/lib/cadence-sweep.ts.
 * This handler reads, plans and writes; `planCadenceTasks` decides. That split
 * is what let the two rules below be tested, having both been missing here:
 * an account whose type runs no clock (a homeowner) is skipped, and only a
 * touchpoint with `counts_toward_cadence` resets the touch clock. Both defer
 * to the modules that already owned those rules rather than restating them.
 *
 * Auth: the `x-cron-secret` shared secret, compared in constant time by
 * denyUnlessCron (src/lib/cron-auth.ts). It fails closed when CRON_SECRET
 * is unset. The publishable key this once accepted is not a secret.
 */

export const Route = createFileRoute("/api/public/hooks/cadence-sweep")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const denied = denyUnlessCron(request);
        if (denied) return denied;

        /* After the credential check, never before: a database round trip per
           anonymous request would be the amplification the limiter exists to
           stop. Volumetric floods belong to Cloudflare WAF. */
        const { throttleWebhook } = await import("@/lib/rate-limit.server");
        const throttled = await throttleWebhook(request, "cadence-sweep", true);
        if (throttled) return throttled;

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const health = await loadClientHealthSettings(supabaseAdmin);
        const now = new Date();
        const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
        const today = now.toISOString().slice(0, 10);

        // `account_type` is selected because the sweep must ask whether this
        // account's clocks run at all — see planCadenceTasks.
        const { data: accounts, error: accountsError } = await supabaseAdmin
          .from("accounts")
          .select("id, name, location_id, assigned_rep, status, account_type")
          .not("status", "in", "(lost)");
        if (accountsError) return Response.json({ error: accountsError.message }, { status: 500 });

        // `counts_toward_cadence` is selected for the same reason the Active
        // Clients board selects it: an unanswered outbound email is an attempt,
        // not a touch, and must not reset the clock.
        const { data: touchpoints } = await supabaseAdmin
          .from("touchpoints")
          .select("account_id, type, occurred_at, counts_toward_cadence");

        const rows = planCadenceTasks({
          accounts: accounts ?? [],
          touchpoints: touchpoints ?? [],
          health,
          now: now.getTime(),
          period,
          today,
        });

        let created = 0;
        if (rows.length > 0) {
          // tasks_cadence_uniq is a PARTIAL index (cadence_key IS NOT NULL), and
          // Postgres will not infer an ON CONFLICT arbiter from one unless the
          // statement repeats the predicate -- which PostgREST cannot emit. The
          // upsert this replaces failed 42P10, so the sweep created nothing at
          // all. Every key ends in the period, so one query covers the run.
          const { data: alreadyMade, error: seenError } = await supabaseAdmin
            .from("tasks")
            .select("cadence_key")
            .like("cadence_key", `%:${period}`);
          if (seenError) return Response.json({ error: seenError.message }, { status: 500 });
          const seen = new Set((alreadyMade ?? []).map((t) => t.cadence_key));
          const fresh = rows.filter((r) => !seen.has(r["cadence_key"] as string));

          if (fresh.length > 0) {
            const { data: inserted, error } = await supabaseAdmin
              .from("tasks")
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              .insert(fresh as any)
              .select("id, title, assignee, account_id, cadence_key");
            if (error) return Response.json({ error: error.message }, { status: 500 });
            created = inserted?.length ?? 0;

            const notifications = (inserted ?? [])
              .filter((t) => t.assignee)
              .map((t) => ({
                user_id: t.assignee!,
                type: t.cadence_key?.startsWith("annual")
                  ? ("account_meeting_due" as const)
                  : ("account_touch_overdue" as const),
                title: t.title,
                entity_type: "account",
                entity_id: t.account_id,
                href: "/tasks",
                priority: "normal" as const,
              }));
            if (notifications.length > 0) {
              await supabaseAdmin.from("notifications").insert(notifications);
            }
          }
        }

        // Tasks due today / already overdue.
        const { data: dueTasks } = await supabaseAdmin
          .from("tasks")
          .select("id, title, assignee, due_date")
          .in("status", ["open", "in_progress"])
          .not("assignee", "is", null)
          .lte("due_date", today);

        const dueNotifications = (dueTasks ?? []).map((t) => ({
          user_id: t.assignee!,
          type: (t.due_date === today ? "task_due_today" : "task_overdue") as
            "task_due_today" | "task_overdue",
          title: t.due_date === today ? `Task due today: ${t.title}` : `Task overdue: ${t.title}`,
          entity_type: "task",
          entity_id: t.id,
          href: "/tasks",
          priority: (t.due_date === today ? "normal" : "high") as "normal" | "high",
        }));
        if (dueNotifications.length > 0) {
          await supabaseAdmin.from("notifications").insert(dueNotifications);
        }

        // The Critical workflow: open an episode (recovery task, manager's
        // list, leaderboard exclusion) for every client the board would show
        // as Critical tonight, close the ones that have recovered, and remind
        // the managers of any day-30 decision still waiting.
        const { runCriticalSweep } = await import("@/lib/critical-sweep.server");
        const critical = await runCriticalSweep(supabaseAdmin, now);

        return Response.json({
          ok: true,
          cadence_tasks_created: created,
          due_task_notifications: dueNotifications.length,
          critical,
        });
      },
    },
  },
});
