/**
 * Auto-capture ingestion. One endpoint for the dialer, the mailbox and the SMS
 * gateway, because they all answer the same question: did the activity actually
 * happen, and did anything come back?
 *
 * Two behaviours matter here:
 *  - Everything captured writes a touchpoint tagged with its source, so the
 *    activity cannot be self-reported into existence.
 *  - An inbound message marks the most recent outbound touchpoint on that
 *    account as replied, which is the only way an email or text starts
 *    counting toward cadence.
 *
 * Auth: HMAC-SHA256 of the raw body in `x-signature`, keyed by
 * AUTO_CAPTURE_WEBHOOK_SECRET. Without the secret the endpoint refuses traffic.
 */
import { createFileRoute } from "@tanstack/react-router";
import { createHmac, timingSafeEqual } from "crypto";
import { z } from "zod";

import { looksAutomated } from "@/lib/auto-reply";

const bodySchema = z.object({
  provider: z.string().trim().min(1).max(64),
  external_id: z.string().trim().min(1).max(200),
  channel: z.enum(["call", "email", "sms"]),
  direction: z.enum(["inbound", "outbound"]),
  occurred_at: z.string().max(64).optional(),
  duration_seconds: z.number().int().min(0).max(86_400).optional(),
  from_address: z.string().trim().max(320).optional(),
  to_address: z.string().trim().max(320).optional(),
  subject: z.string().trim().max(500).optional(),
  body_preview: z.string().trim().max(4000).optional(),
  outcome: z.string().trim().max(64).optional(),
  recording_url: z.string().url().max(2000).optional(),
  recording_consent_state: z.string().trim().length(2).optional(),
  account_id: z.string().uuid().optional(),
  contact_id: z.string().uuid().optional(),
  user_id: z.string().uuid().optional(),
});

function normalise(v: string | undefined): string {
  return (v ?? "").trim().toLowerCase();
}

export const Route = createFileRoute("/api/public/hooks/auto-capture")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env["AUTO_CAPTURE_WEBHOOK_SECRET"];
        if (!secret) {
          return Response.json(
            {
              error:
                "AUTO_CAPTURE_WEBHOOK_SECRET is not configured. Add it in Project Settings → Secrets and set the same value on the dialer, mailbox and SMS webhooks.",
            },
            { status: 503 },
          );
        }

        const raw = await request.text();
        const provided = request.headers.get("x-signature") ?? "";
        const expected = createHmac("sha256", secret).update(raw).digest("hex");
        const a = Buffer.from(provided);
        const b = Buffer.from(expected);
        if (a.length !== b.length || !timingSafeEqual(a, b)) {
          return new Response("Invalid signature", { status: 401 });
        }

        /* After the credential check, never before: a database round trip per
           anonymous request would be the amplification the limiter exists to
           stop. Volumetric floods belong to Cloudflare WAF. */
        const { throttleWebhook } = await import("@/lib/rate-limit.server");
        const throttled = await throttleWebhook(request, "auto-capture");
        if (throttled) return throttled;

        let json: unknown;
        try {
          json = JSON.parse(raw);
        } catch {
          return Response.json({ error: "Body is not valid JSON" }, { status: 400 });
        }
        const parsed = bodySchema.safeParse(json);
        if (!parsed.success) {
          return Response.json(
            { error: "Invalid payload", issues: parsed.error.issues.slice(0, 5) },
            { status: 400 },
          );
        }
        const e = parsed.data;
        const occurredAt = e.occurred_at ?? new Date().toISOString();

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        // Match the counterparty to a contact when the caller didn't.
        let contactId = e.contact_id ?? null;
        let accountId = e.account_id ?? null;
        if (!contactId) {
          const counterparty =
            e.direction === "inbound" ? normalise(e.from_address) : normalise(e.to_address);
          if (counterparty) {
            const column = e.channel === "email" ? "email" : "phone";
            const { data: matches } = await supabaseAdmin
              .from("contacts")
              .select("id, account_id, email, phone")
              .not(column, "is", null)
              .limit(500);
            const digitsOnly = counterparty.replace(/\D/g, "").slice(-10);
            const hit = (matches ?? []).find((c) =>
              e.channel === "email"
                ? normalise(c.email ?? undefined) === counterparty
                : (c.phone ?? "").replace(/\D/g, "").slice(-10) === digitsOnly,
            );
            if (hit) {
              contactId = hit.id;
              accountId = accountId ?? hit.account_id;
            }
          }
        }

        // An out-of-office is a machine, not the client answering. It is still
        // recorded, but it lands nothing and counts for nothing.
        const autoReply =
          e.direction === "inbound" &&
          e.channel !== "call" &&
          looksAutomated({ subject: e.subject ?? null, from: e.from_address ?? null });

        // Reply detection: an inbound message makes the last outbound touch land.
        let repliedTouchpoint: string | null = null;
        if (e.direction === "inbound" && accountId && !autoReply) {
          const { data: lastOutbound } = await supabaseAdmin
            .from("touchpoints")
            .select("id")
            .eq("account_id", accountId)
            .eq("direction", "outbound")
            .is("replied_at", null)
            .order("occurred_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          if (lastOutbound) {
            await supabaseAdmin
              .from("touchpoints")
              .update({ replied_at: occurredAt })
              .eq("id", lastOutbound.id);
            repliedTouchpoint = lastOutbound.id;
          }
        }

        // Write the touchpoint for this event itself.
        let touchpointId: string | null = null;
        if (accountId) {
          // A gateway text is the method "text", one of the six in the outreach
          // standard. It was written as "other", which the standard does not count.
          const type = e.channel === "call" ? "call" : e.channel === "email" ? "email" : "text";
          const { data: tp } = await supabaseAdmin
            .from("touchpoints")
            .insert({
              account_id: accountId,
              contact_id: contactId,
              type,
              occurred_at: occurredAt,
              notes: e.subject ?? e.body_preview ?? null,
              created_by: e.user_id ?? null,
              capture_source:
                e.channel === "call" ? "dialer" : e.channel === "email" ? "mailbox" : "sms",
              direction: e.direction,
              duration_seconds: e.duration_seconds ?? null,
              external_ref: `${e.provider}:${e.external_id}`,
              is_auto_reply: autoReply,
            })
            .select("id")
            .single();
          touchpointId = tp?.id ?? null;
        }

        const { error } = await supabaseAdmin.from("captured_communications").upsert(
          {
            provider: e.provider,
            external_id: e.external_id,
            channel: e.channel,
            direction: e.direction,
            occurred_at: occurredAt,
            duration_seconds: e.duration_seconds ?? null,
            from_address: e.from_address ?? null,
            to_address: e.to_address ?? null,
            subject: e.subject ?? null,
            body_preview: e.body_preview ?? null,
            outcome: e.outcome ?? null,
            recording_url: e.recording_url ?? null,
            recording_consent_state: e.recording_consent_state ?? null,
            account_id: accountId,
            contact_id: contactId,
            user_id: e.user_id ?? null,
            touchpoint_id: touchpointId,
            raw: json as never,
          },
          { onConflict: "provider,external_id" },
        );
        if (error) {
          return Response.json({ error: error.message }, { status: 500 });
        }

        return Response.json({
          ok: true,
          matched_account: accountId,
          matched_contact: contactId,
          touchpoint_id: touchpointId,
          marked_replied: repliedTouchpoint,
        });
      },
    },
  },
});
