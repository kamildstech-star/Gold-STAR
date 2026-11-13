import { createFileRoute } from "@tanstack/react-router";

import { denyUnlessCron } from "@/lib/cron-auth";

/**
 * Kahi equipment poller, driven by pg_cron every 15 minutes.
 * Auth: the `x-cron-secret` shared secret, compared in constant time by
 * denyUnlessCron (src/lib/cron-auth.ts). It fails closed when CRON_SECRET
 * is unset. The publishable key this once accepted is not a secret.
 */
export const Route = createFileRoute("/api/public/hooks/kahi-sync")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const denied = denyUnlessCron(request);
        if (denied) return denied;

        /* After the credential check, never before: a database round trip per
           anonymous request would be the amplification the limiter exists to
           stop. Volumetric floods belong to Cloudflare WAF. */
        const { throttleWebhook } = await import("@/lib/rate-limit.server");
        const throttled = await throttleWebhook(request, "kahi-sync", true);
        if (throttled) return throttled;

        const { syncKahiEquipment } = await import("@/lib/kahi-sync.server");
        const { kahiSyncHttpStatus } = await import("@/lib/kahi-equipment-save.server");
        const report = await syncKahiEquipment();
        // 200 with ok:false, partial:true when a few assets were refused;
        // 502 only when the run achieved nothing (kahiSyncHttpStatus).
        return Response.json(report, { status: kahiSyncHttpStatus(report) });
      },
    },
  },
});
