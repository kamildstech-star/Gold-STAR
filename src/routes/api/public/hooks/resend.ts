/**
 * Resend delivery webhook. Writes one `email_events` row per callback so every
 * sent email has a trail: sent -> delivered -> opened, with times and recipient.
 *
 * Auth: Resend signs with Svix. The scheme is
 *   signature = base64(HMAC_SHA256(secret, `${svix-id}.${svix-timestamp}.${raw body}`))
 * where `secret` is the `whsec_`-prefixed value base64-decoded to raw bytes, and
 * the `svix-signature` header is a space-separated list of `v1,<sig>` (more than
 * one during a secret rotation, so any match passes). We reject a stale
 * timestamp too — a valid signature replayed a day later is still a replay.
 *
 * Implemented on WebCrypto rather than the Svix SDK because this runs on
 * Cloudflare Workers. Without RESEND_WEBHOOK_SECRET the route refuses
 * everything (503); an unauthenticated public endpoint that writes to the
 * database is not something to leave open.
 */
import { createFileRoute } from "@tanstack/react-router";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

/** Svix's own tolerance. Anything older is a replay, not a retry. */
const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

const bodySchema = z.object({
  type: z.string().trim().min(1).max(64),
  created_at: z.string().max(64).optional(),
  data: z
    .object({
      email_id: z.string().trim().max(128).optional(),
      to: z.union([z.string(), z.array(z.string())]).optional(),
      from: z.string().max(320).optional(),
      subject: z.string().max(1000).optional(),
      created_at: z.string().max(64).optional(),
      open: z
        .object({ timestamp: z.string().max(64).optional() })
        .partial()
        .passthrough()
        .optional(),
      click: z
        .object({ timestamp: z.string().max(64).optional() })
        .partial()
        .passthrough()
        .optional(),
    })
    .passthrough(),
});

function base64ToBytes(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function bytesToBase64(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Compare without leaking where the mismatch is. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function svixSignatureMatches(
  secret: string,
  svixId: string,
  svixTimestamp: string,
  rawBody: string,
  header: string,
): Promise<boolean> {
  // Svix secrets are transported as `whsec_<base64>`; the HMAC key is the
  // decoded bytes, not the printable string.
  const keyMaterial = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  let keyBytes: ArrayBuffer;
  try {
    keyBytes = base64ToBytes(keyMaterial);
  } catch {
    return false;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${svixId}.${svixTimestamp}.${rawBody}`),
  );
  const expected = bytesToBase64(signed);

  // "v1,<sig> v1,<sig>" — several are present while a secret is being rotated.
  return header
    .split(" ")
    .filter((part) => part.startsWith("v1,"))
    .some((part) => timingSafeEqual(part.slice(3), expected));
}

/** Resend sends `to` as an array, but a single string on some event types. */
function firstRecipient(to: string | string[] | undefined): string | null {
  if (!to) return null;
  const value = Array.isArray(to) ? to[0] : to;
  return value?.trim() || null;
}

function isoOrNull(value: string | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export const Route = createFileRoute("/api/public/hooks/resend")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env["RESEND_WEBHOOK_SECRET"];
        if (!secret) {
          return Response.json(
            {
              error:
                "RESEND_WEBHOOK_SECRET is not configured. Add it in Project Settings → Secrets using the signing secret shown on the Resend webhook.",
            },
            { status: 503 },
          );
        }

        // Standard Webhooks allows either header prefix; Resend uses `svix-`.
        const h = request.headers;
        const svixId = h.get("svix-id") ?? h.get("webhook-id") ?? "";
        const svixTimestamp = h.get("svix-timestamp") ?? h.get("webhook-timestamp") ?? "";
        const svixSignature = h.get("svix-signature") ?? h.get("webhook-signature") ?? "";
        if (!svixId || !svixTimestamp || !svixSignature) {
          return new Response("Missing signature headers", { status: 401 });
        }

        const sentAtSeconds = Number.parseInt(svixTimestamp, 10);
        if (
          !Number.isFinite(sentAtSeconds) ||
          Math.abs(Date.now() / 1000 - sentAtSeconds) > TIMESTAMP_TOLERANCE_SECONDS
        ) {
          return new Response("Stale timestamp", { status: 401 });
        }

        const rawBody = await request.text();
        if (!(await svixSignatureMatches(secret, svixId, svixTimestamp, rawBody, svixSignature))) {
          return new Response("Invalid signature", { status: 401 });
        }

        /* After the credential check, never before: a database round trip per
           anonymous request would be the amplification the limiter exists to
           stop. Volumetric floods belong to Cloudflare WAF. */
        const { throttleWebhook } = await import("@/lib/rate-limit.server");
        const throttled = await throttleWebhook(request, "resend");
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
        const event = parsed.data;

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        // email_events postdates the generated Supabase types; reach it through
        // an untyped view rather than hand-editing generated output.
        const db = supabaseAdmin as unknown as SupabaseClient;

        const providerMessageId = event.data.email_id ?? null;
        let emailMessageId: string | null = null;
        if (providerMessageId) {
          const { data: match } = await db
            .from("email_messages")
            .select("id")
            .eq("provider_id", providerMessageId)
            .maybeSingle();
          emailMessageId = match?.id ?? null;
        }

        // Prefer the timestamp on the event itself; opens and clicks carry the
        // moment the pixel/link was hit, which is not when Resend told us.
        const occurredAt =
          isoOrNull(event.data.open?.timestamp as string | undefined) ??
          isoOrNull(event.data.click?.timestamp as string | undefined) ??
          isoOrNull(event.created_at) ??
          isoOrNull(event.data.created_at) ??
          new Date().toISOString();

        const { error: insertError } = await db.from("email_events").upsert(
          {
            email_message_id: emailMessageId,
            provider: "resend",
            provider_message_id: providerMessageId,
            provider_event_id: svixId,
            event_type: event.type,
            recipient: firstRecipient(event.data.to as string | string[] | undefined),
            occurred_at: occurredAt,
            payload: JSON.parse(rawBody),
          },
          { onConflict: "provider,provider_event_id", ignoreDuplicates: true },
        );
        if (insertError) {
          // 500 so Svix retries — the UNIQUE constraint makes that safe.
          return Response.json({ error: insertError.message }, { status: 500 });
        }

        // Mirror the milestones onto the message so lists can show status
        // without joining the trail. Opens set only `opened_at`, never
        // status='opened': an open is a prefetched image at least as often as
        // it is a person, and "Delivered" is the last thing we actually know.
        if (emailMessageId) {
          if (event.type === "email.opened") {
            // First open only. Later opens are almost always the same pixel
            // being refetched, and overwriting would make the column drift
            // forward forever.
            await db
              .from("email_messages")
              .update({ opened_at: occurredAt })
              .eq("id", emailMessageId)
              .is("opened_at", null);
          } else if (event.type === "email.delivered") {
            await db
              .from("email_messages")
              .update({ delivered_at: occurredAt, status: "delivered" })
              .eq("id", emailMessageId);
          } else if (event.type === "email.bounced") {
            await db
              .from("email_messages")
              .update({ bounced_at: occurredAt, status: "bounced" })
              .eq("id", emailMessageId);
          }
        }

        return Response.json({ ok: true, matched: Boolean(emailMessageId) });
      },
    },
  },
});
