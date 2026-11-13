import { createFileRoute } from "@tanstack/react-router";

import { denyUnlessCron } from "@/lib/cron-auth";

/**
 * Chase escalation sweep. Advances every unclaimed incident through the tiers
 * — primary zone, adjacent zones, whole market, then admin — and releases
 * locks that went stale past ETA. Empty tiers are skipped, never looped, so a
 * single-chaser market lands on admin instead of spinning.
 *
 * Intended to run every 30s–60s from pg_cron.
 * Auth: the `x-cron-secret` shared secret, compared in constant time by
 * denyUnlessCron (src/lib/cron-auth.ts). It fails closed when CRON_SECRET
 * is unset. The publishable key this once accepted is not a secret.
 */
export const Route = createFileRoute("/api/public/hooks/chase-escalation")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const denied = denyUnlessCron(request);
        if (denied) return denied;

        /* After the credential check, never before: a database round trip per
           anonymous request would be the amplification the limiter exists to
           stop. Volumetric floods belong to Cloudflare WAF. */
        const { throttleWebhook } = await import("@/lib/rate-limit.server");
        const throttled = await throttleWebhook(request, "chase-escalation", true);
        if (throttled) return throttled;

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data, error } = await supabaseAdmin.rpc("escalate_incidents");
        if (error) return Response.json({ error: error.message }, { status: 500 });
        // An alert nobody answered in 24h is its own state — no_action, not a
        // decline. Cheap enough to sweep on the same tick.
        const { data: expired } = await supabaseAdmin.rpc("expire_stale_dispatches");
        return Response.json({ ok: true, result: data, expired_dispatches: expired ?? 0 });
      },
    },
  },
});
