/**
 * RSS 2.0, RSS 1.0 (RDF) and Atom, read without a DOM.
 *
 * The fire feed runs in a Cloudflare Worker, which has no DOMParser, and a
 * feed is a small, regular document: a list of items, each with a handful of
 * well-known children. So this reads exactly those children and nothing
 * else — no entity expansion beyond the five XML ones and numeric references,
 * no DTDs, no external anything. A feed is untrusted input; the most it can
 * do here is produce a strange title, which the pipeline then refuses as "not
 * a fire".
 *
 * What it understands, because the feeds we care about use it:
 *  - Google News: `<title>` is "Headline - Publisher", `<source>` names the
 *    publisher, `<guid>` is Google's stable id for the story.
 *  - County 911 feeds (Monroe County, NY publishes one): `geo:lat` and
 *    `geo:long` per item, or GeoRSS `georss:point`.
 *  - Fire department and local news sites: plain RSS or Atom.
 */

export interface FeedItem {
  title: string;
  link: string | null;
  guid: string | null;
  /** ISO, or null when the feed's date could not be read. */
  published: string | null;
  /** Description / summary / content, tags stripped, entities decoded. */
  description: string;
  /** RSS `<source>` text, when present (Google News sets it). */
  source: string | null;
  /** `<author>` / `<dc:creator>` — Notify NYC puts the language here ("NYCEM [English]"). */
  author: string | null;
  /** Every `<category>`, in order. */
  categories: string[];
  /**
   * The date exactly as the feed printed it, for feeds whose dates are not
   * RFC 822 ("Sunday, October 11, 2026 - 07:40", LAFD) and carry no zone —
   * the source reads those in its own time zone.
   */
  publishedRaw: string | null;
  lat: number | null;
  lon: number | null;
}

/** Cap on what one feed may hand the pipeline, whatever it claims to hold. */
export const MAX_FEED_ITEMS = 200;

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** The five XML entities, &nbsp; (HTML-in-RSS is everywhere) and numeric references. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ent: string) => {
    if (ent[0] === "#") {
      const code =
        ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : Number(ent.slice(1));
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return "";
      try {
        return String.fromCodePoint(code);
      } catch {
        return "";
      }
    }
    return NAMED[ent.toLowerCase()] ?? whole;
  });
}

/** CDATA unwrapped, markup removed, entities decoded, whitespace collapsed. */
export function textOf(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, inner: string) => inner);
  // Escaped HTML inside a description (Google News does this) is decoded
  // first, then stripped like any other markup.
  s = decodeEntities(s);
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  // LAFD escapes its HTML twice (&amp;lt;a href…), so the second decode can
  // still leave markup behind; strip it once more.
  s = s.replace(/<[^>]+>/g, " ");
  return s.replace(/\s+/g, " ").trim();
}

function escapeTag(tag: string): string {
  return tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Inner XML of the first `<tag>` child, or null. Namespaced tags work ("geo:lat"). */
function child(block: string, tag: string): string | null {
  const t = escapeTag(tag);
  const m = new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)</${t}>`, "i").exec(block);
  return m ? m[1]! : null;
}

function attr(tagSource: string, name: string): string | null {
  const m = new RegExp(`\\s${escapeTag(name)}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tagSource);
  return m ? decodeEntities(m[2] ?? m[3] ?? "") : null;
}

/** Atom: the alternate link, else the first link with an href. */
function atomLink(block: string): string | null {
  const links = [...block.matchAll(/<link\b[^>]*\/?>/gi)].map((m) => m[0]);
  const alternate = links.find((l) => {
    const rel = attr(l, "rel");
    return !rel || rel === "alternate";
  });
  const pick = alternate ?? links[0];
  return pick ? attr(pick, "href") : null;
}

/** RFC 822 (RSS), ISO 8601 (Atom, dc:date); null when neither parses. */
export function parseFeedDate(raw: string | null | undefined): string | null {
  const s = textOf(raw);
  if (!s) return null;
  const t = Date.parse(s);
  if (Number.isFinite(t)) return new Date(t).toISOString();
  // "Sun, 11 Oct 2026 17:09:00 EDT" — Date.parse knows the US zones, but some
  // feeds send zones it does not; drop the zone and read it as UTC rather
  // than lose the item's time altogether.
  const noZone = s.replace(/\s+[A-Z]{2,5}$/, " GMT");
  const t2 = Date.parse(noZone);
  return Number.isFinite(t2) ? new Date(t2).toISOString() : null;
}

function num(raw: string | null): number | null {
  if (raw == null) return null;
  const n = Number(textOf(raw).replace(/^\+/, ""));
  return Number.isFinite(n) ? n : null;
}

function point(block: string): { lat: number | null; lon: number | null } {
  let lat = num(child(block, "geo:lat"));
  let lon = num(child(block, "geo:long") ?? child(block, "geo:lon"));
  if (lat == null || lon == null) {
    const p = textOf(child(block, "georss:point"));
    const m = /^(-?\d+(?:\.\d+)?)[\s,]+(-?\d+(?:\.\d+)?)$/.exec(p);
    if (m) {
      lat = Number(m[1]);
      lon = Number(m[2]);
    }
  }
  if (lat == null || lon == null || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return { lat: null, lon: null };
  }
  return { lat, lon };
}

/**
 * A link or guid that is a URL, or HTML that holds one. LAFD's feed wraps
 * both in an anchor — `<link><a href="/alert/…">view</a></link>` — so the
 * text alone is the word "view" on every item, which would make every item
 * the same item. The anchor's href wins, resolved against the feed's URL.
 */
function urlOrText(inner: string | null, base: string | undefined): string | null {
  if (inner == null) return null;
  const unwrapped = decodeEntities(
    inner.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, i: string) => i),
  );
  const anchor = /<a\b[^>]*?\shref\s*=\s*("([^"]*)"|'([^']*)')/i.exec(unwrapped);
  const raw = anchor ? decodeEntities(anchor[2] ?? anchor[3] ?? "") : textOf(inner);
  if (!raw) return null;
  if (anchor || raw.startsWith("/")) {
    try {
      return base ? new URL(raw, base).toString() : raw;
    } catch {
      return raw;
    }
  }
  return raw;
}

function rssItem(block: string, base: string | undefined): FeedItem {
  const linkRaw = child(block, "link");
  const link = linkRaw != null ? urlOrText(linkRaw, base) : atomLink(block);
  const { lat, lon } = point(block);
  const dateRaw = child(block, "pubDate") ?? child(block, "dc:date") ?? child(block, "published");
  return {
    title: textOf(child(block, "title")),
    link: link || null,
    guid: urlOrText(child(block, "guid"), base) || null,
    published: parseFeedDate(dateRaw),
    description: textOf(
      child(block, "description") ?? child(block, "content:encoded") ?? child(block, "summary"),
    ),
    source: textOf(child(block, "source")) || null,
    author: textOf(child(block, "author") ?? child(block, "dc:creator")) || null,
    categories: [...block.matchAll(/<category\b[^>]*>([\s\S]*?)<\/category>/gi)]
      .map((m) => textOf(m[1]))
      .filter(Boolean),
    publishedRaw: textOf(dateRaw) || null,
    lat,
    lon,
  };
}

function atomEntry(block: string): FeedItem {
  const { lat, lon } = point(block);
  return {
    title: textOf(child(block, "title")),
    link: atomLink(block),
    guid: textOf(child(block, "id")) || null,
    published: parseFeedDate(child(block, "published") ?? child(block, "updated")),
    description: textOf(child(block, "summary") ?? child(block, "content")),
    source: textOf(child(child(block, "source") ?? "", "title")) || null,
    author: textOf(child(child(block, "author") ?? "", "name") ?? child(block, "author")) || null,
    categories: [...block.matchAll(/<category\b[^>]*?\sterm\s*=\s*"([^"]*)"/gi)].map((m) =>
      decodeEntities(m[1]!),
    ),
    publishedRaw: textOf(child(block, "published") ?? child(block, "updated")) || null,
    lat,
    lon,
  };
}

export type FeedFormat = "rss" | "atom" | "unknown";

export function detectFeedFormat(xml: string): FeedFormat {
  const head = xml.slice(0, 2000);
  if (/<rss[\s>]|<rdf:RDF[\s>]/i.test(head)) return "rss";
  if (/<feed[\s>]/i.test(head)) return "atom";
  if (/<item[\s>]/i.test(xml)) return "rss";
  if (/<entry[\s>]/i.test(xml)) return "atom";
  return "unknown";
}

/**
 * Every item in the feed, in feed order, capped at MAX_FEED_ITEMS. Items with
 * neither a title nor a link are dropped — there is nothing to read in them.
 * `baseUrl` (the feed's own address) resolves relative links.
 */
export function parseFeed(xml: string, baseUrl?: string): FeedItem[] {
  const format = detectFeedFormat(xml);
  if (format === "unknown") return [];
  const re =
    format === "atom" ? /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi : /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  const out: FeedItem[] = [];
  for (const m of xml.matchAll(re)) {
    const item = format === "atom" ? atomEntry(m[1]!) : rssItem(m[1]!, baseUrl);
    if (!item.title && !item.link) continue;
    out.push(item);
    if (out.length >= MAX_FEED_ITEMS) break;
  }
  return out;
}
