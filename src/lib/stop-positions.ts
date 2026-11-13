import { supabase } from "@/integrations/supabase/client";
import type { PlannableStop } from "@/lib/visits";

/**
 * Where an account actually is.
 *
 * `accounts` carries a typed street address and nothing else: there is no
 * lat/lon column, which is why the routes map could only ever show past
 * visits. A stop gets a position from one of two places, in this order:
 *
 *   1. the geocode cache (`geocode_cache`, filled by the server geocoder
 *      once per distinct address, readable by any signed-in user);
 *   2. the coordinates of the most recent visit logged against the account
 *      (a rep stood there with a phone — that is the property).
 *
 * The helpers here are pure so the ranking is testable; the fetches live at
 * the bottom.
 */

export type StopPosition = {
  lat: number;
  lon: number;
  source: "geocode" | "visit";
};

export type GeoHit = { lat: number; lon: number } | null;

/** Must match the server geocoder, which keys the cache the same way. */
export function geocodeCacheKey(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * The string sent to the geocoder. A stop with no street line is not
 * geocoded: "Newark, NJ" resolves to the middle of town, and a pin on the
 * town hall reads as a real property. Better to say "no address" than lie.
 */
export function stopAddressQuery(stop: {
  street: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
}): string | null {
  const street = stop.street?.trim();
  if (!street) return null;
  const parts = [street, stop.city?.trim(), stop.state?.trim(), stop.postal_code?.trim()].filter(
    (p): p is string => Boolean(p),
  );
  // A bare street with nothing to anchor it is ambiguous across the country.
  if (parts.length === 1 && !/\d/.test(street)) return null;
  return parts.join(", ");
}

/**
 * Pick a position for every stop that has one. `geocoded` is keyed by
 * `geocodeCacheKey(query)`; `visitCoords` by account id.
 */
export function resolveStopPositions(
  stops: PlannableStop[],
  geocoded: ReadonlyMap<string, GeoHit>,
  visitCoords: ReadonlyMap<string, { lat: number; lon: number }>,
): Map<string, StopPosition> {
  const out = new Map<string, StopPosition>();
  for (const s of stops) {
    const q = stopAddressQuery(s);
    const hit = q ? geocoded.get(geocodeCacheKey(q)) : undefined;
    if (hit && Number.isFinite(hit.lat) && Number.isFinite(hit.lon)) {
      out.set(s.id, { lat: hit.lat, lon: hit.lon, source: "geocode" });
      continue;
    }
    const v = visitCoords.get(s.id);
    if (v && Number.isFinite(v.lat) && Number.isFinite(v.lon)) {
      out.set(s.id, { lat: v.lat, lon: v.lon, source: "visit" });
    }
  }
  return out;
}

/** Stops with an address the geocoder has not answered for yet. */
export function unresolvedQueries(
  stops: PlannableStop[],
  geocoded: ReadonlyMap<string, GeoHit>,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of stops) {
    const q = stopAddressQuery(s);
    if (!q) continue;
    const key = geocodeCacheKey(q);
    if (geocoded.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(q);
  }
  return out;
}

/* ------------------------------------------------------------------ fetches */

function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Latest located visit per account, from the same touchpoint history the map already draws. */
export async function fetchLastVisitCoords(
  accountIds: string[],
): Promise<Map<string, { lat: number; lon: number }>> {
  const out = new Map<string, { lat: number; lon: number }>();
  const unique = [...new Set(accountIds.filter(Boolean))];
  for (const ids of chunk(unique, 100)) {
    // Newest first, so the first row seen per account is its latest visit.
    // The row cap is best-effort: this is the fallback behind the geocoder.
    const { data, error } = await supabase
      .from("touchpoints")
      .select("account_id,lat,lon,occurred_at")
      .in("account_id", ids)
      .not("lat", "is", null)
      .not("lon", "is", null)
      .order("occurred_at", { ascending: false })
      .limit(1000);
    if (error) throw error;
    for (const r of data ?? []) {
      const id = r.account_id as string;
      if (out.has(id)) continue;
      out.set(id, { lat: Number(r.lat), lon: Number(r.lon) });
    }
  }
  return out;
}

/**
 * Cached answers only — no geocoder is called. Every signed-in user can read
 * the cache, so this is one round trip for the whole book.
 */
export async function fetchCachedGeocodes(queries: string[]): Promise<Map<string, GeoHit>> {
  const out = new Map<string, GeoHit>();
  const keys = [...new Set(queries.map(geocodeCacheKey))];
  for (const batch of chunk(keys, 100)) {
    const { data, error } = await supabase
      .from("geocode_cache")
      .select("query,lat,lon,resolved")
      .in("query", batch);
    if (error) throw error;
    for (const r of data ?? []) {
      const resolved = Boolean(r.resolved) && r.lat != null && r.lon != null;
      out.set(r.query as string, resolved ? { lat: Number(r.lat), lon: Number(r.lon) } : null);
    }
  }
  return out;
}
