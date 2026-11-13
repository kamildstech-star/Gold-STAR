/**
 * The network half of the free public-record lookup: one guarded GET helper
 * and the per-area sequence of calls. Server-side only in practice (it runs
 * inside lookupIncidentPublicRecord), but has no server imports, so tests
 * drive it with a stub fetch and the recorded responses in ./fixtures.
 *
 * Every request: an address on the allowlist (exact origin + path, see
 * sources.ts) that also passes checkPublicUrl; no redirects followed (a
 * government API that starts redirecting is a change to look at, not to
 * chase); a timeout; and a size cap.
 */
import { checkPublicUrl } from "@/lib/public-url";

import {
  acrisLegalsUrl,
  acrisMasterUrl,
  geosearchReverseUrl,
  geosearchSearchUrl,
  isAllowedPublicRecordUrl,
  njParcelUrl,
  nysParcelUrl,
  parseAcrisLegals,
  parseAcrisMaster,
  parseGeosearch,
  parseNjParcels,
  parseNysParcels,
  parsePluto,
  plutoUrl,
  sourcesForPoint,
  type GeosearchHit,
  type PublicRecord,
  type PublicRecordSource,
} from "./sources";

export const PUBLIC_RECORD_USER_AGENT =
  "RecoveryHub-PublicRecord/1.0 (Gold Star Restoration; +https://goldstarrestoration.com)";
export const PUBLIC_RECORD_TIMEOUT_MS = 10_000;
export const PUBLIC_RECORD_MAX_BYTES = 1_000_000;

/** A reverse-geocoded NYC address point further than this is a different lot. */
const NYC_REVERSE_MAX_KM = 0.1;
/** An address match further than this from the incident's pin is not trusted. */
const NYC_SEARCH_MAX_KM = 0.3;

export type JsonFetch = { ok: true; json: unknown } | { ok: false; error: string };

export async function fetchPublicRecordJson(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string> = {},
): Promise<JsonFetch> {
  if (!isAllowedPublicRecordUrl(url)) return { ok: false, error: "Address not on the allowlist" };
  const check = checkPublicUrl(url);
  if (!check.ok) return { ok: false, error: check.reason };
  let res: Response;
  try {
    res = await fetchImpl(check.url.toString(), {
      headers: { "User-Agent": PUBLIC_RECORD_USER_AGENT, Accept: "application/json", ...headers },
      redirect: "manual",
      signal: AbortSignal.timeout(PUBLIC_RECORD_TIMEOUT_MS),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: /abort|timeout/i.test(msg) ? "Timed out" : msg.slice(0, 200) };
  }
  if (res.status >= 300 && res.status < 400) return { ok: false, error: "Unexpected redirect" };
  if (!res.ok) {
    return { ok: false, error: res.status === 429 ? "Rate limited (429)" : `HTTP ${res.status}` };
  }
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > PUBLIC_RECORD_MAX_BYTES) {
    return { ok: false, error: "Response too large" };
  }
  const body = await res.text();
  if (body.length > PUBLIC_RECORD_MAX_BYTES) return { ok: false, error: "Response too large" };
  try {
    return { ok: true, json: JSON.parse(body) };
  } catch {
    return { ok: false, error: "Not JSON" };
  }
}

export interface PublicRecordQuery {
  lat: number | null;
  lon: number | null;
  address: string | null;
  locality: string | null;
  postalCode: string | null;
}

export type PublicRecordOutcome =
  | { kind: "found"; record: PublicRecord }
  /** Every source answered and none has this parcel. Cacheable. */
  | { kind: "none"; reason: string; source: PublicRecordSource | null }
  /** A source failed. Not cached, so the next view tries again. */
  | { kind: "error"; reason: string };

export interface LookupDeps {
  fetch: typeof fetch;
  /** Optional NYC Open Data app token; raises the Socrata throttle. */
  socrataAppToken?: string | null;
}

export const NO_PUBLIC_RECORD = "No free public record for this area.";

function kmBetween(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

class SourceFailed extends Error {}

async function getJson(deps: LookupDeps, url: string): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (deps.socrataAppToken && url.startsWith("https://data.cityofnewyork.us/")) {
    headers["X-App-Token"] = deps.socrataAppToken;
  }
  const got = await fetchPublicRecordJson(deps.fetch, url, headers);
  if (!got.ok) throw new SourceFailed(`${new URL(url).host}: ${got.error}`);
  return got.json;
}

/** Point -> BBL, else the incident's address (with its ZIP as a guard) -> BBL. */
async function nycBbl(deps: LookupDeps, q: PublicRecordQuery): Promise<GeosearchHit | null> {
  if (q.lat !== null && q.lon !== null) {
    const hit = parseGeosearch(await getJson(deps, geosearchReverseUrl(q.lat, q.lon)));
    if (hit && (hit.distance_km ?? Infinity) <= NYC_REVERSE_MAX_KM) return hit;
  }
  // GeoSearch only knows NYC, so a New Jersey street with an NYC namesake
  // would match. The ZIP and the pin are the guards; with neither, no match.
  if (!q.address || (!q.postalCode && (q.lat === null || q.lon === null))) return null;
  const text = [q.address, q.locality, q.postalCode].filter(Boolean).join(", ");
  const hit = parseGeosearch(await getJson(deps, geosearchSearchUrl(text)));
  if (!hit) return null;
  if ((hit.confidence ?? 0) < 0.8) return null;
  if (q.postalCode && hit.postal_code && hit.postal_code !== q.postalCode.slice(0, 5)) return null;
  if (q.lat !== null && q.lon !== null && hit.lat !== null && hit.lon !== null) {
    if (kmBetween(q.lat, q.lon, hit.lat, hit.lon) > NYC_SEARCH_MAX_KM) return null;
  }
  return hit;
}

async function nycRecord(deps: LookupDeps, q: PublicRecordQuery): Promise<PublicRecord | null> {
  const hit = await nycBbl(deps, q);
  if (!hit) return null;
  const base = parsePluto(await getJson(deps, plutoUrl(hit.bbl)));
  if (!base) return null;
  // The last sale is a nice-to-have: ACRIS being slow must not cost the card
  // its owner and building facts.
  let sale = { last_sale_date: null as string | null, last_sale_amount: null as number | null };
  try {
    const legals = acrisLegalsUrl(hit.bbl);
    const ids = legals ? parseAcrisLegals(await getJson(deps, legals)) : [];
    const master = acrisMasterUrl(ids);
    if (master) sale = parseAcrisMaster(await getJson(deps, master));
  } catch (e) {
    console.warn("[public-record] ACRIS skipped:", e instanceof Error ? e.message : e);
  }
  return { ...base, ...sale };
}

/** Never throws. */
export async function lookupPublicRecord(
  q: PublicRecordQuery,
  deps: LookupDeps,
): Promise<PublicRecordOutcome> {
  const hasPoint = q.lat !== null && q.lon !== null;
  // No pin: only NYC can be found by address (GeoSearch); NJ and NYS are
  // point queries.
  const order: PublicRecordSource[] = hasPoint
    ? sourcesForPoint(q.lat!, q.lon!)
    : q.address
      ? ["nyc_pluto"]
      : [];
  if (!order.length) {
    return {
      kind: "none",
      source: null,
      reason: hasPoint || q.address ? NO_PUBLIC_RECORD : "This alert has no location to look up.",
    };
  }
  try {
    for (const source of order) {
      let record: PublicRecord | null = null;
      if (source === "nyc_pluto") record = await nycRecord(deps, q);
      else if (source === "nj_modiv")
        record = parseNjParcels(await getJson(deps, njParcelUrl(q.lat!, q.lon!)));
      else record = parseNysParcels(await getJson(deps, nysParcelUrl(q.lat!, q.lon!)));
      if (record) return { kind: "found", record };
    }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.warn("[public-record] lookup failed:", reason);
    return { kind: "error", reason: "The public record service did not answer. Try again later." };
  }
  return {
    kind: "none",
    source: order[0] ?? null,
    reason: "No public parcel record at this spot.",
  };
}
