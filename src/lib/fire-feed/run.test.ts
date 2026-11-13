import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  incidentRow,
  type IncidentPayload,
  type TrustedIncidentExtras,
} from "@/lib/incident-payload";

import { extractByRules } from "./extract";
import { fakeDb, type FakeDb } from "./fake-supabase.testkit";
import { fireSourceFor } from "./registry";
import { runFireFeed, skippedLine, type RunDeps } from "./run.server";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const NOW = new Date("2026-10-11T21:00:00.000Z");

/** Where the fake geocoder puts things: real towns, invented streets. */
const PLACES: Record<string, { lat: number; lon: number; formatted: string }> = {
  "412 pine street, lakewood, nj": {
    lat: 40.081,
    lon: -74.212,
    formatted: "412 Pine St, Lakewood, NJ 08701, USA",
  },
  "412 pine st, lakewood, nj": {
    lat: 40.081,
    lon: -74.212,
    formatted: "412 Pine St, Lakewood, NJ 08701, USA",
  },
  "88 main st, toms river": {
    lat: 39.953,
    lon: -74.198,
    formatted: "88 Main St, Toms River, NJ 08753, USA",
  },
  "cedar avenue & oak avenue, haverstraw": {
    lat: 41.197,
    lon: -73.965,
    formatted: "Cedar Ave & Oak Ave, Haverstraw, NY 10927, USA",
  },
};

function world(opts: {
  enabled: boolean;
  geocodeFails?: boolean;
  incidents?: Record<string, unknown>[];
}) {
  const db: FakeDb = fakeDb({
    app_settings: [{ key: "fire_feed", value: { enabled: opts.enabled } }],
    fire_feed_areas: [
      {
        id: "lkw",
        label: "Lakewood, NJ",
        locality: "Lakewood",
        county: "Ocean",
        state: "NJ",
        postal_codes: [],
        center_lat: 40.0821,
        center_lon: -74.2097,
        radius_miles: 15,
        active: true,
      },
    ],
    fire_feed_sources: [
      {
        id: "gn",
        kind: "google_news",
        label: "Google News",
        url: null,
        config: {},
        area_id: null,
        poll_minutes: 15,
        enabled: true,
        last_fetched_at: null,
        etag: null,
        last_modified: null,
      },
      {
        id: "fd",
        kind: "rss",
        label: "Example Township FD",
        url: "https://fire.example.gov/rss",
        config: {},
        area_id: null,
        poll_minutes: 5,
        enabled: true,
        last_fetched_at: null,
        etag: null,
        last_modified: null,
      },
    ],
    fire_feed_runs: [],
    fire_feed_items: [],
    fire_feed_cursors: [],
    incidents: opts.incidents ?? [],
  });
  const geocodeCalls: string[] = [];
  const inserted: { payload: IncidentPayload; extras: TrustedIncidentExtras }[] = [];
  const deps: RunDeps = {
    db: db.client,
    fetch: (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("https://news.google.com/")) {
        return new Response(fixture("google-news-lakewood-nj.xml"), {
          headers: { etag: 'W/"gn1"' },
        });
      }
      return new Response(fixture("fire-department-sample.xml"), { headers: { etag: 'W/"fd1"' } });
    }) as typeof fetch,
    now: () => NOW,
    geocode: async (q) => {
      geocodeCalls.push(q);
      if (opts.geocodeFails) throw new Error("Photon failed (503)");
      return PLACES[q.toLowerCase()] ?? null;
    },
    extract: async (items, areas) => ({
      extractions: items.map((i) => extractByRules(i, areas)),
      aiCalls: 0,
      aiItems: 0,
      aiError: null,
    }),
    sourceFor: fireSourceFor,
    // What ingestIncident does, minus the database triggers.
    ingest: async (payload, extras) => {
      inserted.push({ payload, extras });
      const row = {
        id: `inc-${inserted.length}`,
        status: "new",
        duplicate_of: null,
        needs_review: false,
        review_reason: null,
        ...incidentRow(payload, extras, NOW),
      };
      db.tables.incidents!.push(row);
      return { ok: true, incident: { id: row.id, status: "new" } };
    },
  };
  return { db, deps, geocodeCalls, inserted };
}

describe("a switched-off feed", () => {
  it("does nothing on the schedule", async () => {
    const w = world({ enabled: false });
    const s = await runFireFeed(w.deps, { trigger: "cron" });
    expect(s.status).toBe("idle");
    expect(s.idleReason).toBe("The fire feed is switched off.");
    expect(w.db.tables.fire_feed_runs).toHaveLength(0);
  });

  it("Run now is a dry run: it decides, writes no incident, no ledger, no validators", async () => {
    const w = world({ enabled: false });
    const s = await runFireFeed(w.deps, { trigger: "manual", triggeredBy: "admin-1" });
    expect(s.dryRun).toBe(true);
    expect(s.leads).toBe(2);
    expect(w.inserted).toHaveLength(0);
    expect(w.db.tables.incidents).toHaveLength(0);
    expect(w.db.tables.fire_feed_items).toHaveLength(0);
    expect(w.db.tables.fire_feed_cursors).toHaveLength(0);
    const run = w.db.tables.fire_feed_runs![0]!;
    expect(run).toMatchObject({
      dry_run: true,
      trigger: "manual",
      triggered_by: "admin-1",
      leads_created: 2,
    });
    expect((run.decisions as unknown[]).length).toBe(s.decisions.length);
    expect(w.db.tables.fire_feed_sources!.every((r) => r.etag === null)).toBe(true);
  });
});

describe("a live run", () => {
  it("lands the structure fires in the incident path and says why it skipped the rest", async () => {
    const w = world({ enabled: true });
    const s = await runFireFeed(w.deps, { trigger: "cron" });

    expect(s.status).toBe("ok");
    expect(s.leads).toBe(2);
    expect(w.inserted.map((x) => x.payload.address)).toEqual(["88 Main St", "412 Pine Street"]);

    const pine = w.inserted.find((x) => x.payload.address === "412 Pine Street")!;
    expect(pine.payload).toMatchObject({
      source: "rss",
      external_ref: "https://fire.example.gov/incidents/2026-1011-01",
      incident_type: "fire",
      alarm_level: "2nd alarm",
      building_type: "Single-family home",
      locality: "Lakewood",
      region: "NJ",
      postal_code: "08701",
    });
    expect(pine.extras.source_links?.[0]?.url).toBe(
      "https://fire.example.gov/incidents/2026-1011-01?utm_source=rss&utm_medium=feed",
    );

    // Brush, car, open house, out-of-area apartment, and the Google News noise.
    expect(s.skipped).toMatchObject({ brush_fire: 1, vehicle_fire: 1, outside_areas: 1 });
    expect(s.skipped.not_a_fire).toBeGreaterThanOrEqual(2);
    expect(s.skipped.follow_up).toBeGreaterThanOrEqual(2);
    expect(skippedLine(s.skipped)).toMatch(/not a fire/);

    // Every decision is in the ledger, so none is made twice.
    expect(w.db.tables.fire_feed_items).toHaveLength(s.newItems);
    expect(new Set(w.db.tables.fire_feed_items!.map((r) => r.decision))).toEqual(
      new Set(["lead", "skipped"]),
    );
    const run = w.db.tables.fire_feed_runs![0]!;
    expect(run).toMatchObject({ status: "ok", leads_created: 2, dry_run: false });
    expect(run.decisions).toBeNull();

    // Validators kept: every new item was decided.
    expect(w.db.tables.fire_feed_sources!.find((r) => r.id === "fd")!.etag).toBe('W/"fd1"');
    expect(w.db.tables.fire_feed_sources!.find((r) => r.id === "fd")!.last_fetched_at).toBe(
      NOW.toISOString(),
    );
  });

  it("the next run skips what it has seen, before reading or geocoding anything", async () => {
    const w = world({ enabled: true });
    const first = await runFireFeed(w.deps, { trigger: "manual" });
    const geocodesAfterFirst = w.geocodeCalls.length;
    const second = await runFireFeed(w.deps, { trigger: "manual" });
    expect(second.newItems).toBe(0);
    expect(second.skipped.already_seen).toBe(first.newItems);
    expect(w.geocodeCalls.length).toBe(geocodesAfterFirst);
    expect(w.inserted).toHaveLength(2);
  });

  it("a source that is not due is not fetched on the schedule", async () => {
    const w = world({ enabled: true });
    for (const s of w.db.tables.fire_feed_sources!)
      s.last_fetched_at = new Date(NOW.getTime() - 60_000).toISOString();
    const s = await runFireFeed(w.deps, { trigger: "cron" });
    expect(s.status).toBe("idle");
    expect(s.idleReason).toBe("No source is due yet.");
  });

  it("merges onto a fire already on file from BNN instead of adding a second lead", async () => {
    const bnn = {
      id: "bnn-1",
      source: "bnn",
      address: "412 Pine St",
      locality: "Lakewood",
      postal_code: "08701",
      lat: 40.081,
      lon: -74.212,
      reported_at: "2026-10-11T19:20:00.000Z",
      needs_review: false,
      review_reason: null,
      duplicate_of: null,
      source_links: [],
    };
    const w = world({ enabled: true, incidents: [bnn] });
    const s = await runFireFeed(w.deps, { trigger: "cron" });
    expect(s.merged).toBe(1);
    expect(w.inserted.map((x) => x.payload.address)).toEqual(["88 Main St"]);
    const merged = w.db.tables.incidents!.find((r) => r.id === "bnn-1")!;
    expect((merged.source_links as { url: string }[])[0]!.url).toContain(
      "fire.example.gov/incidents/2026-1011-01",
    );
    const ledger = w.db.tables.fire_feed_items!.find((r) => r.decision === "merged")!;
    expect(ledger).toMatchObject({ incident_id: "bnn-1", reason: "same_address" });
  });

  it("a geocoder outage leaves the items for the next run and keeps no validators", async () => {
    const w = world({ enabled: true, geocodeFails: true });
    const s = await runFireFeed(w.deps, { trigger: "cron" });
    expect(s.status).toBe("partial");
    expect(s.leads).toBe(0);
    expect(s.errors.some((e) => e.includes("Photon failed (503)"))).toBe(true);
    const keys = new Set(w.db.tables.fire_feed_items!.map((r) => r.item_key));
    expect(keys.has("https://fire.example.gov/incidents/2026-1011-01")).toBe(false);
    expect(w.db.tables.fire_feed_sources!.find((r) => r.id === "fd")!.etag).toBeNull();
  });

  it("before the migration, it says so and does nothing", async () => {
    const w = world({ enabled: true });
    w.db.missing.add("fire_feed_areas");
    const s = await runFireFeed(w.deps, { trigger: "cron" });
    expect(s.status).toBe("idle");
    expect(s.idleReason).toMatch(/20261011140000/);
  });

  it("a kind with no adapter in this build is logged against its row, and the rest run", async () => {
    const w = world({ enabled: true });
    w.db.tables.fire_feed_sources!.push({
      id: "pp",
      kind: "public_page",
      label: "County 911",
      url: "https://911.example.gov/",
      config: {},
      area_id: null,
      poll_minutes: 3,
      enabled: true,
      last_fetched_at: null,
      etag: null,
      last_modified: null,
    });
    const s = await runFireFeed(
      { ...w.deps, sourceFor: (k) => (k === "public_page" ? null : fireSourceFor(k)) },
      { trigger: "cron" },
    );
    expect(s.fetched.pp!.error).toBe('No adapter for "public_page" in this build.');
    expect(s.leads).toBe(2);
    expect(s.status).toBe("partial");
    expect(w.db.tables.fire_feed_sources!.find((r) => r.id === "pp")!.last_error).toMatch(
      /No adapter/,
    );
  });
});

describe("one run at a time", () => {
  it("refuses Run now while another run is still going", async () => {
    const w = world({ enabled: true });
    w.db.tables.fire_feed_runs!.push({
      id: "run-0",
      status: "running",
      started_at: new Date(NOW.getTime() - 60_000).toISOString(),
    });
    const s = await runFireFeed(w.deps, { trigger: "manual" });
    expect(s.status).toBe("idle");
    expect(s.idleReason).toMatch(/Another run is still going/);
    expect(w.db.tables.fire_feed_runs).toHaveLength(1);
    expect(w.inserted).toHaveLength(0);
  });

  it("a run left 'running' past the window no longer blocks", async () => {
    const w = world({ enabled: true });
    w.db.tables.fire_feed_runs!.push({
      id: "run-0",
      status: "running",
      started_at: new Date(NOW.getTime() - 10 * 60_000).toISOString(),
    });
    const s = await runFireFeed(w.deps, { trigger: "manual" });
    expect(s.leads).toBe(2);
  });
});

describe("a run cut off part way", () => {
  it("has already written the ledger row of every incident it created", async () => {
    const w = world({ enabled: true });
    const ingest = w.deps.ingest;
    let calls = 0;
    w.deps.ingest = async (payload, extras) => {
      calls += 1;
      // The second insert never returns: the hook's request was dropped.
      if (calls === 2) throw new Error("cut off");
      return ingest(payload, extras);
    };
    const s = await runFireFeed(w.deps, { trigger: "cron" });
    expect(s.status).toBe("failed");
    const leads = w.db.tables.fire_feed_items!.filter((r) => r.decision === "lead");
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({ incident_id: "inc-1" });
  });
});
