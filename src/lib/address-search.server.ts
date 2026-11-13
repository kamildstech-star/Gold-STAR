/**
 * Address lookup providers — server only.
 *
 * Split out of `address.functions.ts` so none of this reaches the browser.
 * Both callers are server function handlers that `await import()` this module:
 * `searchAddresses` (staff, behind Supabase auth) and `searchIntakeAddresses`
 * (the public intake form, behind an intake token). Neither one lets the key
 * out — same rule `route-map.functions.ts` states at the top of the file: the
 * Google key is server-only, so the call is made here and only the result
 * travels back.
 *
 * Providers in preference order: our own Google Places (New) key, the Lovable
 * connector gateway, Mapbox (own token, then the gateway), then the free OSM
 * pair. Which credential each uses is maps-auth.server.ts's rule: the gateway
 * only when LOVABLE_API_KEY can open it. Google needs Places API (New)
 * enabled on GOOGLE_MAPS_SERVER_KEY; nothing here needs an API beyond what
 * the server key already has.
 */
import type { AddressSuggestion, GeoPoint } from "./address.functions";
import {
  CONNECTOR_GATEWAY,
  gatewayHeaders,
  googleServerAuth,
  mapboxAuth,
} from "./maps-auth.server";

/**
 * Where suggestions should lean (29 Oct). David typed "18 Gem Dr, lak" standing
 * in the house and got Connecticut and upstate New York: nothing told Google
 * where he was. With a point — the phone's own location, else the office's —
 * nearby addresses rank first; anywhere in the US can still come back.
 */
const BIAS_RADIUS_M = 50_000; // Google's maximum for a circle bias.
function googleBias(near: GeoPoint | null | undefined) {
  return near
    ? {
        locationBias: {
          circle: { center: { latitude: near.lat, longitude: near.lon }, radius: BIAS_RADIUS_M },
        },
      }
    : {};
}

async function googleSearch(
  q: string,
  key: string,
  near?: GeoPoint | null,
): Promise<AddressSuggestion[]> {
  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask":
        "places.id,places.formattedAddress,places.location,places.addressComponents",
    },
    body: JSON.stringify({
      textQuery: q,
      regionCode: "US",
      maxResultCount: 6,
      ...googleBias(near),
    }),
  });
  if (!res.ok) throw new Error(`Google Places failed (${res.status}): ${await res.text()}`);
  const json = (await res.json()) as {
    places?: {
      id: string;
      formattedAddress?: string;
      location?: { latitude: number; longitude: number };
      addressComponents?: { longText: string; shortText: string; types: string[] }[];
    }[];
  };
  return (json.places ?? []).map((p) => {
    const comp = (t: string, short = false) => {
      const c = p.addressComponents?.find((x) => x.types.includes(t));
      return c ? (short ? c.shortText : c.longText) : null;
    };
    const number = comp("street_number");
    const route = comp("route");
    return {
      id: p.id,
      label: p.formattedAddress ?? "",
      address: [number, route].filter(Boolean).join(" ") || (p.formattedAddress ?? ""),
      locality: comp("locality") ?? comp("sublocality"),
      region: comp("administrative_area_level_1", true),
      postal_code: comp("postal_code"),
      county: comp("administrative_area_level_2"),
      // Google's own name for the apartment/suite part. Present only when the
      // customer picked a suggestion that named one — a street-level result
      // has no subpremise, and guessing one from the label would be worse
      // than leaving the box for them to fill in.
      unit: comp("subpremise", true),
      lat: p.location?.latitude ?? null,
      lon: p.location?.longitude ?? null,
      provider: "google" as const,
    };
  });
}

/**
 * Google Places Autocomplete (New) — the type-ahead endpoint (28 Oct).
 *
 * Text Search, used before, is for a finished query: "18 Gem Dr, lak" came
 * back as six California places near the server, never the Lakewood street
 * being typed. Autocomplete is built for half-typed input, and is limited
 * here to the US and to addresses. A prediction carries only its text and a
 * place id; the street, city, ZIP and pin are fetched for the ONE address
 * picked (`resolveGooglePlace`), not for every suggestion on every keystroke.
 */
type GoogleAuthCall = { base: string; headers: Record<string, string> };

function googleCall(auth: { key: string; viaGateway: boolean }): GoogleAuthCall {
  return auth.viaGateway
    ? { base: `${CONNECTOR_GATEWAY}/google_maps/places/v1`, headers: gatewayHeaders(auth.key) }
    : { base: "https://places.googleapis.com/v1", headers: { "X-Goog-Api-Key": auth.key } };
}

async function googleAutocomplete(
  q: string,
  auth: { key: string; viaGateway: boolean },
  near?: GeoPoint | null,
): Promise<AddressSuggestion[]> {
  const call = googleCall(auth);
  const res = await fetch(`${call.base}/places:autocomplete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...call.headers },
    body: JSON.stringify({
      input: q,
      includedRegionCodes: ["us"],
      includedPrimaryTypes: ["street_address", "premise", "subpremise", "route"],
      ...googleBias(near),
      ...(near ? { origin: { latitude: near.lat, longitude: near.lon } } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Google Autocomplete failed (${res.status}): ${await res.text()}`);
  return mapGooglePredictions(await res.json());
}

export function mapGooglePredictions(json: unknown): AddressSuggestion[] {
  const list =
    (
      json as {
        suggestions?: {
          placePrediction?: {
            placeId?: string;
            text?: { text?: string };
            structuredFormat?: { mainText?: { text?: string } };
          };
        }[];
      }
    ).suggestions ?? [];
  return list
    .map((s) => s.placePrediction)
    .filter((p): p is NonNullable<typeof p> => !!p?.placeId && !!p.text?.text)
    .slice(0, 6)
    .map((p) => ({
      id: p.placeId!,
      // "18 Gem Drive, Lakewood, NJ, USA" reads better without the country.
      label: p.text!.text!.replace(/, USA$/, ""),
      address: p.structuredFormat?.mainText?.text ?? p.text!.text!.split(",")[0]!,
      locality: null,
      region: null,
      postal_code: null,
      county: null,
      unit: null,
      lat: null,
      lon: null,
      provider: "google" as const,
      placeId: p.placeId!,
    }));
}

/** The full address for one picked prediction. Null when Google has nothing. */
export async function resolveGooglePlace(placeId: string): Promise<AddressSuggestion | null> {
  if (!/^[A-Za-z0-9_-]{10,300}$/.test(placeId)) return null;
  const { ensureIntegrationEnv } = await import("@/lib/integration-credentials.server");
  await ensureIntegrationEnv();
  const auth = googleServerAuth();
  if (!auth) return null;
  const call = googleCall(auth);
  const res = await fetch(`${call.base}/places/${encodeURIComponent(placeId)}`, {
    headers: {
      ...call.headers,
      "X-Goog-FieldMask": "id,formattedAddress,location,addressComponents",
    },
  });
  if (!res.ok) throw new Error(`Google Place Details failed (${res.status}): ${await res.text()}`);
  const place = await res.json();
  return mapGooglePlaces({ places: [place] })[0] ?? null;
}

async function mapboxSearch(
  q: string,
  auth: { key: string; viaGateway: boolean },
  near?: GeoPoint | null,
): Promise<AddressSuggestion[]> {
  const path =
    `/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json` +
    `?limit=6&country=us&types=address` +
    (near ? `&proximity=${near.lon},${near.lat}` : "");
  // Same request either way; the gateway holds the token, our own goes on the URL.
  const res = auth.viaGateway
    ? await fetch(`${CONNECTOR_GATEWAY}/mapbox${path}`, { headers: gatewayHeaders(auth.key) })
    : await fetch(`https://api.mapbox.com${path}&access_token=${encodeURIComponent(auth.key)}`);
  if (!res.ok) throw new Error(`Mapbox geocoding failed (${res.status}): ${await res.text()}`);
  const json = (await res.json()) as {
    features?: {
      id: string;
      place_name: string;
      text: string;
      address?: string;
      center?: [number, number];
      context?: { id: string; text: string; short_code?: string }[];
    }[];
  };
  return (json.features ?? []).map((f) => {
    const ctx = (prefix: string) => f.context?.find((c) => c.id.startsWith(prefix))?.text ?? null;
    const region = f.context?.find((c) => c.id.startsWith("region"));
    return {
      id: f.id,
      label: f.place_name,
      address: [f.address, f.text].filter(Boolean).join(" "),
      locality: ctx("place"),
      region: region?.short_code?.replace("US-", "") ?? region?.text ?? null,
      postal_code: ctx("postcode"),
      county: ctx("district"),
      // Mapbox is queried with `types=address`, which has no unit component.
      unit: null,
      lat: f.center?.[1] ?? null,
      lon: f.center?.[0] ?? null,
      provider: "mapbox" as const,
    };
  });
}

/**
 * Google Places via the Lovable connector gateway. Same shape as the direct
 * key path — the gateway injects the key, so no key ever reaches the client.
 */
async function googleGatewaySearch(
  q: string,
  connKey: string,
  near?: GeoPoint | null,
): Promise<AddressSuggestion[]> {
  const res = await fetch(`${CONNECTOR_GATEWAY}/google_maps/places/v1/places:searchText`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...gatewayHeaders(connKey),
      "X-Goog-FieldMask":
        "places.id,places.formattedAddress,places.location,places.addressComponents",
    },
    body: JSON.stringify({
      textQuery: q,
      regionCode: "US",
      maxResultCount: 8,
      ...googleBias(near),
    }),
  });
  if (!res.ok) {
    throw new Error(`Google Places gateway failed (${res.status}): ${await res.text()}`);
  }
  return mapGooglePlaces(await res.json());
}

function mapGooglePlaces(json: unknown): AddressSuggestion[] {
  const places =
    (
      json as {
        places?: {
          id: string;
          formattedAddress?: string;
          location?: { latitude: number; longitude: number };
          addressComponents?: { longText: string; shortText: string; types: string[] }[];
        }[];
      }
    ).places ?? [];
  return places.map((p) => {
    const comp = (t: string, short = false) => {
      const c = p.addressComponents?.find((x) => x.types.includes(t));
      return c ? (short ? c.shortText : c.longText) : null;
    };
    const number = comp("street_number");
    const route = comp("route");
    return {
      id: p.id,
      label: p.formattedAddress ?? "",
      address: [number, route].filter(Boolean).join(" ") || (p.formattedAddress ?? ""),
      locality: comp("locality") ?? comp("sublocality"),
      region: comp("administrative_area_level_1", true),
      postal_code: comp("postal_code"),
      county: comp("administrative_area_level_2"),
      // Google's own name for the apartment/suite part. Present only when the
      // customer picked a suggestion that named one — a street-level result
      // has no subpremise, and guessing one from the label would be worse
      // than leaving the box for them to fill in.
      unit: comp("subpremise", true),
      lat: p.location?.latitude ?? null,
      lon: p.location?.longitude ?? null,
      provider: "google" as const,
    };
  });
}

/**
 * Photon (OSM-backed, Komoot). Much better than raw Nominatim on partial and
 * house-number queries, which is exactly where typed intake lives.
 */
async function photonSearch(q: string, near?: GeoPoint | null): Promise<AddressSuggestion[]> {
  const url =
    `https://photon.komoot.io/api/?limit=8&lang=en&q=${encodeURIComponent(q)}` +
    (near ? `&lat=${near.lat}&lon=${near.lon}` : "");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Photon lookup failed (${res.status})`);
  const json = (await res.json()) as {
    features?: {
      geometry?: { coordinates?: [number, number] };
      properties?: Record<string, string>;
    }[];
  };
  return (json.features ?? [])
    .filter((f) => (f.properties?.["countrycode"] ?? "US") === "US")
    .map((f, i) => {
      const p = f.properties ?? {};
      const street = [p["housenumber"], p["street"] ?? p["name"]].filter(Boolean).join(" ");
      const city = p["city"] ?? p["town"] ?? p["village"] ?? p["district"] ?? null;
      const label = [street || p["name"], city, p["state"], p["postcode"]]
        .filter(Boolean)
        .join(", ");
      return {
        id: `photon-${p["osm_id"] ?? i}-${i}`,
        label: label || (p["name"] ?? ""),
        address: street || p["name"] || "",
        locality: city,
        region: p["state"] ?? null,
        postal_code: p["postcode"] ?? null,
        county: p["county"] ?? null,
        unit: null,
        lat: f.geometry?.coordinates?.[1] ?? null,
        lon: f.geometry?.coordinates?.[0] ?? null,
        provider: "nominatim" as const,
      };
    })
    .filter((s) => s.label.trim().length > 0);
}

/** Same street twice from two sources helps nobody — collapse on label. */
function dedupe(list: AddressSuggestion[]): AddressSuggestion[] {
  const seen = new Set<string>();
  const out: AddressSuggestion[] = [];
  for (const s of list) {
    const key = s.label.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

async function nominatimSearch(q: string): Promise<AddressSuggestion[]> {
  const url =
    `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&countrycodes=us&limit=6&q=` +
    encodeURIComponent(q);
  const res = await fetch(url, {
    headers: { "User-Agent": "RecoveryHub/1.0 (Gold Star Restoration intake)" },
  });
  if (!res.ok) throw new Error(`Address lookup failed (${res.status})`);
  const json = (await res.json()) as {
    place_id: number;
    display_name: string;
    lat: string;
    lon: string;
    address?: Record<string, string>;
  }[];
  return json.map((r) => {
    const a = r.address ?? {};
    const street = [a["house_number"], a["road"]].filter(Boolean).join(" ");
    return {
      id: String(r.place_id),
      label: r.display_name,
      address: street || r.display_name.split(",")[0] || "",
      locality: a["city"] ?? a["town"] ?? a["village"] ?? a["hamlet"] ?? null,
      region: a["state"] ?? null,
      postal_code: a["postcode"] ?? null,
      county: a["county"] ?? null,
      unit: a["unit"] ?? null,
      lat: Number(r.lat),
      lon: Number(r.lon),
      provider: "nominatim" as const,
    };
  });
}

/**
 * One address lookup, provider chosen by which credentials are configured.
 *
 * Callers hand in an already-trimmed, already-length-capped query and are
 * responsible for their own gate — this function has none of its own, which is
 * exactly why it is not exported from a file the client can import.
 */
export async function runAddressSearch(
  q: string,
  near?: GeoPoint | null,
): Promise<{ results: AddressSuggestion[]; provider: string }> {
  if (q.length < 3) return { results: [], provider: "none" };

  const { ensureIntegrationEnv } = await import("@/lib/integration-credentials.server");
  await ensureIntegrationEnv();
  const google = googleServerAuth();
  const mapbox = mapboxAuth();
  try {
    if (google) {
      // Type-ahead first; Text Search stays as the fallback (an address
      // Autocomplete will not offer, or an endpoint the gateway refuses).
      const typed = await googleAutocomplete(q, google, near).catch((err) => {
        console.error("[address] Google Autocomplete failed, trying Text Search", err);
        return [] as AddressSuggestion[];
      });
      if (typed.length) return { results: dedupe(typed), provider: "google" };
    }
    if (google && !google.viaGateway) {
      const results = dedupe(await googleSearch(q, google.key, near));
      if (results.length) return { results, provider: "google" };
    }
    if (google?.viaGateway) {
      const results = dedupe(await googleGatewaySearch(q, google.key, near));
      if (results.length) return { results, provider: "google" };
    }
    if (mapbox) {
      const results = dedupe(await mapboxSearch(q, mapbox, near));
      if (results.length) return { results, provider: "mapbox" };
    }
  } catch (err) {
    console.error("[address] preferred provider failed, falling back", err);
  }

  // Free fallback: run both OSM sources and merge. Photon handles partials
  // and house numbers; Nominatim is stronger on fully typed addresses.
  const [photon, nominatim] = await Promise.allSettled([photonSearch(q, near), nominatimSearch(q)]);
  const merged = dedupe([
    ...(photon.status === "fulfilled" ? photon.value : []),
    ...(nominatim.status === "fulfilled" ? nominatim.value : []),
  ]);
  return { results: merged.slice(0, 10), provider: "nominatim" };
}

/**
 * "I was actually sitting in that building" (29 Oct): the street address at a
 * point — what "Use my location" fills in. Google's Geocoding API on our own
 * key first, then OpenStreetMap's reverse lookup. Null when neither knows.
 */
export async function reverseGeocode(near: GeoPoint): Promise<AddressSuggestion | null> {
  const { ensureIntegrationEnv } = await import("@/lib/integration-credentials.server");
  await ensureIntegrationEnv();
  const google = googleServerAuth();
  if (google && !google.viaGateway) {
    try {
      const url =
        `https://maps.googleapis.com/maps/api/geocode/json?latlng=${near.lat},${near.lon}` +
        `&result_type=street_address|premise|subpremise&key=${encodeURIComponent(google.key)}`;
      const res = await fetch(url);
      if (res.ok) {
        const hit = mapGoogleGeocode(await res.json());
        if (hit) return hit;
      }
    } catch (err) {
      console.error("[address] Google reverse geocode failed, trying OSM", err);
    }
  }
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&zoom=18` +
        `&lat=${near.lat}&lon=${near.lon}`,
      { headers: { "User-Agent": "RecoveryHub/1.0 (Gold Star Restoration intake)" } },
    );
    if (!res.ok) return null;
    return mapNominatimReverse(await res.json());
  } catch {
    return null;
  }
}

export function mapGoogleGeocode(json: unknown): AddressSuggestion | null {
  const r = (
    json as {
      results?: {
        place_id: string;
        formatted_address: string;
        geometry?: { location?: { lat: number; lng: number } };
        address_components?: { long_name: string; short_name: string; types: string[] }[];
      }[];
    }
  ).results?.[0];
  if (!r) return null;
  const comp = (t: string, short = false) => {
    const c = r.address_components?.find((x) => x.types.includes(t));
    return c ? (short ? c.short_name : c.long_name) : null;
  };
  return {
    id: r.place_id,
    label: r.formatted_address.replace(/, USA$/, ""),
    address:
      [comp("street_number"), comp("route")].filter(Boolean).join(" ") ||
      r.formatted_address.split(",")[0]!,
    locality: comp("locality") ?? comp("sublocality"),
    region: comp("administrative_area_level_1", true),
    postal_code: comp("postal_code"),
    county: comp("administrative_area_level_2"),
    unit: comp("subpremise", true),
    lat: r.geometry?.location?.lat ?? null,
    lon: r.geometry?.location?.lng ?? null,
    provider: "google",
  };
}

export function mapNominatimReverse(json: unknown): AddressSuggestion | null {
  const r = json as {
    place_id?: number;
    display_name?: string;
    lat?: string;
    lon?: string;
    address?: Record<string, string>;
  };
  if (!r?.display_name || !r.address) return null;
  const a = r.address;
  if ((a["country_code"] ?? "us") !== "us") return null;
  const street = [a["house_number"], a["road"]].filter(Boolean).join(" ");
  return {
    id: String(r.place_id ?? r.display_name),
    label: r.display_name,
    address: street || r.display_name.split(",")[0] || "",
    locality: a["city"] ?? a["town"] ?? a["village"] ?? a["hamlet"] ?? null,
    region: a["state"] ?? null,
    postal_code: a["postcode"] ?? null,
    county: a["county"] ?? null,
    unit: null,
    lat: r.lat ? Number(r.lat) : null,
    lon: r.lon ? Number(r.lon) : null,
    provider: "nominatim",
  };
}
