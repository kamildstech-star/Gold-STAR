import { describe, expect, it } from "vitest";

import { extractByRules } from "./extract";
import { fakeDb } from "./fake-supabase.testkit";
import {
  fixtureText,
  migrationSources,
  PRODUCTION_AREAS,
  recordedFetch,
} from "./government-sources.testkit";
import { parseHtmlTables, parsePageTime, publicPageConfigSchema, townOnly } from "./public-page";
import { parseFeed } from "./rss-parse";
import { fireSourceFor } from "./registry";
import { runFireFeed, type RunSummary } from "./run.server";
import type { FetchContext, SourceRow } from "./types";

/*
 * The four free government sources of migration 20261012090000, read with
 * the exact rows that migration inserts (parsed out of the SQL), against the
 * responses the research pass recorded on 11 Oct 2026:
 *   rockland-firewatch-status.json   http://firewatch.44-control.net/status.json
 *   notify-nyc-cap-rss.xml           Notify NYC CAP RSS (Everbridge)
 *   lafd-alerts-rss.xml              https://lafd.org/alerts-rss.xml
 *   houston-hfd-active-incidents.html  HFD active incidents, #GridView2
 */

const NOW = new Date("2026-10-11T22:35:00.000Z");
const SOURCES = migrationSources();
const byUrl = (fragment: string) => SOURCES.find((s) => s.url!.includes(fragment))!;
const ROCKLAND = byUrl("firewatch.44-control.net");
const NYC = byUrl("everbridge");
const LAFD = byUrl("lafd.org");
const HOUSTON = byUrl("houstontx.gov");

function ctx(source: SourceRow, fetchImpl: typeof fetch = recordedFetch): FetchContext {
  const cursors = new Map<string, string>();
  return {
    source,
    areas: PRODUCTION_AREAS,
    now: NOW,
    fetch: fetchImpl,
    cursors: { get: (k) => cursors.get(k) ?? null, set: (k, v) => void cursors.set(k, v) },
  };
}

const read = (s: SourceRow, f?: typeof fetch) => fireSourceFor(s.kind)!.fetch(ctx(s, f));

/** A whole run over one source, offline: town-centre geocoder, in-memory insert. */
async function offlineRun(
  source: SourceRow,
  fetchImpl: typeof fetch = recordedFetch,
): Promise<{
  s: RunSummary;
  payloads: { payload: Record<string, unknown>; extras: Record<string, unknown> }[];
}> {
  const db = fakeDb({
    app_settings: [{ key: "fire_feed", value: { enabled: true } }],
    fire_feed_areas: PRODUCTION_AREAS.map((a) => ({ ...a })),
    fire_feed_sources: [{ ...source, enabled: true }],
    fire_feed_runs: [],
    fire_feed_items: [],
    fire_feed_cursors: [],
    incidents: [],
  });
  const payloads: { payload: Record<string, unknown>; extras: Record<string, unknown> }[] = [];
  const s = await runFireFeed(
    {
      db: db.client,
      fetch: fetchImpl,
      now: () => NOW,
      geocode: async (q) => {
        const area = PRODUCTION_AREAS.find((a) =>
          q.toLowerCase().includes(a.locality!.toLowerCase()),
        );
        return area
          ? { lat: area.center_lat! + 0.01, lon: area.center_lon! + 0.01, formatted: null }
          : null;
      },
      extract: async (items, areas) => ({
        extractions: items.map((i) => extractByRules(i, areas)),
        aiCalls: 0,
        aiItems: 0,
        aiError: null,
      }),
      sourceFor: fireSourceFor,
      ingest: async (payload, extras) => {
        payloads.push({ payload: payload as never, extras: extras as never });
        return { ok: true, incident: { id: `inc-${payloads.length}`, status: "new" } };
      },
    },
    { trigger: "manual" },
  );
  return { s, payloads };
}

describe("the migration's rows", () => {
  it("are the four sources plus the Lakewood Scoop, each pinned to its area", () => {
    expect(SOURCES.map((s) => [s.kind, s.poll_minutes, s.area_id])).toEqual([
      ["public_page", 2, "hav"],
      ["rss", 5, "brk"],
      ["rss", 10, "la"],
      ["public_page", 5, "hou"],
      ["rss", 10, "lkw"],
    ]);
  });

  it("the public pages' settings pass the source's own schema", () => {
    for (const s of [ROCKLAND, HOUSTON]) {
      expect(publicPageConfigSchema.safeParse(s.config).success, s.label).toBe(true);
    }
  });
});

describe("Rockland 44-Control Firewatch (JSON, http, Eastern time without a zone)", () => {
  it("reads every call, keeps the fire-related ones, completed calls included", async () => {
    const out = await read(ROCKLAND);
    expect(out.state.error ?? null).toBeNull();
    expect(out.notes).toEqual(["46 rows, 34 fire-related"]);
    const first = out.items[0]!;
    expect(first).toMatchObject({
      key: "pp:firewatch.44-control.net:id:26-213046",
      title: "Automatic Alarm at 8 LOIS LN, WESLEY HILLS",
      // "18:28:00 10/11/2026", Eastern daylight time.
      publishedAt: "2026-10-11T22:28:00.000Z",
      point: { lat: 41.150781, lon: -74.068833 },
      areaPinned: true,
    });
    expect(first.structured).toMatchObject({
      address: "8 LOIS LN",
      locality: "WESLEY HILLS",
      units: 2,
      status: "Unknown",
    });
  });

  it("an intersection call is placed as one, without repeating its nearest intersection", async () => {
    const smoke = (await read(ROCKLAND)).items.find((i) => i.title.startsWith("Smoke/Odor Out"))!;
    expect(smoke.title).toBe("Smoke/Odor Out at ROOSEVELT AV & OSTEREH BLVD, NEW SQUARE");
    expect(smoke.structured).toMatchObject({
      address: null,
      crossStreet: "ROOSEVELT AV & OSTEREH BLVD",
    });
  });

  it("can drop closed calls when an admin asks — 'Completed' leaves only the open one", async () => {
    const out = await read({
      ...ROCKLAND,
      config: { ...ROCKLAND.config, exclude_statuses: ["Completed"] },
    });
    expect(out.items.map((i) => i.structured?.status)).toEqual(["Unknown"]);
  });

  it("dry run: 31 new calls, no structure fire in the recorded hour, each skipped with its reason", async () => {
    const { s, payloads } = await offlineRun(ROCKLAND);
    expect(s.newItems).toBe(31);
    expect(s.leads).toBe(0);
    expect(s.skipped).toEqual({ not_a_fire: 25, other_fire: 3, vehicle_fire: 3 });
    expect(payloads).toEqual([]);
  });

  it("the same feed with a structure fire in it lands that fire, at the CAD's own point (synthetic row)", async () => {
    // One recorded row with its type changed — what a real structure fire
    // on 44-Control would look like to the feed.
    const doc = JSON.parse(fixtureText("rockland-firewatch-status.json")) as {
      Fire: Record<string, unknown>[];
    };
    const row = doc.Fire.find((f) => f.Address === "7 COOLIDGE CT")!;
    row["Incident Type"] = "Structure Fire";
    const fetchWithFire = (async (input: RequestInfo | URL) =>
      String(input).endsWith("/robots.txt")
        ? new Response("", { status: 404 })
        : new Response(JSON.stringify(doc), {
            headers: { "content-type": "application/json" },
          })) as typeof fetch;
    const { s, payloads } = await offlineRun(ROCKLAND, fetchWithFire);
    expect(s.leads).toBe(1);
    expect(payloads[0]!.payload).toMatchObject({
      source: "public_page",
      address: "7 Coolidge Ct",
      locality: "Haverstraw",
      region: "NY",
      lat: row.Latitude,
      lon: row.Longitude,
    });
    expect(payloads[0]!.extras).toMatchObject({ needs_review: false });
  });
});

describe("Notify NYC (RSS, twelve languages)", () => {
  it("reads the English copy of each alert only", async () => {
    const all = parseFeed(fixtureText("notify-nyc-cap-rss.xml"));
    expect(all).toHaveLength(23);
    expect(all.filter((f) => f.author === "NYCEM [English]")).toHaveLength(2);
    const out = await read(NYC);
    expect(out.notes).toEqual(['23 items, 2 by "NYCEM [English]"']);
    expect(out.items.map((i) => i.title)).toEqual([
      "Notify NYC - Flood Advisory - 10/11 (NYC)",
      "Notify NYC - Coastal Flood Statement - 10/12 (BK/QN)",
    ]);
    expect(out.items.every((i) => i.publisher === "Notify NYC")).toBe(true);
  });

  it("dry run: the recorded alerts are floods, not fires", async () => {
    const { s } = await offlineRun(NYC);
    expect(s.newItems).toBe(2);
    expect(s.leads).toBe(0);
    expect(s.skipped).toEqual({ not_a_fire: 2 });
  });
});

describe("LAFD Alerts (RSS with HTML in titles and Pacific dates)", () => {
  it("strips the markup, resolves the anchor links, and reads the dates in Pacific time", async () => {
    const out = await read(LAFD);
    expect(out.items).toHaveLength(10);
    expect(new Set(out.items.map((i) => i.key)).size).toBe(10);
    expect(out.items.every((i) => !/[<>]/.test(i.title))).toBe(true);
    const knock = out.items.find((i) => i.title.startsWith("KNOCKDOWN Structure Fire 10/11/2026"))!;
    expect(knock).toMatchObject({
      url: "https://lafd.org/alert/knockdown-structure-fire-10112026-inc0433",
      key: "https://lafd.org/alert/knockdown-structure-fire-10112026-inc0433",
      publisher: "LAFD",
      // "Sunday, October 11, 2026 - 07:40", Pacific daylight time.
      publishedAt: "2026-10-11T14:40:00.000Z",
      areaPinned: true,
    });
    expect(knock.text).not.toMatch(/<a\b/);
  });

  it("dry run: one structure fire lead, its knockdown merged onto it, older alerts too old", async () => {
    const { s, payloads } = await offlineRun(LAFD);
    expect(s.newItems).toBe(10);
    expect(s.leads).toBe(1);
    expect(s.merged).toBe(1);
    expect(s.skipped).toEqual({ too_old: 6, not_a_fire: 2 });
    expect(payloads[0]!.payload).toMatchObject({
      source: "rss",
      address: "7032 N Baird Av",
      locality: "Los Angeles",
      region: "CA",
      building_type: "Single-family home",
      reported_at: "2026-10-11T14:28:00.000Z",
    });
  });
});

describe("Houston HFD active incidents (#GridView2 inside a layout table, Central time)", () => {
  it("finds the call list by its id, whatever table it is nested in", () => {
    const tables = parseHtmlTables(fixtureText("houston-hfd-active-incidents.html"));
    const grid = tables.find((t) => t.id === "GridView2")!;
    expect(grid.headers).toEqual([
      "Address",
      "Cross Street",
      "Key Map",
      "Call Time(Opened)",
      "Incident Type",
      "Alarm Level",
      "Units",
    ]);
    expect(grid.rows).toHaveLength(58);
    // The outer layout table no longer swallows the call rows.
    expect(tables.filter((t) => t.id !== "GridView2").every((t) => t.rows.length < 20)).toBe(true);
  });

  it("keeps the one fire call of 58, placed by street and cross street", async () => {
    const out = await read(HOUSTON);
    expect(out.notes).toEqual(["58 rows, 1 fire-related"]);
    expect(out.items[0]).toMatchObject({
      title: "APARTMENT FIRE at GRAY RIDGE DR & DAHLIA FIELD WAY",
      publishedAt: "2026-10-11T21:48:00.000Z",
      areaPinned: true,
    });
    expect(out.items[0]!.structured).toMatchObject({
      address: null,
      crossStreet: "GRAY RIDGE DR & DAHLIA FIELD WAY",
      units: 5,
    });
  });

  it("dry run: one apartment-fire lead, marked to check before driving", async () => {
    const { s, payloads } = await offlineRun(HOUSTON);
    expect(s.leads).toBe(1);
    expect(payloads[0]!.payload).toMatchObject({
      source: "public_page",
      address: "Gray Ridge Dr & Dahlia Field Way",
      locality: "Houston",
      region: "TX",
      building_type: "Multi-family (apartment)",
      units_dispatched: 5,
      reported_at: "2026-10-11T21:48:00.000Z",
    });
    expect(payloads[0]!.extras).toMatchObject({
      needs_review: true,
      review_reason:
        "Cross streets only (Gray Ridge Dr & Dahlia Field Way) — the exact house is not known",
    });
  });
});

describe("the pieces those feeds needed", () => {
  it.each([
    ["18:28:00 10/11/2026", "America/New_York", "2026-10-11T22:28:00.000Z"],
    ["Sunday, October 11, 2026 - 07:40", "America/Los_Angeles", "2026-10-11T14:40:00.000Z"],
    ["Oct 11, 2026 4:48 PM", "America/Chicago", "2026-10-11T21:48:00.000Z"],
    ["10/11/2026 16:48", "America/Chicago", "2026-10-11T21:48:00.000Z"],
    ["October 11 2026", "America/New_York", null],
  ])("parsePageTime(%s, %s)", (raw, tz, iso) => {
    expect(parsePageTime(raw, NOW, tz)).toBe(iso);
  });

  it("a zone-less string Date.parse would read in the server's zone is refused, not guessed", () => {
    expect(parsePageTime("2026/10/11 16:48", NOW, "America/Chicago")).toBeNull();
  });

  it.each([
    ["WESLEY HILLS, NY 10952", "WESLEY HILLS"],
    ["HAVERSTRAW, NY", "HAVERSTRAW"],
    ["Lakewood", "Lakewood"],
  ])("townOnly(%s)", (raw, town) => {
    expect(townOnly(raw)).toBe(town);
  });
});
