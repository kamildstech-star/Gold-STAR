/**
 * Exposure suggestions — server-only.
 *
 * A fire damages the neighbours. The chaser must never type an address, so we
 * propose candidates from the origin address and its building type, and only
 * fall back to manual entry. Suggestions are proposals, not records: nothing
 * is created until the chaser taps one.
 */

import { CONNECTOR_GATEWAY, gatewayHeaders, googleServerAuth } from "@/lib/maps-auth.server";

export type BuildingType = "multi_family" | "row_house" | "semi_detached" | "detached";

export const BUILDING_TYPE_LABEL: Record<BuildingType, string> = {
  multi_family: "Multi-family",
  row_house: "Row house",
  semi_detached: "Semi-detached",
  detached: "Detached",
};

export interface ExposureSuggestion {
  address: string;
  note: string;
  lat: number | null;
  lon: number | null;
  unlikely: boolean;
}

/** Splits "412 Ocean Pkwy, Brooklyn NY" into its house number and the rest. */
export function splitHouseNumber(address: string): { number: number | null; rest: string } {
  const m = /^\s*(\d+)\s+(.*)$/.exec(address);
  if (!m) return { number: null, rest: address.trim() };
  return { number: Number(m[1]), rest: (m[2] ?? "").trim() };
}

/** Same-side neighbours keep the parity of the house number. */
function sameSide(base: number, steps: number[]): number[] {
  return steps.map((s) => base + s * 2).filter((n) => n > 0);
}

function nearbyPlaces(json: unknown): ExposureSuggestion[] {
  const places =
    (
      json as {
        places?: {
          formattedAddress?: string;
          location?: { latitude: number; longitude: number };
        }[];
      }
    ).places ?? [];
  return places
    .filter((p) => !!p.formattedAddress)
    .map((p) => ({
      address: p.formattedAddress as string,
      note: "Nearest building — exposure unlikely, confirm before knocking",
      lat: p.location?.latitude ?? null,
      lon: p.location?.longitude ?? null,
      unlikely: true,
    }));
}

async function fetchNearby(
  lat: number,
  lon: number,
  key: string,
  viaGateway: boolean,
  maxResults: number,
): Promise<ExposureSuggestion[]> {
  const url = viaGateway
    ? `${CONNECTOR_GATEWAY}/google_maps/places/v1/places:searchNearby`
    : "https://places.googleapis.com/v1/places:searchNearby";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Goog-FieldMask": "places.formattedAddress,places.location",
  };
  if (viaGateway) {
    Object.assign(headers, gatewayHeaders(key));
  } else {
    headers["X-Goog-Api-Key"] = key;
  }
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      maxResultCount: Math.max(1, maxResults),
      locationRestriction: { circle: { center: { latitude: lat, longitude: lon }, radius: 90 } },
    }),
  });
  if (!res.ok) {
    console.error(`[exposures] nearby lookup failed (${res.status}): ${await res.text()}`);
    return [];
  }
  return nearbyPlaces(await res.json());
}

export interface ExposureCounts {
  multiFamilyUnits: number;
  rowHouseSpan: number;
  semiDetachedSpan: number;
  detachedNearby: number;
}

export async function buildExposureSuggestions(input: {
  address: string;
  lat: number | null;
  lon: number | null;
  buildingType: BuildingType;
  counts: ExposureCounts;
}): Promise<ExposureSuggestion[]> {
  const { number, rest } = splitHouseNumber(input.address);
  const out: ExposureSuggestion[] = [];

  if (input.buildingType === "multi_family") {
    // Other units at the same address: separate homeowners, one building.
    const units = Array.from({ length: Math.max(1, input.counts.multiFamilyUnits) }, (_, i) =>
      String(i + 1),
    );
    for (const unit of units) {
      out.push({
        address: `${input.address} — Unit ${unit}`,
        note: "Another unit at this address",
        lat: input.lat,
        lon: input.lon,
        unlikely: false,
      });
    }
    return out;
  }

  if (
    number != null &&
    (input.buildingType === "row_house" || input.buildingType === "semi_detached")
  ) {
    const span = Math.max(
      1,
      input.buildingType === "row_house"
        ? input.counts.rowHouseSpan
        : input.counts.semiDetachedSpan,
    );
    const steps = Array.from({ length: span }, (_, i) => i + 1)
      .flatMap((n) => [-n, n])
      .sort((a, b) => a - b);
    for (const n of sameSide(number, steps)) {
      out.push({
        address: `${n} ${rest}`,
        note:
          input.buildingType === "row_house"
            ? "Same side of the street, attached run"
            : "The attached neighbor",
        lat: input.lat,
        lon: input.lon,
        unlikely: false,
      });
    }
    return out;
  }

  // Detached, or an address with no house number to work from.
  await (await import("@/lib/integration-credentials.server")).ensureIntegrationEnv();
  const google = googleServerAuth();
  if (input.lat != null && input.lon != null && google) {
    const nearby = await fetchNearby(
      input.lat,
      input.lon,
      google.key,
      google.viaGateway,
      input.counts.detachedNearby,
    );
    if (nearby.length) return nearby.slice(0, Math.max(1, input.counts.detachedNearby));
  }
  if (number != null) {
    for (const n of sameSide(number, [-1, 1])) {
      out.push({
        address: `${n} ${rest}`,
        note: "Nearest building — exposure unlikely",
        lat: input.lat,
        lon: input.lon,
        unlikely: true,
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Real neighbours — tap, don't type.
 *
 * The chaser is at a fire, one-handed, in the dark. They never type an
 * address: we derive the neighbouring house numbers from the origin and,
 * when a Google key is connected, confirm each one exists. Without a key
 * the arithmetic candidates still stand up — same-side numbers keep the
 * parity of the origin, across-the-street flips it — so the feature works
 * today and simply gets more accurate when the key lands.
 *
 * A confirmed building and a "no such place" are cached in geocode_cache:
 * one address is paid for once. Failures and loose matches are not (see
 * geocodeOne).
 * ------------------------------------------------------------------ */

export type NeighbourTier = "immediate" | "next" | "across" | "unit";

export interface NeighbourCandidate {
  address: string;
  label: string;
  tier: NeighbourTier;
  lat: number | null;
  lon: number | null;
  /** google = confirmed to exist; derived = arithmetic from the house number. */
  source: "google" | "derived";
}

export interface NeighbourResult {
  neighbours: NeighbourCandidate[];
  /** Street portion of the origin address, used to prefill manual entry. */
  street: string;
  houseNumber: number | null;
  buildingType: BuildingType | null;
  provider: "google" | "derived" | "none";
  resolved: boolean;
}

export interface NeighbourSpans {
  multiFamilyUnits: number;
  rowHouseSpan: number;
  semiDetachedSpan: number;
  detachedNearby: number;
}

/** Own key first; the connector gateway only while LOVABLE_API_KEY can open it. */
function googleKey(): { key: string; viaGateway: boolean } | null {
  return googleServerAuth();
}

type GeocodeHit = { address: string; lat: number | null; lon: number | null };

/**
 * What Google said about one guessed address:
 *   - a confirmed building (street address / premise, rooftop or interpolated);
 *   - `none`: ZERO_RESULTS, no such place — safe to cache;
 *   - `loose`: Google found something, just not a building precise enough to
 *     knock on (a street, a town). True for THIS strict filter only, so it is
 *     never cached: the fire feed reads the same cache with a looser filter,
 *     and a cached miss here would skip a real fire at that address forever.
 * Anything else — HTTP errors, REQUEST_DENIED, OVER_QUERY_LIMIT, INVALID_REQUEST,
 * UNKNOWN_ERROR, all of which Google sends with HTTP 200 — throws, so the
 * caller does not cache an outage as an answer.
 */
type GeocodeAnswer = { kind: "hit"; hit: GeocodeHit } | { kind: "none" } | { kind: "loose" };

async function geocodeOne(
  query: string,
  auth: { key: string; viaGateway: boolean },
): Promise<GeocodeAnswer> {
  const base = auth.viaGateway
    ? `${CONNECTOR_GATEWAY}/google_maps/maps/api/geocode/json`
    : "https://maps.googleapis.com/maps/api/geocode/json";
  const url = `${base}?address=${encodeURIComponent(query)}${auth.viaGateway ? "" : `&key=${auth.key}`}`;
  const headers: Record<string, string> = {};
  if (auth.viaGateway) Object.assign(headers, gatewayHeaders(auth.key));
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    throw new Error(`geocode HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    status?: string;
    error_message?: string;
    results?: {
      formatted_address?: string;
      types?: string[];
      geometry?: { location?: { lat: number; lng: number }; location_type?: string };
    }[];
  };
  if (json.status === "ZERO_RESULTS") return { kind: "none" };
  if (json.status !== "OK") {
    throw new Error(
      `geocode status ${json.status ?? "missing"}${json.error_message ? `: ${json.error_message.slice(0, 200)}` : ""}`,
    );
  }
  const hit = (json.results ?? []).find((r) => {
    const t = r.types ?? [];
    const lt = r.geometry?.location_type;
    return (
      (t.includes("street_address") || t.includes("premise") || t.includes("subpremise")) &&
      (lt === "ROOFTOP" || lt === "RANGE_INTERPOLATED")
    );
  });
  if (!hit?.formatted_address) return { kind: "loose" };
  return {
    kind: "hit",
    hit: {
      address: hit.formatted_address,
      lat: hit.geometry?.location?.lat ?? null,
      lon: hit.geometry?.location?.lng ?? null,
    },
  };
}

/**
 * Geocode through the cache, which the fire feed and the account map share.
 * A confirmed building and a ZERO_RESULTS are cached; an address Google found
 * only loosely, and any failure, are not (see `geocodeOne`).
 */
async function geocodeCached(
  query: string,
  auth: { key: string; viaGateway: boolean },
): Promise<GeocodeHit | null> {
  const key = query.trim().toLowerCase().replace(/\s+/g, " ");
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: cached } = await supabaseAdmin
    .from("geocode_cache")
    .select("formatted_address, lat, lon, resolved")
    .eq("query", key)
    .maybeSingle();
  if (cached) {
    if (!cached.resolved || !cached.formatted_address) return null;
    return { address: cached.formatted_address, lat: cached.lat, lon: cached.lon };
  }

  let answer: GeocodeAnswer;
  try {
    answer = await geocodeOne(query, auth);
  } catch (e) {
    console.error("[exposures] geocode error", e);
    return null; // an outage or a refused key, not an answer: cache nothing
  }
  if (answer.kind === "loose") return null;
  const hit = answer.kind === "hit" ? answer.hit : null;
  await supabaseAdmin.from("geocode_cache").upsert(
    {
      query: key,
      formatted_address: hit?.address ?? null,
      lat: hit?.lat ?? null,
      lon: hit?.lon ?? null,
      provider: "google",
      resolved: !!hit,
    } as never,
    { onConflict: "query" },
  );
  return hit;
}

/** Units in a multi-family: separate homeowners behind one street number. */
function unitCandidates(address: string, lat: number | null, lon: number | null, count: number) {
  const letters = ["A", "B", "C", "D"];
  const out: NeighbourCandidate[] = [];
  let floor = 1;
  while (out.length < Math.max(1, count)) {
    for (const letter of letters) {
      if (out.length >= Math.max(1, count)) break;
      out.push({
        address: `${address} — Apt ${floor}${letter}`,
        label: `Floor ${floor}`,
        tier: "unit",
        lat,
        lon,
        source: "derived",
      });
    }
    floor += 1;
  }
  return out;
}

/** How many doors either way to offer, by building type. */
function spanFor(type: BuildingType | null, spans: NeighbourSpans): number {
  if (type === "row_house") return Math.max(1, spans.rowHouseSpan);
  if (type === "semi_detached") return Math.max(1, spans.semiDetachedSpan);
  if (type === "detached") return Math.max(1, Math.ceil(spans.detachedNearby / 2));
  return 2;
}

/**
 * Resolve the buildings either side of the fire, the next ones out, and the
 * pair across the street. Google confirms them when connected; otherwise the
 * arithmetic candidates are offered and flagged as derived.
 */
export async function resolveNeighbours(input: {
  address: string;
  lat: number | null;
  lon: number | null;
  buildingType?: BuildingType | null;
  spans: NeighbourSpans;
}): Promise<NeighbourResult> {
  const { number, rest } = splitHouseNumber(input.address);
  const street = rest;
  const buildingType = input.buildingType ?? null;

  // A multi-unit building: the exposures are the other units, not the block.
  if (buildingType === "multi_family") {
    return {
      neighbours: unitCandidates(input.address, input.lat, input.lon, input.spans.multiFamilyUnits),
      street,
      houseNumber: number,
      buildingType,
      provider: "derived",
      resolved: true,
    };
  }

  if (number == null) {
    return {
      neighbours: [],
      street,
      houseNumber: null,
      buildingType,
      provider: "none",
      resolved: false,
    };
  }

  const span = spanFor(buildingType, input.spans);
  const plan: { n: number; tier: NeighbourTier; label: string }[] = [];
  for (let i = 1; i <= span; i += 1) {
    const step = i * 2; // same side of the street keeps the parity
    const tier: NeighbourTier = i === 1 ? "immediate" : "next";
    const label = i === 1 ? "Next door" : i === 2 ? "Two doors down" : `${i} doors down`;
    plan.push({ n: number - step, tier, label });
    plan.push({ n: number + step, tier, label });
  }
  // Opposite parity is the other side of the street.
  plan.push({ n: number - 1, tier: "across", label: "Across the street" });
  plan.push({ n: number + 1, tier: "across", label: "Across the street" });

  const viable = plan.filter((c) => c.n > 0);
  const auth = googleKey();

  const settled = await Promise.all(
    viable.map(async (c): Promise<NeighbourCandidate | null> => {
      const guess = `${c.n} ${street}`;
      if (!auth) {
        return {
          address: guess,
          label: c.label,
          tier: c.tier,
          lat: null,
          lon: null,
          source: "derived",
        };
      }
      const hit = await geocodeCached(guess, auth);
      if (!hit) return null;
      return {
        address: hit.address,
        label: c.label,
        tier: c.tier,
        lat: hit.lat,
        lon: hit.lon,
        source: "google",
      };
    }),
  );

  const seen = new Set<string>([input.address.toLowerCase()]);
  const neighbours: NeighbourCandidate[] = [];
  for (const c of settled) {
    if (!c) continue;
    const k = c.address.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    neighbours.push(c);
  }

  return {
    neighbours,
    street,
    houseNumber: number,
    buildingType,
    provider: auth ? "google" : "derived",
    resolved: neighbours.length > 0,
  };
}
