import { createFileRoute } from "@tanstack/react-router";

import { denyUnlessCron } from "@/lib/cron-auth";
import type { TriggerType } from "@/lib/automation";

/**
 * Automation evaluator endpoint.
 *
 *  - pg_cron calls it every 15 minutes with an empty body (all active rules).
 *  - Database triggers call it with { "triggers": [...] } the moment a
 *    relevant record is written, so event-shaped rules (stage enter/leave,
 *    deal created/won/lost, task past due) fire immediately instead of
 *    waiting for the next sweep.
 *
 * Auth: the `x-cron-secret` shared secret, compared in constant time by
 * denyUnlessCron (src/lib/cron-auth.ts). It fails closed when CRON_SECRET
 * is unset. The publishable key this once accepted is not a secret.
 * Every execution writes an automation_runs row per rule, so a firing can
 * always be proven.
 */

const VALID_TRIGGERS: TriggerType[] = [
  "stage_enter",
  "stage_leave",
  "stage_rot",
  "task_past_due",
  "no_activity",
  "date_reached",
  "deal_created",
  "deal_won",
  "deal_lost",
  // Job rules (20260926121000). Also evaluated by the empty-body sweep.
  "job_stage_age",
];

export const Route = createFileRoute("/api/public/hooks/run-automations")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const denied = denyUnlessCron(request);
        if (denied) return denied;

        /* After the credential check, never before: a database round trip per
           anonymous request would be the amplification the limiter exists to
           stop. Volumetric floods belong to Cloudflare WAF. */
        const { throttleWebhook } = await import("@/lib/rate-limit.server");
        const throttled = await throttleWebhook(request, "run-automations", true);
        if (throttled) return throttled;

        let triggers: TriggerType[] | undefined;
        try {
          const body = (await request.json()) as { triggers?: string[] } | null;
          const raw = body?.triggers;
          if (Array.isArray(raw)) {
            triggers = raw.filter((t): t is TriggerType =>
              VALID_TRIGGERS.includes(t as TriggerType),
            );
          }
        } catch {
          triggers = undefined;
        }

        try {
          const { runAutomationEngine } = await import("@/lib/automation-engine.server");
          const result = await runAutomationEngine({
            triggerTypes: triggers?.length ? triggers : undefined,
            triggeredBy: null,
          });
          // The coaching sweep only makes sense on the full scheduled pass;
          // event-driven calls target a single trigger and shouldn't re-scan.
          let coaching: unknown = null;
          let badges = 0;
          if (!triggers?.length) {
            const { runRepCoachingSweep } = await import("@/lib/rep-nudges.server");
            coaching = await runRepCoachingSweep();
            // Badges are earned off real results, never awarded by hand.
            const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
            const { data: awarded } = await supabaseAdmin.rpc("award_achievements");
            badges = awarded ?? 0;
          }
          // Automated invoice follow-ups (22 Oct): on the full scheduled pass
          // only. Reported, never thrown — a broken reminder run must not hide
          // that the rules above ran.
          let invoiceFollowups: unknown = null;
          if (!triggers?.length) {
            try {
              const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
              const { runInvoiceFollowupSweep } = await import("@/lib/invoice-followups.server");
              invoiceFollowups = await runInvoiceFollowupSweep(supabaseAdmin);
            } catch (e) {
              invoiceFollowups = { error: e instanceof Error ? e.message : String(e) };
            }
          }
          return Response.json({ ok: true, ...result, coaching, badges, invoiceFollowups });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return Response.json({ ok: false, error: message }, { status: 500 });
        }
      },
    },
  },
});
