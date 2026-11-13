import { describe, expect, it } from "vitest";

import { incidentPayloadSchema } from "@/lib/incident-payload";

import {
  DEFAULT_FEED_SETTINGS,
  findMatch,
  leadPayload,
  mergePatch,
  postalCodeOf,
  reportedAtFor,
  triage,
  type CandidateIncident,
  type LocatePlan,
} from "./decide";
import { extractByRules, type Extraction } from "./extract";
import type { RawItem, WatchArea } from "./types";

const NOW = new Date("2026-10-11T21:00:00.000Z");

const lakewood: WatchArea = {
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
};
const AREAS = [lakewood];

const item = (title: string, text = "", over: Partial<RawItem> = {}): RawItem => ({
  key: `k:${title}`,
  sourceKind: "google_news",
  sourceId: "src-gn",
  title,
  url: "https://news.google.com/rss/articles/abc",
  publisher: "Asbury Park Press",
  publishedAt: "2026-10-11T19:00:00.000Z",
  text,
  areaId: "lkw",
  ...over,
});

const plan = (t: ReturnType<typeof triage>): LocatePlan => {
  if (!("locate" in t)) throw new Error(`expected a plan, got ${t.skip}`);
  return t.locate;
};

describe("triage", () => {
  const ex = (i: RawItem): Extraction => extractByRules(i, AREAS);

  it("a house fire with an address is geocoded at that address in that town", () => {
    const i = item("Two-alarm house fire at 412 Pine Street in Lakewood displaces family");
    const p = plan(triage(i, ex(i), AREAS, NOW, DEFAULT_FEED_SETTINGS));
    expect(p).toMatchObject({
      query: "412 Pine Street, Lakewood, NJ",
      streetLevel: true,
      address: "412 Pine Street",
      reviewReason: null,
    });
  });

  it("a town-only story lands for review, unless the street address is required", () => {
    const i = item("Fire damages Lakewood home");
    const p = plan(triage(i, ex(i), AREAS, NOW, DEFAULT_FEED_SETTINGS));
    expect(p).toMatchObject({ query: "Lakewood, NJ", streetLevel: false, address: null });
    expect(p.reviewReason).toMatch(/^Town only/);
    expect(
      triage(i, ex(i), AREAS, NOW, { ...DEFAULT_FEED_SETTINGS, requireStreetAddress: true }),
    ).toEqual({ skip: "town_only" });
  });

  it("the queried area places a story only when the story names it", () => {
    // Found by the Lakewood query, about Plumsted: looked up in Plumsted, and
    // the area check after geocoding decides whether that is close enough.
    const i = item("Fire destroys home in Plumsted");
    expect(plan(triage(i, ex(i), AREAS, NOW, DEFAULT_FEED_SETTINGS))).toMatchObject({
      locality: "Plumsted",
      query: "Plumsted, NJ",
    });
    // Naming no town at all, it cannot be placed — not even in Lakewood.
    const j = item("Fire destroys home, family escapes");
    expect(triage(j, ex(j), AREAS, NOW, DEFAULT_FEED_SETTINGS)).toEqual({ skip: "no_location" });
  });

  it("a street with no town is not geocoded on its own", () => {
    const i = item("House fire at 12 Main Street", "", { areaId: null });
    expect(triage(i, ex(i), AREAS, NOW, DEFAULT_FEED_SETTINGS)).toEqual({ skip: "no_location" });
  });

  it("each refusal has its reason", () => {
    const t = (title: string) => {
      const i = item(title);
      const r = triage(i, ex(i), AREAS, NOW, DEFAULT_FEED_SETTINGS);
      return "skip" in r ? r.skip : "lead";
    };
    expect(t("Man opens fire on car in Lakewood")).toBe("not_a_fire");
    expect(t("Lakewood man charged with arson in house fire")).toBe("follow_up");
    expect(t("Brush fire burns 3 acres in Lakewood")).toBe("brush_fire");
    expect(t("Car fire closes Route 9 in Lakewood")).toBe("vehicle_fire");
    expect(t("Dumpster fire behind Lakewood plaza")).toBe("other_fire");
  });

  it("an item older than the window is history", () => {
    const i = item("House fire in Lakewood", "", { publishedAt: "2026-10-09T08:00:00.000Z" });
    expect(triage(i, ex(i), AREAS, NOW, DEFAULT_FEED_SETTINGS)).toEqual({ skip: "too_old" });
  });

  it("a feed's own point is used, and its address still geocoded for the ZIP", () => {
    const i = item("STRUCTURE FIRE at 266 MOULSON ST LKW", "", {
      point: { lat: 40.09, lon: -74.2 },
      areaId: null,
      sourceKind: "rss",
    });
    const p = plan(
      triage(i, { ...ex(i), locality: "Lakewood" }, AREAS, NOW, DEFAULT_FEED_SETTINGS),
    );
    expect(p.point).toEqual({ lat: 40.09, lon: -74.2 });
    expect(p.query).toBe("266 Moulson St, Lakewood, NJ");
  });
});

describe("postalCodeOf", () => {
  it.each([
    ["412 Pine St, Lakewood, NJ 08701, USA", "08701"],
    ["412 Pine St, Lakewood, NJ 08701-2245, USA", "08701"],
    ["412, Pine Street, Lakewood, Ocean County, New Jersey, 08701, United States", "08701"],
    ["12345 Long Road, Somewhere, New Jersey", null],
    [null, null],
  ])("%s → %s", (formatted, zip) => {
    expect(postalCodeOf(formatted)).toBe(zip);
  });
});

describe("the insertion payload — what lands through ingestIncident", () => {
  const i = item(
    "Two-alarm house fire at 412 Pine Street in Lakewood displaces family",
    "No injuries were reported; the Red Cross is assisting.",
  );
  const ex = extractByRules(i, AREAS);
  const p = plan(triage(i, ex, AREAS, NOW, DEFAULT_FEED_SETTINGS));
  const geo = {
    lat: 40.081,
    lon: -74.21,
    postalCode: "08701",
    formatted: "412 Pine St, Lakewood, NJ 08701, USA",
  };
  const { payload, extras } = leadPayload(i, ex, p, geo, { area: lakewood, by: "radius" }, NOW);

  it("passes the webhook's own schema", () => {
    expect(incidentPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it("is a fire, from google_news, keyed by the item, at the address and ZIP that route it", () => {
    expect(payload).toMatchObject({
      source: "google_news",
      external_ref: i.key,
      reported_at: "2026-10-11T19:00:00.000Z",
      incident_type: "fire",
      alarm_level: "2nd alarm",
      building_type: "Single-family home",
      address: "412 Pine Street",
      locality: "Lakewood",
      region: "NJ",
      postal_code: "08701",
      lat: 40.081,
      lon: -74.21,
    });
  });

  it("carries the story for the chaser: who reported it, what it said, the link", () => {
    expect(payload.raw_text).toContain("Asbury Park Press: Two-alarm house fire");
    expect(payload.raw_text).toContain("Residents displaced");
    expect(payload.raw_text).toContain("https://news.google.com/rss/articles/abc");
    expect(payload.raw_text).toContain("Fire feed · Lakewood, NJ · read by rules");
  });

  it("stores the source link, and needs no review with a real street address", () => {
    expect(extras.source_links).toEqual([
      {
        kind: "google_news",
        url: "https://news.google.com/rss/articles/abc",
        title: i.title,
        publisher: "Asbury Park Press",
        published_at: "2026-10-11T19:00:00.000Z",
      },
    ]);
    expect(extras.needs_review).toBe(false);
  });

  it("never claims a time in the future, nor more than a week back", () => {
    expect(reportedAtFor(item("x", "", { publishedAt: "2026-10-12T09:00:00.000Z" }), NOW)).toBe(
      NOW.toISOString(),
    );
    expect(reportedAtFor(item("x", "", { publishedAt: "2026-09-01T00:00:00.000Z" }), NOW)).toBe(
      "2026-10-04T21:00:00.000Z",
    );
    expect(reportedAtFor(item("x", "", { publishedAt: null }), NOW)).toBe(NOW.toISOString());
  });
});

describe("merging a corroborating report", () => {
  const existing: CandidateIncident = {
    id: "inc-1",
    source: "google_news",
    address: null,
    locality: "Lakewood",
    postal_code: null,
    lat: 40.0821,
    lon: -74.2097,
    reported_at: "2026-10-11T18:30:00.000Z",
    needs_review: true,
    review_reason: "Town only — the report gave no street address",
    source_links: [
      {
        kind: "google_news",
        url: "https://a.example/1",
        title: "Fire damages Lakewood home",
        publisher: "A",
        published_at: null,
      },
    ],
  };

  it("finds a town-only lead for a street report in the same town", () => {
    const m = findMatch(
      {
        address: "412 Pine Street",
        locality: "Lakewood",
        lat: 40.081,
        lon: -74.21,
        reportedAt: "2026-10-11T19:00:00.000Z",
        streetLevel: true,
      },
      [existing],
    );
    expect(m?.incident.id).toBe("inc-1");
    expect(m?.reason).toBe("same_town");
  });

  it("adds the link, fills in the street, and clears the town-only review", () => {
    const i = item("Fire at 412 Pine Street, Lakewood", "", {
      url: "https://b.example/2",
      sourceKind: "rss",
    });
    const p: LocatePlan = {
      query: "x",
      point: null,
      streetLevel: true,
      address: "412 Pine Street",
      locality: "Lakewood",
      state: "NJ",
      reviewReason: null,
    };
    const patch = mergePatch(existing, i, p, {
      lat: 40.081,
      lon: -74.21,
      postalCode: "08701",
      formatted: null,
    })!;
    expect((patch.source_links as unknown[]).length).toBe(2);
    expect(patch).toMatchObject({
      address: "412 Pine Street",
      postal_code: "08701",
      needs_review: false,
      review_reason: null,
    });
  });

  it("adds nothing for a link it already has", () => {
    const i = item("Fire damages Lakewood home", "", { url: "https://a.example/1" });
    const p: LocatePlan = {
      query: "x",
      point: null,
      streetLevel: false,
      address: null,
      locality: "Lakewood",
      state: "NJ",
      reviewReason: null,
    };
    expect(
      mergePatch(existing, i, p, { lat: 1, lon: 1, postalCode: null, formatted: null }),
    ).toBeNull();
  });
});
