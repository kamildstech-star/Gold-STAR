import { describe, expect, it } from "vitest";

import {
  canonicalUrl,
  externalRefFor,
  ledgerKey,
  normalizeLocality,
  normalizeStreetAddress,
  sameFire,
  type FireSighting,
} from "./dedupe";

describe("canonicalUrl — one spelling per article", () => {
  it("drops tracking, fragments, www/amp hosts, AMP paths and trailing slashes", () => {
    expect(
      canonicalUrl(
        "https://www.shorelocal.example/news/fire-guts-lakewood-home/amp/?utm_campaign=x#top",
      ),
    ).toBe("https://shorelocal.example/news/fire-guts-lakewood-home");
    expect(
      canonicalUrl("http://fire.example.gov/incidents/2026-1011-01?utm_source=rss&utm_medium=feed"),
    ).toBe("https://fire.example.gov/incidents/2026-1011-01");
  });

  it("keeps parameters that identify the page, sorted", () => {
    expect(canonicalUrl("https://a.example/story?id=9&b=2&fbclid=zz")).toBe(
      "https://a.example/story?b=2&id=9",
    );
  });

  it("refuses anything that is not http(s)", () => {
    expect(canonicalUrl("javascript:alert(1)")).toBeNull();
    expect(canonicalUrl("not a url")).toBeNull();
    expect(canonicalUrl(null)).toBeNull();
  });
});

describe("externalRefFor — fits incidents.external_ref (128)", () => {
  it("passes a short key through", () => {
    expect(externalRefFor("gnews:CBMi123")).toBe("gnews:CBMi123");
  });

  it("shortens a long key without letting two long keys collide", () => {
    const a = `gnews:${"x".repeat(200)}A`;
    const b = `gnews:${"x".repeat(200)}B`;
    expect(externalRefFor(a).length).toBeLessThanOrEqual(128);
    expect(externalRefFor(a)).not.toBe(externalRefFor(b));
    expect(externalRefFor(a)).toBe(externalRefFor(a));
  });
});

describe("ledgerKey — fits fire_feed_items.item_key (300)", () => {
  it("a Google News guid key longer than the column is shortened the same way every time", () => {
    const long = `gnews:${"C".repeat(400)}`;
    expect(ledgerKey(long).length).toBeLessThanOrEqual(300);
    expect(ledgerKey(long)).toBe(ledgerKey(long));
    expect(ledgerKey(`${long}x`)).not.toBe(ledgerKey(long));
    expect(ledgerKey("short")).toBe("short");
  });
});

describe("address and town normalization", () => {
  it("treats St / Street, N / North and a unit number as the same address", () => {
    expect(normalizeStreetAddress("12 N. Main St., Apt 3")).toBe("12 north main street");
    expect(normalizeStreetAddress("12 North Main Street")).toBe("12 north main street");
  });

  it("has no street address without a house number", () => {
    expect(normalizeStreetAddress("Main Street")).toBeNull();
  });

  it("treats Township / Borough as the same town", () => {
    expect(normalizeLocality("Lakewood Township")).toBe("lakewood");
    expect(normalizeLocality("Borough of Haverstraw")).toBe("haverstraw");
  });
});

describe("sameFire", () => {
  const at = (h: number) => new Date(Date.UTC(2026, 9, 11, h)).toISOString();
  const s = (over: Partial<FireSighting>): FireSighting => ({
    address: null,
    locality: "Lakewood",
    lat: null,
    lon: null,
    reportedAt: at(12),
    streetLevel: false,
    ...over,
  });

  it("same street address, hours apart, two spellings: one fire", () => {
    expect(
      sameFire(
        s({ address: "412 Pine St" }),
        s({ address: "412 Pine Street", reportedAt: at(20) }),
      ),
    ).toBe("same_address");
  });

  it("same address a week later is a new fire", () => {
    expect(
      sameFire(
        s({ address: "412 Pine St" }),
        s({ address: "412 Pine St", reportedAt: "2026-10-18T12:00:00.000Z" }),
      ),
    ).toBeNull();
  });

  it("two street addresses a few yards apart (412 vs 414 on one geocode): the same building", () => {
    const a = s({ address: "412 Pine St", lat: 40.08, lon: -74.21, streetLevel: true });
    const b = s({ address: "414 Pine St", lat: 40.0802, lon: -74.2101, streetLevel: true });
    expect(sameFire(a, b)).toBe("same_point");
  });

  it("two different street addresses far apart are two fires, however close in time", () => {
    const a = s({ address: "412 Pine St", lat: 40.08, lon: -74.21, streetLevel: true });
    const b = s({ address: "9 Oak Ave", lat: 40.1, lon: -74.25, streetLevel: true });
    expect(sameFire(a, b)).toBeNull();
  });

  it("a town-only report and a street report in that town within six hours: one fire", () => {
    expect(sameFire(s({}), s({ address: "412 Pine St", reportedAt: at(15) }))).toBe("same_town");
  });

  it("…but not after six hours, and not in another town", () => {
    expect(sameFire(s({}), s({ address: "412 Pine St", reportedAt: at(19) }))).toBeNull();
    expect(sameFire(s({}), s({ locality: "Toms River", reportedAt: at(13) }))).toBeNull();
  });
});
