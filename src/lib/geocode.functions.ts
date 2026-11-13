import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Put addresses on the map. Signed-in only: the handler decrypts the
 * integration store and can bill Google per address, so it must never be
 * reachable anonymously. Each call answers everything already cached and
 * geocodes a bounded number of misses; the client loops while `pending > 0`.
 */
export const geocodeAddresses = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { addresses: string[]; maxNew?: number }) => {
    const addresses = [...new Set((input?.addresses ?? []).map((a) => String(a ?? "").trim()))]
      .filter((a) => a.length >= 3)
      .map((a) => a.slice(0, 200))
      .slice(0, 500);
    return {
      addresses,
      maxNew: Math.min(Math.max(Number(input?.maxNew ?? 20) || 0, 0), 25),
    };
  })
  .handler(async ({ data }) => {
    const { ensureIntegrationEnv } = await import("@/lib/integration-credentials.server");
    await ensureIntegrationEnv();
    const { geocodeThroughCache } = await import("@/lib/geocode.server");
    return geocodeThroughCache(data.addresses, data.maxNew);
  });

/**
 * The street address at a point, for the Field Camera's stamp. Signed-in
 * only, for the same reason as above: the handler holds the Google key and
 * can bill per call. The browser never sees the key and never calls Google;
 * it caches answers per ~50 m so a crew walking a house costs a call or two.
 */
export const reverseGeocodePoint = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { lat: number; lon: number }) => {
    const lat = Number(input?.lat);
    const lon = Number(input?.lon);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new Error("Invalid latitude");
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) throw new Error("Invalid longitude");
    // Five places (~1 m) is all a street address needs.
    return { lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5 };
  })
  .handler(async ({ data }) => {
    const { ensureIntegrationEnv } = await import("@/lib/integration-credentials.server");
    await ensureIntegrationEnv();
    const { reverseGeocode } = await import("@/lib/geocode.server");
    const hit = await reverseGeocode(data.lat, data.lon);
    return { address: hit?.formatted ?? null, provider: hit?.provider ?? null };
  });
