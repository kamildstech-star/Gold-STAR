/**
 * Is this the same fire as one we already have?
 *
 * Three different questions, answered in order of how sure they are:
 *  1. Have we seen this exact ITEM before? A canonical URL, a feed guid or a
 *     911 center's incident id. That is the ledger (`fire_feed_items`), and a
 *     seen item is skipped before any work is spent on it.
 *  2. Is it the same ADDRESS, close in time? Two papers writing up the same
 *     house fire. Street addresses are normalised ("St" / "Street", "N" /
 *     "North") and compared exactly, or the two geocoded points are within a
 *     few dozen yards.
 *  3. Is it the same TOWN, close in time, where at least one side never had a
 *     street? "Fire damages Lakewood home" and, an hour later, "Fire at 12
 *     Main St, Lakewood". That is the weakest rule and the window is short;
 *     the cost of a wrong merge is one lead that should have been two, and
 *     the second story's link is still on the first incident for anyone who
 *     reads it.
 *
 * A match MERGES: the new item's link is added to the incident's
 * `source_links`, so a chaser sees every report of the fire on one card, and
 * a street address that arrives later fills in a town-only lead.
 */

const TRACKING_PARAM = /^(utm_[a-z]+|fbclid|gclid|mc_[a-z]+|ocid|cmpid|oc|ref|src|taid|smid)$/i;

/**
 * One spelling per article: lower-case host without "www." or "amp.", no
 * fragment, no tracking parameters, no trailing slash, no AMP suffix. Null
 * when the string is not an http(s) URL.
 */
export function canonicalUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase().replace(/^(www|amp|m)\./, "");
  const keep = [...u.searchParams.entries()]
    .filter(([k]) => !TRACKING_PARAM.test(k))
    .sort(([a], [b]) => a.localeCompare(b));
  const query = keep.length ? `?${new URLSearchParams(keep).toString()}` : "";
  const path = u.pathname.replace(/\/amp\/?$/i, "/").replace(/\/+$/, "") || "/";
  return `https://${host}${path === "/" ? "" : path}${query}`;
}

/**
 * The incident's external_ref: the item key, short enough for the column
 * (128). A longer key keeps its readable head and gains a hash of the whole,
 * so two long URLs that share a prefix never collide.
 */
export function externalRefFor(key: string): string {
  if (key.length <= 128) return key;
  return `${key.slice(0, 100)}#${fnv1a(key)}`;
}

/**
 * The key as the ledger stores it (fire_feed_items.item_key, at most 300).
 * Google News guids alone run past 300 characters, so a long key keeps its
 * head and gains a hash of the whole — and the lookup uses the same form, or
 * a truncated key would never match and every story would be "new" forever.
 */
export function ledgerKey(key: string): string {
  if (key.length <= 300) return key;
  return `${key.slice(0, 280)}#${fnv1a(key)}`;
}

/** 64-bit FNV-1a as 16 hex characters. Not cryptographic; it only has to spread. */
export function fnv1a(s: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * prime) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

const SUFFIX: Record<string, string> = {
  st: "street",
  str: "street",
  ave: "avenue",
  av: "avenue",
  rd: "road",
  dr: "drive",
  ln: "lane",
  ct: "court",
  pl: "place",
  blvd: "boulevard",
  ter: "terrace",
  terr: "terrace",
  cir: "circle",
  pkwy: "parkway",
  hwy: "highway",
  rt: "route",
  rte: "route",
  tpke: "turnpike",
  sq: "square",
  trl: "trail",
  hts: "heights",
  n: "north",
  s: "south",
  e: "east",
  w: "west",
  mt: "mount",
};

/** "12 N. Main St., Apt 3" → "12 north main street". Null without a house number. */
export function normalizeStreetAddress(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw
    .toLowerCase()
    .replace(/\b(apt|apartment|unit|suite|ste|fl|floor)\b.*$/, "")
    .replace(/#.*$/, "")
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!/^\d/.test(s)) return null;
  return s
    .split(" ")
    .map((w) => SUFFIX[w] ?? w)
    .join(" ");
}

export function normalizeLocality(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw
    .toLowerCase()
    .replace(/\b(township|twp|borough|boro|village|city|town)( of)?\b/g, "")
    .replace(/[^a-z ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s || null;
}

/** Haversine in miles. Same formula as `distanceMiles` in incidents.ts, kept dependency-free. */
export function milesBetween(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const R = 3958.7613;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** What the matcher needs to know about one fire, from either side. */
export interface FireSighting {
  /** Street line ("12 Main St"), or null when the report gave only a town. */
  address: string | null;
  locality: string | null;
  lat: number | null;
  lon: number | null;
  /** ISO. */
  reportedAt: string;
  /** True when the coordinates are a street geocode, not a town centroid. */
  streetLevel: boolean;
}

export const DEDUPE_RULES = {
  /** Same street address within this many hours is one fire. */
  addressHours: 24,
  /** Two street-level points this close are one building. */
  sameBuildingMiles: 0.05,
  /** Town-only matching is much looser, so its window is much shorter. */
  townHours: 6,
} as const;

export type MatchReason = "same_address" | "same_point" | "same_town";

/** Why `a` and `b` are the same fire, or null when they are not. */
export function sameFire(a: FireSighting, b: FireSighting): MatchReason | null {
  const hours = Math.abs(Date.parse(a.reportedAt) - Date.parse(b.reportedAt)) / 3_600_000;
  if (!Number.isFinite(hours)) return null;

  const na = normalizeStreetAddress(a.address);
  const nb = normalizeStreetAddress(b.address);
  const la = normalizeLocality(a.locality);
  const lb = normalizeLocality(b.locality);
  const townsAgree = !la || !lb || la === lb;

  if (na && nb) {
    if (hours > DEDUPE_RULES.addressHours) return null;
    if (na === nb && townsAgree) return "same_address";
    if (
      a.streetLevel &&
      b.streetLevel &&
      a.lat != null &&
      a.lon != null &&
      b.lat != null &&
      b.lon != null &&
      milesBetween({ lat: a.lat, lon: a.lon }, { lat: b.lat, lon: b.lon }) <=
        DEDUPE_RULES.sameBuildingMiles
    ) {
      return "same_point";
    }
    // Two different street addresses are two fires, however close in time.
    return null;
  }

  if (hours > DEDUPE_RULES.townHours) return null;
  if (la && lb && la === lb) return "same_town";
  return null;
}
