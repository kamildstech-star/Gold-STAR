/**
 * Any RSS or Atom feed an admin adds: a fire department's alerts, a local
 * paper's breaking-news feed, a county 911 feed (Monroe County, NY publishes
 * one with coordinates on every item). A feed is published to be read by
 * machines, so this is the cheapest compliant source there is.
 *
 * The feed's own coordinates are used when it has them; otherwise the
 * pipeline reads the item like any news story. Settings in `config`, all
 * optional:
 *  - `publisher`: names the feed on a lead (wins over the feed's <source>);
 *  - `author_filter`: keep only items whose <author> contains this (Notify
 *    NYC: "[English]", one of its ~12 language copies);
 *  - `timezone`: for dates printed without a zone (LAFD); otherwise the
 *    pinned watch area's state decides.
 */
import { feedItemsToRaw } from "../feed-items";
import { fetchFeed } from "../feed-fetch";
import { sourceTimeZone } from "../public-page";
import { parseFeed } from "../rss-parse";
import type { FetchContext, FetchResult, FireSource } from "../types";

function configString(config: Record<string, unknown>, key: string): string | null {
  const v = config[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

const source: FireSource = {
  kind: "rss",
  label: "RSS / Atom feed",
  async fetch(ctx: FetchContext): Promise<FetchResult> {
    const url = ctx.source.url;
    if (!url) return { items: [], state: { error: "No feed URL" } };
    const res = await fetchFeed(ctx.fetch, url, {
      etag: ctx.source.etag,
      lastModified: ctx.source.last_modified,
    });
    if (!res.ok) return { items: [], state: { status: res.status, error: res.error } };
    if ("notModified" in res) {
      return {
        items: [],
        state: { status: 304, notModified: true, etag: res.etag, lastModified: res.lastModified },
      };
    }
    const parsed = parseFeed(res.body, url);
    if (parsed.length === 0 && !/<(rss|feed|rdf:RDF)[\s>]/i.test(res.body.slice(0, 2000))) {
      return {
        items: [],
        state: { status: res.status, error: "That URL did not return an RSS or Atom feed" },
      };
    }
    let host = "feed";
    try {
      host = new URL(url).hostname.replace(/^www\./, "");
    } catch {
      /* the URL was validated on the way in; keep the fallback */
    }
    const authorFilter = configString(ctx.source.config, "author_filter");
    const items = feedItemsToRaw(parsed, {
      kind: "rss",
      sourceId: ctx.source.id,
      label: ctx.source.label,
      publisher: configString(ctx.source.config, "publisher"),
      host,
      areaId: ctx.source.area_id,
      now: ctx.now,
      timeZone: sourceTimeZone(ctx.source, ctx.areas),
      authorFilter,
    });
    return {
      items,
      notes: [
        `${parsed.length} item${parsed.length === 1 ? "" : "s"}${
          authorFilter ? `, ${items.length} by "${authorFilter}"` : ""
        }`,
      ],
      state: { status: res.status, etag: res.etag, lastModified: res.lastModified },
    };
  },
};

export default source;
