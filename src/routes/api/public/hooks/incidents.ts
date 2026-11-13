import { createFileRoute } from "@tanstack/react-router";
import { createHmac, timingSafeEqual } from "crypto";

import { incidentPayloadSchema } from "@/lib/incident-payload";

// External incident webhook. Intentionally source-agnostic:
// any adapter (Android-emulator scraper, scanner transcriber, partner feed)
// can POST here without touching the rest of the app.
//
// Auth: HMAC-SHA256 of the raw request body, hex, in the `x-incident-signature`
// header, using INCIDENT_WEBHOOK_SECRET. Timing-safe compare.
//
// Body shape — every field validated by `incidentPayloadSchema`
// (src/lib/incident-payload.ts). Either `address` OR (`lat`,`lon`) required.
// The insert itself is `ingestIncident` (src/lib/incident-ingest.server.ts),
// shared with the fire feed so both land leads exactly the same way.

export const Route = createFileRoute("/api/public/hooks/incidents")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env.INCIDENT_WEBHOOK_SECRET;
        if (!secret) {
          // Deliberate 503 rather than 500 — makes it clear the endpoint
          // is deployed but the operator hasn't wired a source yet.
          return Response.json(
            {
              error:
                "INCIDENT_WEBHOOK_SECRET is not configured. Add it in Project Settings → Secrets before wiring a source.",
            },
            { status: 503 },
          );
        }

        const rawBody = await request.text();
        const signature = request.headers.get("x-incident-signature") ?? "";
        const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
        const sig = Buffer.from(signature);
        const exp = Buffer.from(expected);
        if (sig.length !== exp.length || !timingSafeEqual(sig, exp)) {
          return new Response("Invalid signature", { status: 401 });
        }

        /* After the credential check, never before: a database round trip per
           anonymous request would be the amplification the limiter exists to
           stop. Volumetric floods belong to Cloudflare WAF. */
        const { throttleWebhook } = await import("@/lib/rate-limit.server");
        const throttled = await throttleWebhook(request, "incidents");
        if (throttled) return throttled;

        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(rawBody);
        } catch {
          return Response.json({ error: "Invalid JSON" }, { status: 400 });
        }

        const parsed = incidentPayloadSchema.safeParse(parsedJson);
        if (!parsed.success) {
          return Response.json(
            { error: "Validation failed", issues: parsed.error.issues },
            { status: 400 },
          );
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { ingestIncident } = await import("@/lib/incident-ingest.server");

        const result = await ingestIncident(supabaseAdmin as never, parsed.data);
        if (!result.ok) {
          console.error("Incident webhook insert failed", result.error);
          return Response.json({ error: "Insert failed", detail: result.error }, { status: 500 });
        }

        return Response.json({ ok: true, incident: result.incident });
      },
    },
  },
});
