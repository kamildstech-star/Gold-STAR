/**
 * From "a source found something" to "lead, merge, or skip — and why".
 *
 * Pure: the run (run.server.ts) does the fetching, the model call, the
 * geocoding and the writes; every decision is made here, in this order, so
 * the tests can walk an item through the whole thing with recorded inputs:
 *
 *   1. triage  — is it a recent structure fire with somewhere to look?
 *   2. place   — after geocoding: is that inside a watch area?
 *   3. match   — is it a fire we already have (any source, BNN included)?
 *   4. payload — the row for `ingestIncident`, or the patch for a merge.
 *
 * Every skip has a reason key, counted per run and kept per item, so the
 * admin screen can say "14 not a fire, 3 outside your areas, 1 brush fire"
 * instead of "17 skipped".
 */
import type {
  IncidentPayload,
  IncidentSourceLink,
  TrustedIncidentExtras,
} from "@/lib/incident-payload";

import { areaForFire, areaPlaceName, type AreaMatch } from "./areas";
import { externalRefFor, sameFire, type FireSighting, type MatchReason } from "./dedupe";
import type { Extraction } from "./extract";
import type { FireSourceKind, RawItem, WatchArea } from "./types";

export interface FeedSettings {
  /** An item published longer ago than this is history, not a lead. */
  maxAgeHours: number;
  /** When true, a report that names only a town is skipped instead of landing for review. */
  requireStreetAddress: boolean;
  /** Read items with the AI gateway when it is configured. */
  useAi: boolean;
}

export const DEFAULT_FEED_SETTINGS: FeedSettings = {
  maxAgeHours: 36,
  requireStreetAddress: false,
  useAi: true,
};

/** The incidents.source value per source kind, so reports can split leads by where they came from. */
export const INCIDENT_SOURCE: Record<FireSourceKind, string> = {
  google_news: "google_news",
  rss: "rss",
  public_page: "public_page",
};

export type SkipReason =
  | "already_seen"
  | "not_a_fire"
  | "follow_up"
  | "brush_fire"
  | "vehicle_fire"
  | "other_fire"
  | "too_old"
  | "no_location"
  | "town_only"
  | "not_found"
  | "outside_areas";

export const SKIP_REASON_LABEL: Record<SkipReason, string> = {
  already_seen: "Already seen",
  not_a_fire: "Not a fire",
  follow_up: "About a past fire (charges, trial, cause, fundraiser)",
  brush_fire: "Brush or grass fire",
  vehicle_fire: "Vehicle or boat fire",
  other_fire: "Not a building (dumpster, pole, unclear)",
  too_old: "Too old",
  no_location: "No town or address in the report",
  town_only: "Town only, no street (street address required)",
  not_found: "Address could not be found on the map",
  outside_areas: "Outside every watch area",
};

/** Where to look, before the geocoder has answered. */
export interface LocatePlan {
  /** The geocoding query, or null when the item already carries a point. */
  query: string | null;
  point: { lat: number; lon: number } | null;
  /** Street-level (an address, cross streets, a 911 point) versus a town centroid. */
  streetLevel: boolean;
  /** Street line for the incident, when there is one. */
  address: string | null;
  /**
   * What the chase card shows when there is no house number: the cross
   * streets the report gave ("Gray Ridge Dr & Dahlia Field Way"), rather
   * than "Unknown address".
   */
  displayAddress?: string | null;
  locality: string | null;
  state: string | null;
  /** Why a person should look before driving, when they should. */
  reviewReason: string | null;
}

export type Triage = { skip: SkipReason } | { locate: LocatePlan };

function mentions(text: string, word: string | null): boolean {
  if (!word) return false;
  return new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text);
}

/** Step 1. */
export function triage(
  item: RawItem,
  ex: Extraction,
  areas: readonly WatchArea[],
  now: Date,
  settings: FeedSettings,
): Triage {
  if (ex.category === "not_fire") return { skip: "not_a_fire" };
  if (ex.followUp) return { skip: "follow_up" };
  if (ex.category === "brush") return { skip: "brush_fire" };
  if (ex.category === "vehicle") return { skip: "vehicle_fire" };
  if (ex.category !== "structure") return { skip: "other_fire" };

  if (item.publishedAt) {
    const ageHours = (now.getTime() - Date.parse(item.publishedAt)) / 3_600_000;
    if (ageHours > settings.maxAgeHours) return { skip: "too_old" };
  }

  // The area a SEARCH was run for places the item only when the item itself
  // names that town or county — a Lakewood query returns Plumsted stories,
  // and those are not Lakewood fires. A feed PINNED to an area is different:
  // LAFD's alerts are Los Angeles fires whether or not they say so, so the
  // pinned area names the town an item leaves out. The area check after
  // geocoding still decides.
  const text = `${item.title} ${item.text}`;
  const hint = areas.find((a) => a.id === item.areaId) ?? null;
  const hintNamed = hint && (mentions(text, hint.locality) || mentions(text, hint.county));
  const locality = ex.locality ?? (hint && (hintNamed || item.areaPinned) ? hint.locality : null);
  const localityArea = areas.find(
    (a) => a.locality && locality && a.locality.toLowerCase() === locality.toLowerCase(),
  );
  const state = ex.state ?? localityArea?.state ?? hint?.state ?? null;
  const place = [locality, state].filter(Boolean).join(", ");

  if (item.point) {
    // The feed's own point is used as it is. The address is still geocoded
    // when there is one, for its ZIP: the ZIP is what routes an incident to
    // a zone (incidents_classify), and a point alone would be admin-routed.
    return {
      locate: {
        query: ex.address && locality ? `${ex.address}, ${place}` : null,
        point: item.point,
        streetLevel: true,
        address: ex.address,
        displayAddress: ex.address ? null : ex.crossStreets,
        locality,
        state,
        reviewReason: null,
      },
    };
  }

  // A street with no town is "12 Main Street" somewhere in America; it is not
  // geocoded on its own.
  if (!locality) return { skip: "no_location" };

  if (ex.address) {
    return {
      locate: {
        query: `${ex.address}, ${place}`,
        point: null,
        streetLevel: true,
        address: ex.address,
        locality,
        state,
        reviewReason: ex.blockLevel
          ? "Block-level address from the report — the exact house is not known"
          : null,
      },
    };
  }

  if (ex.crossStreets) {
    return {
      locate: {
        query: `${ex.crossStreets}, ${place}`,
        point: null,
        streetLevel: true,
        address: null,
        displayAddress: ex.crossStreets,
        locality,
        state,
        reviewReason: `Cross streets only (${ex.crossStreets}) — the exact house is not known`,
      },
    };
  }

  if (settings.requireStreetAddress) return { skip: "town_only" };
  return {
    locate: {
      query: place,
      point: null,
      streetLevel: false,
      address: null,
      locality,
      state,
      reviewReason: "Town only — the report gave no street address",
    },
  };
}

/** What the geocoder said. */
export interface Geocoded {
  lat: number;
  lon: number;
  postalCode: string | null;
  formatted: string | null;
}

/**
 * The ZIP in a geocoder's formatted address. Google writes "…, Lakewood, NJ
 * 08701, USA"; the OpenStreetMap geocoders write the postcode as its own
 * comma-separated part ("…, New Jersey, 08701, United States"). A five-digit
 * house number at the start is never mistaken for one.
 */
export function postalCodeOf(formatted: string | null | undefined): string | null {
  if (!formatted) return null;
  const google = [...formatted.matchAll(/\b[A-Z]{2}\s+(\d{5})(?:-\d{4})?\b/g)].pop();
  if (google) return google[1]!;
  const osm = [...formatted.matchAll(/,\s*(\d{5})(?:-\d{4})?\s*(?=,|$)/g)].pop();
  return osm?.[1] ?? null;
}

/** Step 2. */
export function place(
  plan: LocatePlan,
  geo: Geocoded,
  areas: readonly WatchArea[],
  hintAreaId: string | null,
): AreaMatch | null {
  return areaForFire(
    {
      lat: geo.lat,
      lon: geo.lon,
      postalCode: geo.postalCode,
      locality: plan.locality,
      state: plan.state,
    },
    areas,
    hintAreaId,
  );
}

/** An incident already on file, as the matcher needs it. */
export interface CandidateIncident {
  id: string;
  source: string;
  address: string | null;
  locality: string | null;
  postal_code: string | null;
  lat: number | null;
  lon: number | null;
  reported_at: string;
  needs_review: boolean;
  review_reason: string | null;
  source_links: IncidentSourceLink[];
}

export function sightingOf(c: CandidateIncident): FireSighting {
  return {
    address: c.address,
    locality: c.locality,
    lat: c.lat,
    lon: c.lon,
    reportedAt: c.reported_at,
    streetLevel: Boolean(c.address),
  };
}

/** The new item, as the matcher sees it. */
export function sightingOfItem(
  item: RawItem,
  plan: LocatePlan,
  geo: Geocoded,
  now: Date,
): FireSighting {
  return {
    address: plan.address,
    locality: plan.locality,
    lat: geo.lat,
    lon: geo.lon,
    reportedAt: reportedAtFor(item, now),
    streetLevel: plan.streetLevel,
  };
}

/** Step 3: the earliest incident this is the same fire as. */
export function findMatch(
  s: FireSighting,
  candidates: readonly CandidateIncident[],
): { incident: CandidateIncident; reason: MatchReason } | null {
  const sorted = [...candidates].sort((a, b) => a.reported_at.localeCompare(b.reported_at));
  for (const c of sorted) {
    const reason = sameFire(s, sightingOf(c));
    if (reason) return { incident: c, reason };
  }
  return null;
}

/** The newest an item may claim to be, and the oldest a feed may backdate one. */
export function reportedAtFor(item: RawItem, now: Date): string {
  const t = item.publishedAt ? Date.parse(item.publishedAt) : Number.NaN;
  if (!Number.isFinite(t) || t > now.getTime()) return now.toISOString();
  return new Date(Math.max(t, now.getTime() - 7 * 86_400_000)).toISOString();
}

export function sourceLinkOf(item: RawItem): IncidentSourceLink {
  return {
    kind: INCIDENT_SOURCE[item.sourceKind],
    // Only a web address is kept; the chase card turns this into a link.
    url: item.url && /^https?:\/\//i.test(item.url) ? item.url : null,
    title: item.title.slice(0, 300),
    publisher: item.publisher,
    published_at: item.publishedAt,
  };
}

function factsLine(ex: Extraction): string | null {
  const facts = [
    ex.fatalities ? "Fatalities reported" : null,
    ex.injuries ? "Injuries reported" : null,
    ex.displaced ? "Residents displaced" : null,
  ].filter(Boolean);
  return facts.length ? facts.join(" · ") : null;
}

/** Step 4a: a new lead. */
export function leadPayload(
  item: RawItem,
  ex: Extraction,
  plan: LocatePlan,
  geo: Geocoded,
  match: AreaMatch,
  now: Date,
): { payload: IncidentPayload; extras: TrustedIncidentExtras } {
  const header = [item.publisher ? `${item.publisher}:` : null, item.title]
    .filter(Boolean)
    .join(" ");
  const raw = [
    header,
    factsLine(ex),
    item.text && item.text !== item.title ? item.text : null,
    item.url,
    `Fire feed · ${areaPlaceName(match.area)} · read by ${ex.method === "ai" ? "AI" : "rules"}`,
  ]
    .filter(Boolean)
    .join("\n");
  const payload: IncidentPayload = {
    source: INCIDENT_SOURCE[item.sourceKind],
    external_ref: externalRefFor(item.key),
    reported_at: reportedAtFor(item, now),
    incident_type: "fire",
    ...(ex.alarmLevel ? { alarm_level: ex.alarmLevel } : {}),
    ...(ex.buildingType ? { building_type: ex.buildingType.slice(0, 64) } : {}),
    ...(item.structured?.units != null ? { units_dispatched: item.structured.units } : {}),
    ...((plan.address ?? plan.displayAddress)
      ? { address: (plan.address ?? plan.displayAddress)!.slice(0, 300) }
      : {}),
    ...(plan.locality ? { locality: plan.locality } : {}),
    ...((plan.state ?? match.area.state) ? { region: plan.state ?? match.area.state } : {}),
    ...(geo.postalCode ? { postal_code: geo.postalCode } : {}),
    lat: geo.lat,
    lon: geo.lon,
    raw_text: raw.slice(0, 4000),
  };
  return {
    payload,
    extras: {
      source_links: [sourceLinkOf(item)],
      needs_review: plan.reviewReason != null,
      review_reason: plan.reviewReason,
    },
  };
}

/**
 * Step 4b: what a corroborating report adds to an incident already on file —
 * its link, always; and, when the incident only had a town and this report
 * has a street, the street (which re-runs zone routing in the database).
 */
export function mergePatch(
  incident: CandidateIncident,
  item: RawItem,
  plan: LocatePlan,
  geo: Geocoded,
): Record<string, unknown> | null {
  const link = sourceLinkOf(item);
  const links = incident.source_links ?? [];
  // A public incident page links every row to the same page, so there the
  // title is part of what makes a report the same report.
  const already = links.some(
    (l) =>
      (l.url && l.url === link.url && (link.kind !== "public_page" || l.title === link.title)) ||
      (!l.url && l.title === link.title),
  );
  const patch: Record<string, unknown> = {};
  if (!already) patch.source_links = [...links, link].slice(-25);
  // A lead that has only a town, or only cross streets, takes the first
  // house-number address a later report brings.
  const hasHouseNumber = Boolean(incident.address && /^\d/.test(incident.address.trim()));
  if (!hasHouseNumber && plan.address && plan.streetLevel) {
    patch.address = plan.address;
    patch.lat = geo.lat;
    patch.lon = geo.lon;
    if (geo.postalCode) patch.postal_code = geo.postalCode;
    if (
      incident.needs_review &&
      (incident.review_reason?.startsWith("Town only") ||
        incident.review_reason?.startsWith("Cross streets only"))
    ) {
      patch.needs_review = false;
      patch.review_reason = null;
    }
  }
  return Object.keys(patch).length ? patch : null;
}

/** The incident as a candidate for later items in the same run. */
export function candidateFromLead(
  id: string,
  payload: IncidentPayload,
  extras: TrustedIncidentExtras,
): CandidateIncident {
  return {
    id,
    source: payload.source,
    address: payload.address ?? null,
    locality: payload.locality ?? null,
    postal_code: payload.postal_code ?? null,
    lat: payload.lat ?? null,
    lon: payload.lon ?? null,
    reported_at: payload.reported_at ?? new Date().toISOString(),
    needs_review: extras.needs_review ?? false,
    review_reason: extras.review_reason ?? null,
    source_links: extras.source_links ?? [],
  };
}
