/**
 * Microsoft Graph (Outlook) change-notification endpoint.
 *
 * Graph validates a subscription by calling with a `validationToken` query
 * param that must be echoed back as text/plain, then POSTs notifications
 * carrying the `clientState` set at subscription time — compared here against
 * OUTLOOK_WEBHOOK_CLIENT_STATE.
 *
 * That value may be typed on the admin Integrations screen rather than set as
 * a deployment secret, so it is read through loadOutlookEnv, which takes the
 * stored value over process.env. Reading it is a database round trip, but a
 * bounded one: only a well-formed notification batch in which every item
 * carries a clientState gets that far, and the credential store caches a
 * successful read for a minute, so a flood costs one read a minute per
 * isolate, not one per request.
 *
 * Push is for freshness only. Every notification is also recorded as an
 * integration event, and the scheduled delta reconciliation
 * (/api/public/hooks/graph-sync) is what guarantees correctness when a
 * notification is dropped.
 */
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const notificationSchema = z.object({
  value: z
    .array(
      z.object({
        subscriptionId: z.string().max(200).optional(),
        clientState: z.string().max(400).optional(),
        changeType: z.string().max(40).optional(),
        resource: z.string().max(600).optional(),
        resourceData: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .min(1)
    .max(200),
});

function validationResponse(url: URL): Response | null {
  const token = url.searchParams.get("validationToken");
  if (!token) return null;
  return new Response(token, {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
}

export const Route = createFileRoute("/api/public/hooks/outlook")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const res = validationResponse(new URL(request.url));
        return res ?? new Response("Missing validationToken", { status: 400 });
      },
      POST: async ({ request }) => {
        const url = new URL(request.url);
        const validation = validationResponse(url);
        // Deliberately before the throttle. Microsoft Graph expects the
        // validation token echoed within seconds and tears the subscription
        // down if it is not — a 429 here would silently kill mailbox sync.
        if (validation) return validation;

        const rawBody = await request.text();
        let json: unknown;
        try {
          json = JSON.parse(rawBody);
        } catch {
          return Response.json({ error: "Invalid JSON" }, { status: 400 });
        }
        const parsed = notificationSchema.safeParse(json);
        if (!parsed.success) {
          return Response.json(
            { error: "Validation failed", issues: parsed.error.issues },
            { status: 400 },
          );
        }
        // A notification without a clientState can never match; refused before
        // the expected value is even looked up.
        if (parsed.data.value.some((n) => !n.clientState)) {
          return new Response("Invalid clientState", { status: 401 });
        }

        const { loadOutlookEnv } = await import("@/lib/microsoft-delegated.server");
        const env = await loadOutlookEnv();
        const clientState = env["OUTLOOK_WEBHOOK_CLIENT_STATE"];
        if (!clientState) {
          return Response.json(
            {
              error:
                "OUTLOOK_WEBHOOK_CLIENT_STATE is not configured. Add it on the Integrations screen (Outlook) or in Project Settings → Secrets, and use the same value when creating the Graph subscription.",
            },
            { status: 503 },
          );
        }

        const bad = parsed.data.value.find((n) => n.clientState !== clientState);
        if (bad) return new Response("Invalid clientState", { status: 401 });

        /* After the credential check, never before: a database round trip per
           anonymous request would be the amplification the limiter exists to
           stop. Volumetric floods belong to Cloudflare WAF. */
        const { throttleWebhook } = await import("@/lib/rate-limit.server");
        const throttled = await throttleWebhook(request, "outlook");
        if (throttled) return throttled;

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { graphConfigured } = await import("@/lib/graph.server");
        const hasGraphCreds = graphConfigured();

        const rows = parsed.data.value.map((n) => ({
          provider: "outlook" as const,
          event_type: `graph.${n.changeType ?? "changed"}`,
          external_id:
            (n.resourceData?.["id"] as string | undefined) ??
            `${n.subscriptionId ?? "sub"}:${Date.now()}:${Math.random()}`,
          payload: n as unknown as Record<string, never>,
          status: hasGraphCreds ? "processed" : "pending",
          error: hasGraphCreds
            ? null
            : "Graph app credentials not configured — notification stored but not fetched.",
        }));

        // integration_events_dedupe is a PARTIAL index (external_id IS NOT NULL)
        // and Postgres will not infer an ON CONFLICT arbiter from one unless the
        // statement repeats the predicate, which PostgREST cannot emit. The
        // upsert this replaces failed 42P10, so no notification was ever logged.
        const { data: prior } = await supabaseAdmin
          .from("integration_events")
          .select("id, external_id")
          .eq("provider", "outlook")
          .in(
            "external_id",
            rows.map((r) => r.external_id),
          );
        const priorId = new Map((prior ?? []).map((e) => [e.external_id, e.id]));

        const fresh = rows.filter((r) => !priorId.has(r.external_id));
        if (fresh.length > 0) {
          await supabaseAdmin.from("integration_events").insert(fresh);
        }
        // Graph redelivers; the replay still carries the newer status.
        for (const r of rows) {
          const id = priorId.get(r.external_id);
          if (id) await supabaseAdmin.from("integration_events").update(r).eq("id", id);
        }

        let processed = 0;
        let lastError: string | null = null;

        if (hasGraphCreds) {
          const { processNotification } = await import("@/lib/graph-sync.server");
          for (const n of parsed.data.value) {
            try {
              await processNotification({
                subscriptionId: n.subscriptionId,
                resource: n.resource,
                resourceId: n.resourceData?.["id"] as string | undefined,
                changeType: n.changeType,
              });
              processed += 1;
            } catch (e) {
              lastError = (e as Error).message;
              console.error("[outlook] notification processing failed:", lastError);
            }
          }
        }

        await supabaseAdmin
          .from("integration_connections")
          .update({
            last_event_at: new Date().toISOString(),
            status: hasGraphCreds && !lastError ? "connected" : "error",
            last_error: hasGraphCreds
              ? lastError
              : "Receiving notifications but Graph app credentials are missing.",
          })
          .eq("provider", "outlook");

        console.log(
          `[outlook] ${parsed.data.value.length} notification(s), ${processed} processed`,
        );

        // Graph requires a fast 202.
        return new Response(null, { status: 202 });
      },
    },
  },
});
