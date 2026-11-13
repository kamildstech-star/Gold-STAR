/**
 * Who sees which vehicles, and how old "where it is" really is.
 *
 * Both halves come from David's 16 Sep walkthrough of Fleet:
 *
 *   · vehicles should be a location's own, with corporate seeing across them;
 *   · he read a last-known position dated "Sep 10" as where the van was on
 *     Thursday. The feed was days behind and the screen did not say so.
 *
 * Pure on purpose. Who may see what is the kind of rule that should be
 * readable and testable without a database in front of it, and the second half
 * is arithmetic on a timestamp.
 */

import { type AppRole } from "@/lib/roles";

/* ------------------------------------------------------------------ */
/* Who sees which vehicles                                             */
/* ------------------------------------------------------------------ */

/**
 * Roles that legitimately look across offices.
 *
 * `regional` is here because a regional manager's job is several locations at
 * once; `location_manager` is deliberately NOT, because a location manager is
 * the one person this rule exists to bound.
 */
const CROSS_LOCATION_ROLES: readonly AppRole[] = ["owner", "admin", "dev", "regional"];

export function seesAllLocations(roles: readonly AppRole[]): boolean {
  return roles.some((r) => CROSS_LOCATION_ROLES.includes(r));
}

/**
 * Which locations' vehicles a viewer may be shown.
 *
 * `null` means "no location filter" — every vehicle the database will return —
 * and is only ever the answer for a cross-location role. Everyone else gets an
 * explicit list, and **an empty list is a real answer**: a location user with
 * no location sees no vehicles.
 *
 * That last point is the fix. The page asked `if (currentLocationId) …`, so a
 * location manager whose sidebar sat on "All my locations" — the default, since
 * nothing is stored until somebody picks an office — fell through the `if` and
 * was served every office's vans. The bug was invisible precisely because it
 * looked like the filter was there.
 */
export function fleetLocationFilter(input: {
  roles: readonly AppRole[];
  /** The sidebar Context switcher. Null when it reads "All my locations". */
  currentLocationId: string | null;
  /** Every office this user may see at all. */
  visibleLocationIds: readonly string[];
}): string[] | null {
  const { roles, currentLocationId, visibleLocationIds } = input;

  if (seesAllLocations(roles)) {
    // Corporate narrowed to one office by the switcher still means that office.
    return currentLocationId ? [currentLocationId] : null;
  }

  // A named office, but only one this viewer is actually allowed to see. A
  // stale switcher value must never widen anything.
  if (currentLocationId && visibleLocationIds.includes(currentLocationId)) {
    return [currentLocationId];
  }

  // "All my locations" means all of MINE, which is a bounded list — not
  // everyone's. With no locations at all it is the empty list, and the caller
  // shows nothing rather than everything.
  return [...visibleLocationIds];
}

/* ------------------------------------------------------------------ */
/* How old a position is                                               */
/* ------------------------------------------------------------------ */

export type FreshnessLevel = "live" | "recent" | "stale" | "very_stale" | "never";

export type Freshness = {
  level: FreshnessLevel;
  /** Minutes since the fix, or null when there has never been one. */
  minutes: number | null;
  /** "4m ago", "6 days ago", "never". Never a bare date. */
  ageLabel: string;
  /** Set when the position is too old to be read as current. */
  warning: string | null;
};

/** Under this, a fix is as good as live. */
const LIVE_MINUTES = 15;
/** Over this, it is stale and the screen says so. */
const STALE_MINUTES = 60;
/** Over this, it is history rather than a position. */
const VERY_STALE_MINUTES = 24 * 60;

export function minutesSince(ts: string | null | undefined, now = Date.now()): number | null {
  if (!ts) return null;
  const parsed = Date.parse(ts);
  if (Number.isNaN(parsed)) return null;
  // A clock skewed slightly ahead of the server should read as "just now",
  // never as a negative age.
  return Math.max(0, Math.round((now - parsed) / 60_000));
}

/**
 * How long ago, in the coarsest unit that is still honest.
 *
 * Anything past a day used to print a bare local date — "10/09/2026, 15:14" —
 * which is exactly how a six-day-old fix got read as Thursday's. Days are
 * spelled out so the number itself carries the warning.
 */
export function ageLabel(minutes: number | null): string {
  if (minutes == null) return "never";
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < VERY_STALE_MINUTES) return `${Math.round(minutes / 60)}h ago`;
  const days = Math.round(minutes / VERY_STALE_MINUTES);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export function freshnessOf(ts: string | null | undefined, now = Date.now()): Freshness {
  const minutes = minutesSince(ts, now);
  if (minutes == null) {
    return {
      level: "never",
      minutes: null,
      ageLabel: "never",
      warning: "No position has ever been received for this vehicle.",
    };
  }
  const label = ageLabel(minutes);
  if (minutes < LIVE_MINUTES) return { level: "live", minutes, ageLabel: label, warning: null };
  if (minutes < STALE_MINUTES) return { level: "recent", minutes, ageLabel: label, warning: null };
  if (minutes < VERY_STALE_MINUTES) {
    return {
      level: "stale",
      minutes,
      ageLabel: label,
      warning: `Last fix ${label}. This is where the vehicle was, not where it is.`,
    };
  }
  return {
    level: "very_stale",
    minutes,
    ageLabel: label,
    warning: `Last fix ${label}. The tracker has not reported since — treat this as history, not a location.`,
  };
}

/** True when a position is too old to be presented as current. */
export function isStalePosition(f: Freshness): boolean {
  return f.level === "stale" || f.level === "very_stale" || f.level === "never";
}

/**
 * The whole feed's health, from the newest fix on any vehicle.
 *
 * A single van parked in a shed for a week is ordinary. Every van silent for a
 * week is the Raven feed being down, and that is worth saying once at the top
 * rather than as a stale badge on each of twelve rows.
 */
export function feedFreshness(
  positions: readonly (string | null | undefined)[],
  now = Date.now(),
): Freshness {
  let newest: number | null = null;
  for (const ts of positions) {
    const m = minutesSince(ts, now);
    if (m == null) continue;
    if (newest == null || m < newest) newest = m;
  }
  if (newest == null) return freshnessOf(null, now);
  return freshnessOf(new Date(now - newest * 60_000).toISOString(), now);
}

/** Past this, the fleet's live counts are not live. The header badge uses the same hour. */
export const LIVE_FEED_MAX_MINUTES = 60;

export type LiveFeedState = {
  /** True while positions are still arriving — the live tiles may show a number. */
  live: boolean;
  /** Why not, in a sentence a manager can act on. Null while live. */
  reason: string | null;
};

/**
 * Can the "Moving now" and "Near incident" tiles be believed?
 *
 * A zero from a dead feed reads exactly like a quiet fleet. In October the
 * Raven poller failed every five minutes for hours (Klashwerks answering
 * HTTP 403 at its token endpoint) and the page said "0 MOVING NOW" with a
 * straight face. When the feed is down those tiles say so instead of
 * counting. The sync job records its failure on the integration row
 * (`integration_connections.status = 'error'`, `last_error`); when this
 * viewer can read that row its message is the reason, and when they cannot,
 * the age of the newest fix still tells the truth.
 */
export function liveFeedState(input: {
  newestAt: string | null;
  ravenStatus?: string | null;
  ravenError?: string | null;
  now: number;
}): LiveFeedState {
  const age = minutesSince(input.newestAt, input.now);
  const live = age != null && age <= LIVE_FEED_MAX_MINUTES;
  if (live) return { live, reason: null };
  if (input.ravenStatus === "error" && input.ravenError?.trim()) {
    const msg = input.ravenError.trim();
    return {
      live,
      reason: `The Raven dashcam sync is failing: ${msg.length > 180 ? `${msg.slice(0, 177)}…` : msg}`,
    };
  }
  if (age == null) return { live, reason: "No vehicle position has ever been received." };
  return {
    live,
    reason: `Last position from any vehicle: ${ageLabel(age)}. The live feed has stopped.`,
  };
}
