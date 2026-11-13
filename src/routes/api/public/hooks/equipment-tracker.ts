import { createFileRoute } from "@tanstack/react-router";
import { createHmac, timingSafeEqual } from "crypto";
import { z } from "zod";

// Equipment tracker ingest. Deliberately provider-agnostic: Kai (or any other
// tag vendor) POSTs positions here and nothing else in the app cares where the
// data came from. We do NOT build GPS tracking in-house — this is the seam.
//
// Auth: HMAC-SHA256 of the raw request body, hex, in `x-tracker-signature`,
// keyed by EQUIPMENT_TRACKER_WEBHOOK_SECRET. Timing-safe compare.

const eventSchema = z.object({
  tracker_id: z.string().trim().min(1).max(128),
  occurred_at: z.string().datetime(),
  lat: z.number().gte(-90).lte(90).optional(),
  lon: z.number().gte(-180).lte(180).optional(),
  battery_pct: z.number().int().gte(0).lte(100).optional(),
});

const bodySchema = z.object({
  provider: z.string().trim().min(1).max(32).default("kai"),
  events: z.array(eventSchema).min(1).max(500),
});

export const Route = createFileRoute("/api/public/hooks/equipment-tracker")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env.EQUIPMENT_TRACKER_WEBHOOK_SECRET;
        if (!secret) {
          return Response.json(
            {
              error:
                "EQUIPMENT_TRACKER_WEBHOOK_SECRET is not configured. Add it in Project Settings → Secrets before wiring a tracker provider.",
            },
            { status: 503 },
          );
        }

        const rawBody = await request.text();
        const signature = request.headers.get("x-tracker-signature") ?? "";
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
        const throttled = await throttleWebhook(request, "equipment-tracker");
        if (throttled) return throttled;

        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(rawBody);
        } catch {
          return Response.json({ error: "Invalid JSON" }, { status: 400 });
        }

        const parsed = bodySchema.safeParse(parsedJson);
        if (!parsed.success) {
          return Response.json(
            { error: "Validation failed", issues: parsed.error.issues },
            { status: 400 },
          );
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { provider, events } = parsed.data;

        // Resolve tracker ids to equipment rows so the alerts can join cheaply.
        const trackerIds = Array.from(new Set(events.map((e) => e.tracker_id)));
        const { data: equipment, error: eqErr } = await supabaseAdmin
          .from("equipment")
          .select("id, external_tracker_id")
          .in("external_tracker_id", trackerIds);
        if (eqErr) {
          console.error("Tracker webhook equipment lookup failed", eqErr);
          return Response.json({ error: "Lookup failed" }, { status: 500 });
        }
        const byTracker = new Map(
          (equipment ?? [])
            .filter((e) => e.external_tracker_id)
            .map((e) => [e.external_tracker_id as string, e.id] as const),
        );

        const rows = events.map((e) => ({
          provider,
          tracker_id: e.tracker_id,
          equipment_id: byTracker.get(e.tracker_id) ?? null,
          occurred_at: e.occurred_at,
          lat: e.lat ?? null,
          lon: e.lon ?? null,
          battery_pct: e.battery_pct ?? null,
          raw: e as never,
        }));

        const { error } = await supabaseAdmin.from("equipment_tracker_events").upsert(rows, {
          onConflict: "provider,tracker_id,occurred_at",
          ignoreDuplicates: true,
        });

        if (error) {
          console.error("Tracker webhook insert failed", error);
          return Response.json({ error: "Insert failed", detail: error.message }, { status: 500 });
        }

        const unmatched = trackerIds.filter((t) => !byTracker.has(t));
        return Response.json({
          ok: true,
          accepted: rows.length,
          unmatched_tracker_ids: unmatched,
        });
      },
    },
  },
});
