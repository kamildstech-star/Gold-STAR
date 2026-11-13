/**
 * Google News, through the RSS endpoint Google publishes for exactly this.
 *
 * Not google.com search results: those forbid automated access, and an
 * account or address caught scraping them is blocked. news.google.com/rss is
 * a documented feed — no key, no login, the same thing a feed reader asks
 * for. One query per watch area, so a story is tied to the town it was found
 * for, with `when:1d` so a quiet town costs a few items, not a year of them.
 *
 * NOTE FOR MARK, from the feed itself: every Google News RSS response carries
 * Google's notice that the feed is "made available solely for the purpose of
 * rendering Google News results within a personal feed reader for personal,
 * non-commercial use". A restoration company's CRM is commercial use. The
 * source ships switched on in the code but the whole feed is OFF until an
 * admin turns it on, and the admin screen repeats this notice next to the
 * Google News row — whether to rely on it is Gold Star's call, not ours.
 */
import type { WatchArea } from "./types";

/** What a fire story says, in the words reporters use. */
export const GOOGLE_NEWS_FIRE_TERMS = [
  "fire",
  '"house fire"',
  '"structure fire"',
  "blaze",
  '"2-alarm"',
  '"3-alarm"',
] as const;

function quoted(s: string): string {
  return `"${s.replace(/"/g, "").trim()}"`;
}

/**
 * `(fire OR "house fire" OR …) ("Lakewood" OR "Ocean County") NJ when:1d`.
 * The state goes in unquoted so "Lakewood" in Ohio and Colorado rank below
 * Lakewood, New Jersey without excluding a story that only names the county.
 */
export function googleNewsQuery(area: Pick<WatchArea, "locality" | "county" | "state">): string {
  const places = [
    area.locality ? quoted(area.locality) : null,
    area.county ? quoted(`${area.county.replace(/\s+county$/i, "")} County`) : null,
  ].filter((p): p is string => Boolean(p));
  const where = places.length > 1 ? `(${places.join(" OR ")})` : (places[0] ?? "");
  return `(${GOOGLE_NEWS_FIRE_TERMS.join(" OR ")}) ${where} ${area.state} when:1d`
    .replace(/\s+/g, " ")
    .trim();
}

export function googleNewsUrl(area: Pick<WatchArea, "locality" | "county" | "state">): string {
  const q = encodeURIComponent(googleNewsQuery(area));
  return `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
}

/**
 * Google News titles are "Headline - Publisher". The publisher is split off
 * so the headline is what the extractor reads (a paper called "Fire Island
 * News" must not make a story a fire) and so the chase card can say who
 * reported it.
 */
export function splitPublisher(
  title: string,
  source: string | null,
): { headline: string; publisher: string | null } {
  const t = title.trim();
  if (source) {
    const suffix = ` - ${source.trim()}`;
    if (t.endsWith(suffix))
      return { headline: t.slice(0, -suffix.length).trim(), publisher: source.trim() };
  }
  const i = t.lastIndexOf(" - ");
  if (i > 0 && t.length - i < 70) {
    return { headline: t.slice(0, i).trim(), publisher: source?.trim() || t.slice(i + 3).trim() };
  }
  return { headline: t, publisher: source?.trim() || null };
}
