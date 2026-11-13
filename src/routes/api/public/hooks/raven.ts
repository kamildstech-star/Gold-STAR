/**
 * Raven fleet ingest. Raven pushes vehicle telemetry here; we keep the
 * latest position on `vehicles` for the chase map and append history to
 * `vehicle_positions` for trip review against clock-in events.
 *
 * Auth: HMAC-SHA256 of the raw body, hex, in `x-raven-signature`, keyed by
 * RAVEN_WEBHOOK_SECRET. No secret configured = endpoint refuses traffic.
 */
import { createFileRoute } from "@tanstack/react-router";
import { createHmac, timingSafeEqual } from "crypto";
import { z } from "zod";

const positionSchema = z.object({
  vehicle_id: z.string().trim().min(1).max(128),
  vehicle_label: z.string().trim().max(120).optional(),
  occurred_at: z.string().datetime(),
  lat: z.number().gte(-90).lte(90),
  lon: z.number().gte(-180).lte(180),
  speed_mph: z.number().gte(0).lte(200).optional(),
  heading: z.number().gte(0).lt(360).optional(),
  ignition: z.boolean().optional(),
});

const bodySchema = z.object({
  positions: z.array(positionSchema).min(1).max(500),
});

export const Route = createFileRoute("/api/public/hooks/raven")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env.RAVEN_WEBHOOK_SECRET;
        if (!secret) {
          return Response.json(
            {
              error:
                "RAVEN_WEBHOOK_SECRET is not configured. Add it in Project Settings → Secrets before wiring Raven.",
            },
            { status: 503 },
          );
        }

        const rawBody = await request.text();
        const provided = request.headers.get("x-raven-signature") ?? "";
        const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
        const a = Buffer.from(provided);
        const b = Buffer.from(expected);
        if (a.length !== b.length || !timingSafeEqual(a, b)) {
          return new Response("Invalid signature", { status: 401 });
        }

        /* After the credential check, never before: a database round trip per
           anonymous request would be the amplification the limiter exists to
           stop. Volumetric floods belong to Cloudflare WAF. */
        const { throttleWebhook } = await import("@/lib/rate-limit.server");
        const throttled = await throttleWebhook(request, "raven");
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

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { positions } = parsed.data;

        // Upsert the vehicle registry first so positions always have a parent.
        const byVehicle = new Map<string, typeof positions>();
        for (const p of positions) {
          const list = byVehicle.get(p.vehicle_id) ?? [];
          list.push(p);
          byVehicle.set(p.vehicle_id, list);
        }

        const { data: vehicles, error: vErr } = await supabaseAdmin
          .from("vehicles")
          .upsert(
            Array.from(byVehicle.entries()).map(([externalId, list]) => {
              const latest = list.reduce((a, b) => (a.occurred_at > b.occurred_at ? a : b));
              return {
                provider: "raven" as const,
                external_id: externalId,
                label: latest.vehicle_label ?? externalId,
                last_lat: latest.lat,
                last_lon: latest.lon,
                last_position_at: latest.occurred_at,
                ignition: latest.ignition ?? null,
                updated_at: new Date().toISOString(),
              };
            }),
            { onConflict: "provider,external_id" },
          )
          .select("id, external_id");
        if (vErr) {
          return Response.json({ error: vErr.message }, { status: 500 });
        }

        const idByExternal = new Map((vehicles ?? []).map((v) => [v.external_id, v.id]));

        const rows = positions
          .map((p) => {
            const vehicleId = idByExternal.get(p.vehicle_id);
            if (!vehicleId) return null;
            return {
              vehicle_id: vehicleId,
              occurred_at: p.occurred_at,
              lat: p.lat,
              lon: p.lon,
              speed_mph: p.speed_mph ?? null,
              heading: p.heading ?? null,
              ignition: p.ignition ?? null,
            };
          })
          .filter((r): r is NonNullable<typeof r> => r !== null);

        const { error: pErr } = await supabaseAdmin
          .from("vehicle_positions")
          .upsert(rows, { onConflict: "vehicle_id,occurred_at" });
        if (pErr) {
          return Response.json({ error: pErr.message }, { status: 500 });
        }

        await supabaseAdmin.from("integration_events").insert({
          provider: "raven",
          event_type: "positions.batch",
          payload: { count: rows.length, vehicles: byVehicle.size },
          status: "processed",
        });

        await supabaseAdmin
          .from("integration_connections")
          .update({
            last_event_at: new Date().toISOString(),
            last_sync_at: new Date().toISOString(),
            status: "connected",
            last_error: null,
          })
          .eq("provider", "raven");

        return Response.json({ ok: true, positions: rows.length });
      },
    },
  },
});
