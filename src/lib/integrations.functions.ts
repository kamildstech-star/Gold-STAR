import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { serverConfiguredAppOrigin } from "@/lib/app-origin";

/**
 * Every secret any integration card cares about. Presence only — values never
 * leave the server. This is what stops the admin page from ever showing a
 * connected state that isn't real.
 */
const SECRETS = [
  // Outlook / Graph
  "OUTLOOK_TENANT_ID",
  "OUTLOOK_CLIENT_ID",
  "OUTLOOK_CLIENT_SECRET",
  "OUTLOOK_WEBHOOK_CLIENT_STATE",
  // Maps
  "GOOGLE_MAPS_SERVER_KEY",
  "GOOGLE_MAPS_API_KEY",
  "GOOGLE_PLACES_API_KEY",
  "MAPBOX_API_KEY",
  // Our own Mapbox token, used directly off Lovable (maps-auth.server.ts).
  "MAPBOX_ACCESS_TOKEN",
  // Telephony
  "AUTO_CAPTURE_WEBHOOK_SECRET",
  "CALLRAIL_WEBHOOK_SECRET",
  "CALLRAIL_API_KEY",
  // Field
  "RAVEN_WEBHOOK_SECRET",
  "RAVEN_API_KEY",
  "RAVEN_API_SECRET",
  "RAVEN_API_URL",
  "EQUIPMENT_TRACKER_WEBHOOK_SECRET",
  "KAI_API_KEY",
  // Intelligence
  "PROPERTYSHARK_API_KEY",
  "PROPERTY_PROVIDER",
  "INCIDENT_WEBHOOK_SECRET",
  "SOCRATA_APP_TOKEN",
  // Documents / marketing
  "ESIGN_PROVIDER",
  "ESIGN_API_KEY",
  "ESIGN_WEBHOOK_SECRET",
  "EMAIL_MARKETING_API_KEY",
  "COMPANYCAM_API_KEY",
  // Platform
  "LOVABLE_API_KEY",
  "ANTHROPIC_API_KEY",
  "AI_API_KEY",
  // Transactional email (the fallback when a sender has not connected Outlook)
  "RESEND_API_KEY",
  "RESEND_FROM_ADDRESS",
  "RESEND_WEBHOOK_SECRET",
] as const;

export const integrationSecretStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    // A value typed on the Integrations screen is as present as a deployment
    // secret — it is the one every send path now reads (ensureIntegrationEnv).
    const { ensureIntegrationEnv } = await import("@/lib/integration-credentials.server");
    await ensureIntegrationEnv();
    const { aiConfigured, aiSummary } = await import("@/lib/ai-provider.server");
    const present: Record<string, boolean> = {};
    for (const name of SECRETS) present[name] = Boolean(process.env[name]);
    return {
      present,
      // Null when unset, so the screen falls back to the address it is on.
      base_url: serverConfiguredAppOrigin(),
      // Which provider and models answer (ai-provider.server.ts). Names only.
      ai: { ...aiSummary(), configured: aiConfigured() },
    };
  });

/**
 * A real call against the Google server key. Anything other than OK — a bad
 * key, a referrer restriction on a key that should be unrestricted, billing
 * disabled — comes back as the message Google actually returned, so the card
 * can go red with a reason instead of quietly pretending.
 */
export const probeGoogleMaps = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async (): Promise<{ ok: boolean; message: string }> => {
    const key =
      process.env["GOOGLE_MAPS_SERVER_KEY"] ??
      process.env["GOOGLE_MAPS_API_KEY"] ??
      process.env["GOOGLE_PLACES_API_KEY"];
    if (!key) return { ok: false, message: "No server-side Google key is configured." };
    try {
      const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
      url.searchParams.set("address", "350 5th Ave, New York, NY");
      url.searchParams.set("key", key);
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const body = (await res.json()) as {
        status?: string;
        error_message?: string;
        results?: unknown[];
      };
      if (body.status === "OK") {
        return {
          ok: true,
          message: `Geocoding API answered OK (${body.results?.length ?? 0} results)`,
        };
      }
      return {
        ok: false,
        message: `Google returned ${body.status ?? res.status}${body.error_message ? ` — ${body.error_message}` : ""}`,
      };
    } catch (err) {
      return { ok: false, message: `Could not reach Google: ${(err as Error).message}` };
    }
  });

/**
 * Manual Raven pull. Admin-only: an owner or admin can force a sync from the
 * Integrations page and see exactly what Raven answered, including the raw
 * shape of one position payload so we know what their account exposes.
 */
export const syncRavenFleet = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: allowed } = await context.supabase.rpc("is_privileged", {
      _user_id: context.userId,
    });
    if (!allowed) throw new Error("Forbidden");
    const { syncRavenPositions } = await import("@/lib/raven-sync.server");
    return await syncRavenPositions();
  });

/**
 * Manual Kahi equipment pull. Admin-only, same shape as the Raven trigger:
 * returns the sync counts, the alert tally and one real asset payload so we
 * can see which tracking fields their account actually provides.
 */
export const syncKahiEquipmentNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: allowed } = await context.supabase.rpc("is_privileged", {
      _user_id: context.userId,
    });
    if (!allowed) throw new Error("Forbidden");
    const { syncKahiEquipment } = await import("@/lib/kahi-sync.server");
    return await syncKahiEquipment();
  });
