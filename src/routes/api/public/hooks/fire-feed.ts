import { createFileRoute } from "@tanstack/react-router";

import { denyUnlessCron } from "@/lib/cron-auth";

/**
 * The fire feed's scheduled run — Gold Star's own replacement for BNN.
 *
 * Mark: "we need to make a feed that crawls google and x for fires in certain
 * areas and gathers those and can implement it into the program in place of
 * bnn", then "I don't want to pay API fees." So the sources are free and
 * sanctioned (Google News RSS, RSS/Atom feeds, and public incident pages),
 * and every lead lands through `ingestIncident` — the insert the BNN webhook
 * uses — so the chase deck, assignment, escalation, the cockpit map and the
 * reports treat it exactly like any other alert.
 *
 * pg_cron calls `fire_feed_kick()` every two minutes; the kick posts here
 * only when the feed is switched on, an area is active and a source is due
 * (migration 20261011140000). This handler checks all of that again, so a
 * stray call is a cheap no-op. The work is in src/lib/fire-feed/run.server.ts.
 *
 * Auth: the `x-cron-secret` shared secret, compared in constant time by
 * denyUnlessCron (src/lib/cron-auth.ts). It fails closed when CRON_SECRET is
 * unset.
 */
export const Route = createFileRoute("/api/public/hooks/fire-feed")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const denied = denyUnlessCron(request);
        if (denied) return denied;

        /* After the credential check, never before: a database round trip per
           anonymous request would be the amplification the limiter exists to
           stop. Volumetric floods belong to Cloudflare WAF. */
        const { throttleWebhook } = await import("@/lib/rate-limit.server");
        const throttled = await throttleWebhook(request, "fire-feed", true);
        if (throttled) return throttled;

        const { runFireFeedWithDefaults } = await import("@/lib/fire-feed/run-defaults.server");
        const summary = await runFireFeedWithDefaults({ trigger: "cron" });
        const { decisions: _decisions, ...body } = summary;
        // 502 only when the run itself failed, so pg_net's response log shows
        // a broken feed without reading every body.
        return Response.json(body, { status: summary.status === "failed" ? 502 : 200 });
      },
    },
  },
});
