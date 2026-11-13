import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import source, { readPublicPage } from "./sources/public_page.source";
import type { FetchContext, SourceRow } from "./types";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const NOW = new Date("2026-10-11T21:00:00.000Z");

const row = (over: Partial<SourceRow>): SourceRow => ({
  id: "pp1",
  kind: "public_page",
  label: "Example County 911",
  url: "https://911.example.gov/active",
  config: { preset: "html_table", table: { index: 2 } },
  area_id: null,
  poll_minutes: 3,
  enabled: true,
  last_fetched_at: null,
  etag: null,
  last_modified: null,
  ...over,
});

function ctx(src: SourceRow, page: () => Response) {
  const requests: string[] = [];
  const cursors = new Map<string, string>();
  const c: FetchContext = {
    source: src,
    areas: [],
    now: NOW,
    fetch: (async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      return url.endsWith("/robots.txt") ? new Response("User-agent: *\nAllow: /\n") : page();
    }) as typeof fetch,
    cursors: { get: (k) => cursors.get(k) ?? null, set: (k, v) => void cursors.set(k, v) },
  };
  return { c, requests, cursors };
}

describe("public_page source", () => {
  it("is a FireSource of kind public_page (found by the fire feed's registry by file name)", () => {
    expect(source.kind).toBe("public_page");
    expect(typeof source.fetch).toBe("function");
  });

  it("reads the county table's fire calls into feed items with the page's ETag", async () => {
    const { c } = ctx(
      row({}),
      () =>
        new Response(fixture("public-page-active-incidents.html"), {
          headers: { "content-type": "text/html", etag: 'W/"abc"' },
        }),
    );
    const out = await source.fetch(c);
    expect(out.state.error ?? null).toBeNull();
    expect(out.items.map((i) => i.title)).toEqual([
      "STRUCTURE FIRE - RESIDENTIAL at 412 PINE ST, Lakewood",
      "VEHICLE FIRE at RT 9 & COUNTY LINE RD, Lakewood",
      "FIRE ALARM - COMMERCIAL at 1500 RT 9, Toms River",
      "WORKING FIRE - 2ND ALARM at 27 5TH ST, Lakewood",
    ]);
    expect(out.notes).toEqual(["6 rows, 4 fire-related"]);
    expect(out.state.etag).toBe('W/"abc"');
    expect(out.items[3]!.structured?.units).toBe(6);
  });

  it("all rows when 'fire calls only' is off", async () => {
    const { c } = ctx(
      row({ config: { preset: "html_table", table: { index: 2 }, fire_rows_only: false } }),
      () => new Response(fixture("public-page-active-incidents.html")),
    );
    expect((await source.fetch(c)).items).toHaveLength(6);
  });

  it("says which tables exist when the chosen one is not there", async () => {
    const { c } = ctx(
      row({ config: { preset: "html_table", table: { index: 5 } } }),
      () => new Response(fixture("public-page-active-incidents.html")),
    );
    const out = await readPublicPage(c);
    expect(out.state.error).toBe("The page has 2 tables; table 5 is not there.");
    expect(out.tables?.[1]?.headers[2]).toBe("Call Type");
  });

  it("reads a JSON endpoint with coordinates", async () => {
    const { c } = ctx(
      row({
        url: "https://911.example.gov/api/calls",
        config: { preset: "json", json: { items_path: "data.calls" } },
      }),
      () => new Response(fixture("public-page-incidents.json")),
    );
    const out = await source.fetch(c);
    expect(out.items.map((i) => i.structured?.incidentType)).toEqual([
      "STRUCTURE FIRE",
      "BRUSH FIRE",
    ]);
    expect(out.items[0]!.point).toEqual({ lat: 40.081, lon: -74.212 });
    expect(out.items[0]!.key).toBe("pp:911.example.gov:id:88120");
  });

  it("will not read a non-government site until an admin confirms it, and then does", async () => {
    const page = () => new Response(fixture("public-page-active-incidents.html"));
    const unconfirmed = ctx(row({ url: "https://lakewoodfd.example.org/calls" }), page);
    const out = await source.fetch(unconfirmed.c);
    expect(out.state.error).toMatch(/^Only public government pages/);
    expect(unconfirmed.requests).toHaveLength(0);
    const confirmed = ctx(
      row({
        url: "https://lakewoodfd.example.org/calls",
        config: { preset: "html_table", table: { index: 2 }, government_ack: true },
      }),
      page,
    );
    expect((await source.fetch(confirmed.c)).items.length).toBe(4);
  });

  it("refuses settings it cannot read", async () => {
    const { c, requests } = ctx(
      row({ config: { preset: "scrape_everything" } }),
      () => new Response(""),
    );
    expect((await source.fetch(c)).state.error).toMatch(/reading settings are incomplete/);
    expect(requests).toHaveLength(0);
  });

  it("reads a county 911 RSS feed through the fire feed's RSS reader", async () => {
    const { c } = ctx(
      row({ url: "https://www.monroecounty.gov/incidents911.rss", config: { preset: "rss" } }),
      () => new Response(fixture("public-page-monroe-911.xml")),
    );
    const out = await source.fetch(c);
    // Monroe's sample has no fire calls; with the filter off all six arrive.
    expect(out.items).toHaveLength(0);
    const all = ctx(
      row({
        url: "https://www.monroecounty.gov/incidents911.rss",
        config: { preset: "rss", fire_rows_only: false },
      }),
      () => new Response(fixture("public-page-monroe-911.xml")),
    );
    const items = (await source.fetch(all.c)).items;
    expect(items).toHaveLength(6);
    expect(items[0]!.point).toEqual({ lat: 43.2381, lon: -77.6474 });
  });
});
