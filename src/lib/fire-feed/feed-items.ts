/**
 * Parsed feed items → the fire feed's RawItems, shared by the RSS source and
 * the public incident page source's RSS preset so both read a feed the same
 * way.
 *
 * What it settles, because real government feeds needed each one (11 Oct):
 *  - Notify NYC repeats every alert in about twelve languages and marks the
 *    language only in <author> ("NYCEM [English]"), so `authorFilter` keeps
 *    the items whose author contains it.
 *  - LAFD prints "Sunday, October 11, 2026 - 07:40" with no zone; a date the
 *    RSS parser could not read is read from the raw text in the source's own
 *    time zone (its setting, else the watch area's state), never the
 *    server's.
 *  - A publisher typed on the source wins over a feed's own <source> text
 *    (LAFD's says only "Alerts Feed").
 *  - A source pinned to one watch area names the town for items that name
 *    none (LAFD's addresses come without "Los Angeles").
 */
import { canonicalUrl } from "./dedupe";
import { parsePageTime } from "./public-page";
import type { FeedItem } from "./rss-parse";
import type { FireSourceKind, RawItem } from "./types";

export interface FeedItemOptions {
  kind: FireSourceKind;
  sourceId: string;
  /** The source's name on screen, the publisher of last resort. */
  label: string;
  /** Typed on the source (config.publisher); beats the feed's own <source>. */
  publisher?: string | null;
  /** The feed's host, for keys built from a guid or a title. */
  host: string;
  areaId: string | null;
  now: Date;
  timeZone: string;
  /** Keep only items whose <author> contains this, ignoring case. */
  authorFilter?: string | null;
  /** Prepended to every key, so two source kinds never share one. */
  keyPrefix?: string;
}

export function feedItemsToRaw(parsed: readonly FeedItem[], o: FeedItemOptions): RawItem[] {
  const filter = o.authorFilter?.trim().toLowerCase() || null;
  const kept = filter
    ? parsed.filter((f) => (f.author ?? "").toLowerCase().includes(filter))
    : [...parsed];

  // The guid is RSS's own identity for an item, so it comes first (as a
  // canonical URL when it is one, so two feeds carrying the same article
  // agree). Some 911 feeds link every item to the same listing page, so a
  // link is only an identity when no other item shares it.
  const linkCount = new Map<string, number>();
  for (const f of kept) {
    const c = canonicalUrl(f.link);
    if (c) linkCount.set(c, (linkCount.get(c) ?? 0) + 1);
  }
  const keyOf = (f: FeedItem) => {
    if (f.guid) return canonicalUrl(f.guid) ?? `${o.host}:${f.guid}`;
    const c = canonicalUrl(f.link);
    if (c && linkCount.get(c) === 1) return c;
    return `${o.host}:${f.title}`;
  };
  const publisher = o.publisher?.trim() || null;

  return kept.map((f) => ({
    key: `${o.keyPrefix ?? ""}${keyOf(f)}`,
    sourceKind: o.kind,
    sourceId: o.sourceId,
    title: f.title,
    url: f.link,
    publisher: publisher ?? f.source ?? o.label,
    publishedAt: f.published ?? parsePageTime(f.publishedRaw, o.now, o.timeZone),
    text: f.description,
    areaId: o.areaId,
    areaPinned: o.areaId != null,
    point: f.lat != null && f.lon != null ? { lat: f.lat, lon: f.lon } : null,
  }));
}
