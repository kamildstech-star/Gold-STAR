/**
 * Public incident pages as a fire-feed source (kind `public_page`).
 *
 * See ../public-page.ts for the presets and ../polite-fetch.ts for the rules
 * every fetch obeys (robots.txt, two minutes per URL, conditional GET, no
 * logins or CAPTCHAs). Rows become feed items with the 911 center's own
 * columns in `structured`; the fire feed then reads, places, dedupes and
 * inserts them exactly as it does a news story, with incidents.source =
 * 'public_page'.
 *
 * The RSS preset reads the feed exactly as the RSS source does
 * (feed-items.ts): author filter, zone-less dates in the source's zone.
 */
import { politeFetch } from "../polite-fetch";
import {
  isFireRow,
  isGovernmentHost,
  itemFromRow,
  parseHtmlTables,
  hasExcludedStatus,
  publicPageConfigSchema,
  sourceTimeZone,
  rowsFromJson,
  rowsFromTable,
  type PageRow,
} from "../public-page";
import { feedItemsToRaw } from "../feed-items";
import { parseFeed } from "../rss-parse";
import type { FetchContext, FetchResult, FireSource, RawItem } from "../types";

const ACCEPT: Record<string, string> = {
  html_table: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
  json: "application/json,application/geo+json;q=0.9,*/*;q=0.5",
  rss: "application/rss+xml,application/atom+xml,application/xml;q=0.9,text/xml;q=0.9,*/*;q=0.5",
};

export async function readPublicPage(
  ctx: FetchContext,
  opts: { respectInterval?: boolean } = {},
): Promise<
  FetchResult & {
    rows: PageRow[];
    tables?: { id: string | null; headers: string[]; rows: number }[];
  }
> {
  const src = ctx.source;
  const fail = (error: string, status: number | null = null) => ({
    items: [],
    rows: [],
    state: { status, error },
  });
  if (!src.url) return fail("No page URL");
  const parsed = publicPageConfigSchema.safeParse(src.config ?? {});
  if (!parsed.success)
    return fail(
      "The page's reading settings are incomplete — open it on the Public incident pages panel.",
    );
  const cfg = parsed.data;
  let host: string;
  try {
    host = new URL(src.url).hostname.toLowerCase();
  } catch {
    return fail("Not a web address");
  }
  if (!isGovernmentHost(host) && cfg.government_ack !== true) {
    return fail(
      "Only public government pages: confirm this one on the Public incident pages panel before the feed reads it.",
    );
  }

  const got = await politeFetch(ctx, src.url, {
    accept: ACCEPT[cfg.preset]!,
    validators: { etag: src.etag, lastModified: src.last_modified },
    respectInterval: opts.respectInterval,
  });
  if (got.kind === "error") return fail(got.reason, got.status);
  if (got.kind === "skipped") return { items: [], rows: [], notes: [got.reason], state: {} };
  if (got.kind === "not_modified") {
    return {
      items: [],
      rows: [],
      notes: ["unchanged"],
      state: { status: 304, notModified: true, etag: got.etag, lastModified: got.lastModified },
    };
  }

  // Bare times on the page are in the source's zone: its own setting, else
  // the pinned watch area's state (Houston prints Central, Rockland Eastern).
  const timeZone = sourceTimeZone(src, ctx.areas);
  const base = {
    sourceId: src.id,
    areaId: src.area_id,
    host,
    pageUrl: src.url,
    label: src.label,
    now: ctx.now,
    timeZone,
  };
  let rows: PageRow[] = [];
  let tables: { id: string | null; headers: string[]; rows: number }[] | undefined;
  let items: RawItem[] = [];

  if (cfg.preset === "html_table") {
    const all = parseHtmlTables(got.body);
    tables = all.map((t) => ({ id: t.id, headers: t.headers, rows: t.rows.length }));
    if (all.length === 0) return { ...fail("No table found on the page", got.status), tables };
    const wantedId = cfg.table?.id;
    const t = wantedId ? all.find((x) => x.id === wantedId) : all[(cfg.table?.index ?? 1) - 1];
    if (!t)
      return {
        ...fail(
          wantedId
            ? `No table with id "${wantedId}" on the page.`
            : `The page has ${all.length} table${all.length === 1 ? "" : "s"}; table ${cfg.table?.index} is not there.`,
          got.status,
        ),
        tables,
      };
    rows = rowsFromTable(t, cfg.table?.columns);
  } else if (cfg.preset === "json") {
    let doc: unknown;
    try {
      doc = JSON.parse(got.body);
    } catch {
      return fail("The page did not return JSON", got.status);
    }
    rows = rowsFromJson(doc, cfg.json);
  } else {
    items = feedItemsToRaw(parseFeed(got.body, src.url), {
      kind: "public_page",
      sourceId: src.id,
      label: src.label,
      publisher: src.label,
      host,
      areaId: src.area_id,
      now: ctx.now,
      timeZone,
      authorFilter: typeof src.config?.author_filter === "string" ? src.config.author_filter : null,
      keyPrefix: "pp:",
    });
  }

  const fireOnly = cfg.fire_rows_only !== false;
  if (cfg.preset !== "rss") {
    const open = rows.filter((r) => !hasExcludedStatus(r, cfg.exclude_statuses));
    const kept = fireOnly ? open.filter(isFireRow) : open;
    items = kept.map((r) => itemFromRow(r, base)).filter((i): i is RawItem => i != null);
  } else if (fireOnly) {
    items = items.filter((i) =>
      /\b(fire|smoke|burn\w*|flames?|explosion|alarm)\b/i.test(`${i.title} ${i.text}`),
    );
  }
  const total = cfg.preset === "rss" ? items.length : rows.length;
  return {
    items,
    rows,
    tables,
    notes: [
      `${total} row${total === 1 ? "" : "s"}${fireOnly ? `, ${items.length} fire-related` : ""}`,
    ],
    state: { status: got.status, etag: got.etag, lastModified: got.lastModified },
  };
}

const source: FireSource = {
  kind: "public_page",
  label: "Public incident page",
  async fetch(ctx) {
    const { items, notes, state } = await readPublicPage(ctx);
    return { items, notes, state };
  },
};

export default source;
