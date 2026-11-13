import { createFileRoute } from "@tanstack/react-router";

import { denyUnlessCron } from "@/lib/cron-auth";

/**
 * Raven outbound poller, driven by pg_cron.
 *
 * positions: every 5 minutes. (There is no trips route in the Raven API.)
 * Auth: the `x-cron-secret` shared secret, compared in constant time by
 * denyUnlessCron (src/lib/cron-auth.ts). It fails closed when CRON_SECRET
 * is unset. The publishable key this once accepted is not a secret.
 */
export const Route = createFileRoute("/api/public/hooks/raven-sync")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const denied = denyUnlessCron(request);
        if (denied) return denied;

        /* After the credential check, never before: a database round trip per
           anonymous request would be the amplification the limiter exists to
           stop. Volumetric floods belong to Cloudflare WAF. */
        const { throttleWebhook } = await import("@/lib/rate-limit.server");
        const throttled = await throttleWebhook(request, "raven-sync", true);
        if (throttled) return throttled;

        let mode: "positions" | "probe" = "positions";
        try {
          const body = (await request.json()) as { mode?: string };
          if (body?.mode === "probe") mode = "probe";
        } catch {
          /* default to positions */
        }

        const { syncRavenPositions, probeRaven } = await import("@/lib/raven-sync.server");
        if (mode === "probe") {
          const probe = await probeRaven();
          return Response.json(probe, { status: probe.authOk ? 200 : 502 });
        }
        const report = await syncRavenPositions();
        return Response.json(report, { status: report.ok ? 200 : 502 });
      },
    },
  },
});
