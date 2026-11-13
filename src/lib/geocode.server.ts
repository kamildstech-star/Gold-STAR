import {
  CONNECTOR_GATEWAY,
  gatewayHeaders,
  googleServerAuth,
  type MapsAuth,
} from "@/lib/maps-auth.server";
import { geocodeCacheKey } from "@/lib/stop-positions";

/**
 * Forward geocoding through `geocode_cache`, for putting accounts on a map.
 *
 * Provider order mirrors `address.functions.ts`: a direct Google key
 * (`GOOGLE_MAPS_SERVER_KEY` / `GOOGLE_PLACES_API_KEY`), then the Lovable
 * Google Maps connector (`GOOGLE_MAPS_API_KEY`, through the connector gateway,
 * only while LOVABLE_API_KEY can open it — maps-auth.server.ts), then the
 * free OpenStreetMap geocoders so the routes map works before any key is
 * connected. Each distinct address is paid for once; a miss is cached too.
 */

export type GeocodeResult = {
  lat: number;
  lon: number;
  formatted: string;
  provider: "google" | "osm";
};

type Auth = MapsAuth;

const googleAuth = () => googleServerAuth();

async function viaGoogle(query: string, auth: Auth): Promise<GeocodeResult | null> {
  const base = auth.viaGateway
    ? `${CONNECTOR_GATEWAY}/google_maps/maps/api/geocode/json`
    : "https://maps.googleapis.com/maps/api/geocode/json";
  const url = `${base}?address=${encodeURIComponent(query)}&region=us${
    auth.viaGateway ? "" : `&key=${auth.key}`
  }`;
  const headers: Record<string, string> = {};
  if (auth.viaGateway) Object.assign(headers, gatewayHeaders(auth.key));
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Google geocode failed (${res.status})`);
  const json = (await res.json()) as {
    status?: string;
    results?: {
      formatted_address?: string;
      geometry?: { location?: { lat: number; lng: number } };
      partial_match?: boolean;
    }[];
  };
  if (json.status && json.status !== "OK" && json.status !== "ZERO_RESULTS") {
    throw new Error(`Google geocode status ${json.status}`);
  }
  const hit = json.results?.[0];
  const loc = hit?.geometry?.location;
  if (!hit || !loc) return null;
  return {
    lat: loc.lat,
    lon: loc.lng,
    formatted: hit.formatted_address ?? query,
    provider: "google",
  };
}

async function viaPhoton(query: string): Promise<GeocodeResult | null> {
  const url = `https://photon.komoot.io/api/?limit=1&lang=en&q=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Photon failed (${res.status})`);
  const json = (await res.json()) as {
    features?: {
      geometry?: { coordinates?: [number, number] };
      properties?: Record<string, string>;
    }[];
  };
  const f = json.features?.[0];
  const coords = f?.geometry?.coordinates;
  if (!f || !coords) return null;
  const p = f.properties ?? {};
  // A country-level or state-level answer is not a property.
  if (["country", "state", "county"].includes(p["type"] ?? "")) return null;
  const label = [
    [p["housenumber"], p["street"] ?? p["name"]].filter(Boolean).join(" "),
    p["city"] ?? p["town"] ?? p["village"],
    p["state"],
    p["postcode"],
  ]
    .filter(Boolean)
    .join(", ");
  return { lat: coords[1], lon: coords[0], formatted: label || query, provider: "osm" };
}

async function viaNominatim(query: string): Promise<GeocodeResult | null> {
  const url =
    `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=us&q=` +
    encodeURIComponent(query);
  const res = await fetch(url, {
    headers: { "User-Agent": "RecoveryHub/1.0 (Gold Star Restoration routes)" },
  });
  if (!res.ok) throw new Error(`Nominatim failed (${res.status})`);
  const json = (await res.json()) as { lat: string; lon: string; display_name: string }[];
  const r = json[0];
  if (!r) return null;
  return { lat: Number(r.lat), lon: Number(r.lon), formatted: r.display_name, provider: "osm" };
}

/**
 * Geocode one address, trying each provider in turn.
 *
 * A miss is only an answer when every provider that was asked answered.
 * Google failing (a bad key, the quota, the custom domain refusing it) and
 * the free fallbacks then finding nothing used to come back as "no such
 * place" — and both callers cache that, so the address was skipped for good
 * (Fire Feed handoff, 20 Oct, known issue 3). Now that case throws, and the
 * callers treat it as an outage: nothing cached, asked again next time.
 */
export async function geocodeAddress(query: string): Promise<GeocodeResult | null> {
  const google = googleAuth();
  const errors: string[] = [];
  if (google) {
    try {
      return await viaGoogle(query, google);
    } catch (e) {
      errors.push(String(e));
    }
  }
  try {
    const hit = await viaPhoton(query);
    if (hit) return hit;
  } catch (e) {
    errors.push(String(e));
  }
  try {
    const hit = await viaNominatim(query);
    if (hit) return hit;
  } catch (e) {
    errors.push(String(e));
  }
  if (errors.length) throw new Error(errors.join("; "));
  return null;
}

/**
 * One address through the same cache, with the formatted address kept — the
 * fire feed reads the ZIP out of it, because the ZIP is what routes an
 * incident to a zone and market (`incidents_classify`). Null is a cached
 * "no such place"; a provider failure throws, so the caller can retry next
 * run instead of remembering a miss that was only an outage.
 */
export async function geocodeOneCached(
  query: string,
): Promise<{ lat: number; lon: number; formatted: string | null } | null> {
  const key = geocodeCacheKey(query);
  if (!key) return null;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("geocode_cache")
    .select("lat,lon,resolved,formatted_address")
    .eq("query", key)
    .maybeSingle();
  if (error) throw error;
  if (data) {
    const row = data as {
      lat: number | null;
      lon: number | null;
      resolved: boolean;
      formatted_address: string | null;
    };
    if (!row.resolved || row.lat == null || row.lon == null) return null;
    return { lat: Number(row.lat), lon: Number(row.lon), formatted: row.formatted_address };
  }
  const hit = await geocodeAddress(query.trim());
  await supabaseAdmin.from("geocode_cache").upsert(
    {
      query: key,
      formatted_address: hit?.formatted ?? null,
      lat: hit?.lat ?? null,
      lon: hit?.lon ?? null,
      provider: hit?.provider ?? (googleAuth() ? "google" : "osm"),
      resolved: Boolean(hit),
    } as never,
    { onConflict: "query" },
  );
  return hit ? { lat: hit.lat, lon: hit.lon, formatted: hit.formatted } : null;
}

export type CacheRow = { query: string; lat: number | null; lon: number | null; resolved: boolean };

/**
 * Cached answers for every query, geocoding at most `maxNew` misses this
 * call. Returns how many misses were left untouched so the caller can come
 * back for the rest without hammering a free provider.
 */
export async function geocodeThroughCache(
  queries: string[],
  maxNew: number,
): Promise<{ rows: CacheRow[]; pending: number; provider: "google" | "osm" | "none" }> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const byKey = new Map<string, string>();
  for (const q of queries) {
    const key = geocodeCacheKey(q);
    if (key && !byKey.has(key)) byKey.set(key, q.trim());
  }
  const keys = [...byKey.keys()];
  const rows = new Map<string, CacheRow>();

  for (let i = 0; i < keys.length; i += 100) {
    const batch = keys.slice(i, i + 100);
    const { data, error } = await supabaseAdmin
      .from("geocode_cache")
      .select("query,lat,lon,resolved")
      .in("query", batch);
    if (error) throw error;
    for (const r of data ?? []) {
      rows.set(r.query as string, {
        query: r.query as string,
        lat: r.lat == null ? null : Number(r.lat),
        lon: r.lon == null ? null : Number(r.lon),
        resolved: Boolean(r.resolved),
      });
    }
  }

  const misses = keys.filter((k) => !rows.has(k));
  const todo = misses.slice(0, Math.max(0, maxNew));
  let provider: "google" | "osm" | "none" = "none";
  const usingGoogle = Boolean(googleAuth());
  for (const key of todo) {
    let hit: GeocodeResult | null;
    try {
      hit = await geocodeAddress(byKey.get(key) ?? key);
    } catch (e) {
      // Transient: report nothing for this one, don't poison the cache.
      console.error("[geocode] failed", key, e);
      continue;
    }
    provider = hit?.provider ?? (usingGoogle ? "google" : "osm");
    const row: CacheRow = {
      query: key,
      lat: hit?.lat ?? null,
      lon: hit?.lon ?? null,
      resolved: Boolean(hit),
    };
    rows.set(key, row);
    await supabaseAdmin.from("geocode_cache").upsert(
      {
        query: key,
        formatted_address: hit?.formatted ?? null,
        lat: row.lat,
        lon: row.lon,
        provider: hit?.provider ?? (usingGoogle ? "google" : "osm"),
        resolved: row.resolved,
      } as never,
      { onConflict: "query" },
    );
    // Nominatim's published limit is one request a second; Photon and Google
    // are more generous but a short pause keeps a 20-address batch polite.
    if (!usingGoogle) await new Promise((r) => setTimeout(r, 1100));
  }

  return { rows: [...rows.values()], pending: misses.length - todo.length, provider };
}

/* ── reverse: a point to a street address ─────────────────────────────── */

/**
 * The address a crew member is standing at, for the Field Camera's stamp.
 *
 * Same provider order and the same credentials as the forward geocoder above
 * — Google with the server key or through the connector gateway, then the
 * free OSM services — so the browser never holds a Google key and a deploy
 * with no key at all still stamps an address. A miss is null, not an error:
 * the camera falls back to the job's address, then to the coordinates.
 *
 * Answers are held in memory per server instance, on a ~50 m grid, and not in
 * `geocode_cache`: that table is readable by all staff, and a growing list of
 * the exact points crews stood at is not something it needs to hold.
 */
export type ReverseResult = { formatted: string; provider: "google" | "osm" };

const REVERSE_GRID = 0.0005; // ≈ 55 m of latitude
const REVERSE_CACHE_MAX = 2000;
const reverseCache = new Map<string, ReverseResult | null>();

export function reverseCacheKey(lat: number, lon: number): string {
  const snap = (v: number) => (Math.round(v / REVERSE_GRID) * REVERSE_GRID).toFixed(4);
  return `${snap(lat)},${snap(lon)}`;
}

async function reverseViaGoogle(lat: number, lon: number, auth: Auth) {
  const base = auth.viaGateway
    ? `${CONNECTOR_GATEWAY}/google_maps/maps/api/geocode/json`
    : "https://maps.googleapis.com/maps/api/geocode/json";
  const url =
    `${base}?latlng=${lat},${lon}&result_type=street_address|premise|route` +
    (auth.viaGateway ? "" : `&key=${auth.key}`);
  const headers: Record<string, string> = {};
  if (auth.viaGateway) Object.assign(headers, gatewayHeaders(auth.key));
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Google reverse geocode failed (${res.status})`);
  const json = (await res.json()) as {
    status?: string;
    results?: { formatted_address?: string }[];
  };
  if (json.status && json.status !== "OK" && json.status !== "ZERO_RESULTS") {
    throw new Error(`Google reverse geocode status ${json.status}`);
  }
  const hit = json.results?.[0]?.formatted_address;
  return hit ? { formatted: tidyUsAddress(hit), provider: "google" as const } : null;
}

async function reverseViaPhoton(lat: number, lon: number) {
  const res = await fetch(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lon}&limit=1&lang=en`);
  if (!res.ok) throw new Error(`Photon reverse failed (${res.status})`);
  const json = (await res.json()) as { features?: { properties?: Record<string, string> }[] };
  const p = json.features?.[0]?.properties;
  if (!p) return null;
  const street = [p["housenumber"], p["street"] ?? p["name"]].filter(Boolean).join(" ");
  const city = p["city"] ?? p["town"] ?? p["village"] ?? p["district"];
  const label = [street, city, stateZip(p["state"], p["postcode"])].filter(Boolean).join(", ");
  return label ? { formatted: label, provider: "osm" as const } : null;
}

async function reverseViaNominatim(lat: number, lon: number) {
  const res = await fetch(
    `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&lat=${lat}&lon=${lon}`,
    { headers: { "User-Agent": "RecoveryHub/1.0 (Gold Star Restoration field camera)" } },
  );
  if (!res.ok) throw new Error(`Nominatim reverse failed (${res.status})`);
  const json = (await res.json()) as { display_name?: string; address?: Record<string, string> };
  const a = json.address;
  if (!a) {
    return json.display_name ? { formatted: json.display_name, provider: "osm" as const } : null;
  }
  const street = [a["house_number"], a["road"]].filter(Boolean).join(" ");
  const city = a["city"] ?? a["town"] ?? a["village"] ?? a["hamlet"] ?? a["suburb"];
  const label = [street, city, stateZip(a["state"], a["postcode"])].filter(Boolean).join(", ");
  return label ? { formatted: label, provider: "osm" as const } : null;
}

function stateZip(state: string | undefined, postcode: string | undefined): string {
  return [state, postcode].filter(Boolean).join(" ");
}

/** "314 Troy Ave, Brooklyn, NY 11213, USA" → without the country a US crew never needs. */
export function tidyUsAddress(formatted: string): string {
  return formatted.replace(/,\s*(USA|United States)$/i, "").trim();
}

/** Point → address, trying each provider in turn. Null when nobody knows. */
export async function reverseGeocode(lat: number, lon: number): Promise<ReverseResult | null> {
  const key = reverseCacheKey(lat, lon);
  if (reverseCache.has(key)) return reverseCache.get(key) ?? null;
  const providers: (() => Promise<ReverseResult | null>)[] = [];
  const google = googleAuth();
  if (google) providers.push(() => reverseViaGoogle(lat, lon, google));
  providers.push(
    () => reverseViaPhoton(lat, lon),
    () => reverseViaNominatim(lat, lon),
  );
  let hit: ReverseResult | null = null;
  let answered = false;
  for (const ask of providers) {
    try {
      hit = await ask();
      answered = true;
      if (hit) break;
    } catch (e) {
      console.error("[geocode] reverse failed", e);
    }
  }
  // Only remember an answer, including "no address here" — never an outage.
  if (answered) {
    if (reverseCache.size >= REVERSE_CACHE_MAX) {
      const oldest = reverseCache.keys().next().value;
      if (oldest !== undefined) reverseCache.delete(oldest);
    }
    reverseCache.set(key, hit);
  }
  return hit;
}
