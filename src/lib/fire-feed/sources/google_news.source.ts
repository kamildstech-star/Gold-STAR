/**
 * Google News RSS, one query per active watch area. See ../google-news.ts
 * for the query and for the feed's own terms of use, which Mark needs to
 * see before the feed is switched on.
 */
import { canonicalUrl } from "../dedupe";
import { fetchFeed } from "../feed-fetch";
import { googleNewsUrl, splitPublisher } from "../google-news";
import { parseFeed } from "../rss-parse";
import type { FetchContext, FetchResult, FireSource, RawItem } from "../types";
import { areaPlaceName } from "../areas";

/** Areas asked about per run. Twelve offices is twelve requests; this is the ceiling. */
export const GOOGLE_NEWS_MAX_AREAS = 40;

const source: FireSource = {
  kind: "google_news",
  label: "Google News",
  async fetch(ctx: FetchContext): Promise<FetchResult> {
    const areas = ctx.areas
      .filter((a) => a.active && (a.locality || a.county))
      .filter((a) => !ctx.source.area_id || a.id === ctx.source.area_id)
      .slice(0, GOOGLE_NEWS_MAX_AREAS);
    const items: RawItem[] = [];
    const notes: string[] = [];
    let failures = 0;
    let lastStatus: number | null = null;
    let lastError: string | null = null;

    for (const area of areas) {
      const cursorKey = `area:${area.id}`;
      const saved = (() => {
        try {
          return JSON.parse(ctx.cursors.get(cursorKey) ?? "{}") as {
            etag?: string;
            lastModified?: string;
          };
        } catch {
          return {};
        }
      })();
      const res = await fetchFeed(ctx.fetch, googleNewsUrl(area), saved);
      const name = areaPlaceName(area);
      if (!res.ok) {
        failures += 1;
        lastStatus = res.status;
        lastError = `${name}: ${res.error}`;
        notes.push(`${name}: ${res.error}`);
        continue;
      }
      lastStatus = res.status;
      if (res.etag || res.lastModified) {
        ctx.cursors.set(
          cursorKey,
          JSON.stringify({
            etag: res.etag ?? undefined,
            lastModified: res.lastModified ?? undefined,
          }),
        );
      }
      if ("notModified" in res) {
        notes.push(`${name}: unchanged`);
        continue;
      }
      const parsed = parseFeed(res.body);
      notes.push(`${name}: ${parsed.length} item${parsed.length === 1 ? "" : "s"}`);
      for (const f of parsed) {
        const { headline, publisher } = splitPublisher(f.title, f.source);
        // Google's guid is stable per story; the link is a Google redirect,
        // not the paper's URL, so it is not a cross-source key.
        const key = f.guid ? `gnews:${f.guid}` : (canonicalUrl(f.link) ?? `gnews:${headline}`);
        items.push({
          key,
          sourceKind: "google_news",
          sourceId: ctx.source.id,
          title: headline,
          url: f.link,
          publisher,
          publishedAt: f.published,
          // The description is the headline again, linked, plus the publisher.
          text:
            f.description === f.title || f.description.startsWith(headline) ? "" : f.description,
          areaId: area.id,
          point: null,
        });
      }
    }

    // The same story found by two areas' queries is one item.
    const unique = [...new Map(items.map((i) => [i.key, i])).values()];
    return {
      items: unique,
      notes,
      state: {
        status: lastStatus,
        error:
          failures > 0
            ? failures === areas.length
              ? lastError
              : `${failures} of ${areas.length} area queries failed — ${lastError}`
            : null,
      },
    };
  },
};

export default source;
