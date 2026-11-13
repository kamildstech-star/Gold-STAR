/**
 * CallRail inbound webhook. Writes a `contact_attempts` row so the activity
 * dashboards can answer "did the rep actually call?" honestly.
 *
 * Auth: CallRail signs post-call webhooks with an HMAC-SHA1 of the raw body,
 * base64, in `signature`, keyed by the value configured on the webhook.
 * We accept that when CALLRAIL_WEBHOOK_SECRET is set; without the secret the
 * endpoint refuses everything (503) rather than accepting unsigned traffic.
 */
import { createFileRoute } from "@tanstack/react-router";
import { createHmac, timingSafeEqual } from "crypto";
import { z } from "zod";

const bodySchema = z.object({
  id: z.string().trim().min(1).max(128).optional(),
  call_id: z.string().trim().min(1).max(128).optional(),
  customer_phone_number: z.string().trim().max(40).optional(),
  tracking_phone_number: z.string().trim().max(40).optional(),
  direction: z.string().trim().max(20).optional(),
  duration: z.union([z.number(), z.string()]).optional(),
  recording: z.string().url().max(2000).optional(),
  answered: z.boolean().optional(),
  start_time: z.string().max(64).optional(),
  note: z.string().max(4000).optional(),
});

function digits(v: string | undefined | null): string {
  return (v ?? "").replace(/\D/g, "").slice(-10);
}

export const Route = createFileRoute("/api/public/hooks/callrail")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env.CALLRAIL_WEBHOOK_SECRET;
        if (!secret) {
          return Response.json(
            {
              error:
                "CALLRAIL_WEBHOOK_SECRET is not configured. Add it in Project Settings → Secrets and set the same value on the CallRail webhook.",
            },
            { status: 503 },
          );
        }

        const rawBody = await request.text();
        const provided = request.headers.get("signature") ?? "";
        const expected = createHmac("sha1", secret).update(rawBody).digest("base64");
        const a = Buffer.from(provided);
        const b = Buffer.from(expected);
        if (a.length !== b.length || !timingSafeEqual(a, b)) {
          return new Response("Invalid signature", { status: 401 });
        }

        /* After the credential check, never before: a database round trip per
           anonymous request would be the amplification the limiter exists to
           stop. Volumetric floods belong to Cloudflare WAF. */
        const { throttleWebhook } = await import("@/lib/rate-limit.server");
        const throttled = await throttleWebhook(request, "callrail");
        if (throttled) return throttled;

        let json: unknown;
        try {
          json = JSON.parse(rawBody);
        } catch {
          return Response.json({ error: "Invalid JSON" }, { status: 400 });
        }
        const parsed = bodySchema.safeParse(json);
        if (!parsed.success) {
          return Response.json(
            { error: "Validation failed", issues: parsed.error.issues },
            { status: 400 },
          );
        }
        const call = parsed.data;
        const externalId = call.id ?? call.call_id ?? null;

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        const phone = digits(call.customer_phone_number);
        const occurredAt = call.start_time
          ? new Date(call.start_time).toISOString()
          : new Date().toISOString();
        const durationSeconds =
          typeof call.duration === "string"
            ? Number.parseInt(call.duration, 10) || null
            : (call.duration ?? null);

        let matchedOn: string | null = null;
        let writeError: string | null = null;

        if (phone) {
          // Match on the last 10 digits of a known contact's number.
          const { data: contacts } = await supabaseAdmin
            .from("contacts")
            .select("id, account_id, phone")
            .not("phone", "is", null)
            .limit(5000);
          const hit = (contacts ?? []).find((c) => digits(c.phone) === phone);

          if (hit && hit.account_id) {
            matchedOn = `contact:${hit.id}`;
            // Relationship-sales calls belong on the account timeline.
            const { error } = await supabaseAdmin.from("touchpoints").insert({
              account_id: hit.account_id,
              contact_id: hit.id,
              type: "call",
              occurred_at: occurredAt,
              notes: [
                call.direction === "inbound" ? "Inbound call (CallRail)" : "Call (CallRail)",
                durationSeconds ? `${durationSeconds}s` : null,
                call.answered === false ? "not answered" : null,
                call.recording ? `Recording: ${call.recording}` : null,
                call.note ?? null,
              ]
                .filter(Boolean)
                .join(" · "),
            });
            writeError = error?.message ?? null;
          }
        }

        const event = {
          provider: "callrail" as const,
          event_type: "call.completed",
          external_id: externalId,
          payload: JSON.parse(rawBody),
          status: writeError ? "error" : matchedOn ? "processed" : "unmatched",
          error:
            writeError ??
            (matchedOn
              ? null
              : phone
                ? "No contact matches this phone number"
                : "No caller phone number supplied"),
        };

        // integration_events_dedupe is a PARTIAL index (external_id IS NOT NULL)
        // and Postgres will not infer an ON CONFLICT arbiter from one unless the
        // statement repeats the predicate, which PostgREST cannot emit. The
        // upsert this replaces failed 42P10, so CallRail saw a 500 on every
        // webhook and kept retrying. Look the replay up instead.
        const { data: prior } = externalId
          ? await supabaseAdmin
              .from("integration_events")
              .select("id")
              .eq("provider", "callrail")
              .eq("external_id", externalId)
              .maybeSingle()
          : { data: null };

        const { error: evErr } = prior
          ? await supabaseAdmin.from("integration_events").update(event).eq("id", prior.id)
          : await supabaseAdmin.from("integration_events").insert(event);
        if (evErr) {
          return Response.json({ error: evErr.message }, { status: 500 });
        }

        await supabaseAdmin
          .from("integration_connections")
          .update({
            last_event_at: new Date().toISOString(),
            status: "connected",
            last_error: null,
          })
          .eq("provider", "callrail");

        return Response.json({ ok: true, matched: matchedOn });
      },
    },
  },
});
