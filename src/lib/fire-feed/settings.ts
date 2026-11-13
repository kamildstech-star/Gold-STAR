/**
 * The fire feed's switches, in `app_settings` under the key `fire_feed`
 * (seeded `{"enabled": false}` by migration 20261011140000).
 *
 * Off until an admin turns it on. The migration seeds a Google News source
 * and a watch area per office, so the moment it is on, leads can land in the
 * chase deck — and Google News's own terms (see google-news.ts) are Gold
 * Star's to accept, not ours.
 */
import { DEFAULT_FEED_SETTINGS, type FeedSettings } from "./decide";

export const FIRE_FEED_SETTINGS_KEY = "fire_feed";

export interface FireFeedConfig extends FeedSettings {
  enabled: boolean;
}

function num(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** Whatever the row holds, as settings with every gap filled by the default. */
export function parseFireFeedConfig(value: unknown): FireFeedConfig {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return {
    enabled: v.enabled === true,
    maxAgeHours: num(v.max_age_hours, DEFAULT_FEED_SETTINGS.maxAgeHours, 1, 168),
    requireStreetAddress: v.require_street_address === true,
    useAi: v.use_ai === undefined ? DEFAULT_FEED_SETTINGS.useAi : v.use_ai === true,
  };
}

/** The row's value after an admin changes one switch; keys this screen does not own are kept. */
export function withFireFeedConfig(
  current: unknown,
  patch: Partial<{
    enabled: boolean;
    max_age_hours: number;
    require_street_address: boolean;
    use_ai: boolean;
  }>,
): Record<string, unknown> {
  const base =
    current && typeof current === "object" ? { ...(current as Record<string, unknown>) } : {};
  return { ...base, ...patch };
}
