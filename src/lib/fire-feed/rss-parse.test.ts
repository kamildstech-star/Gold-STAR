import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { decodeEntities, detectFeedFormat, parseFeed, parseFeedDate, textOf } from "./rss-parse";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

/*
 * The Google News files are real responses, fetched 11 Oct 2026 for the
 * Lakewood, Haverstraw and Toms River watch areas. Monroe County's is the
 * county's real public 911 feed (first six items). The fire department and
 * local news files are synthetic, in the shapes those sites publish.
 */
describe("parseFeed — Google News RSS (recorded)", () => {
  it("reads every item of each area's response", () => {
    expect(parseFeed(fixture("google-news-lakewood-nj.xml"))).toHaveLength(5);
    expect(parseFeed(fixture("google-news-haverstraw-ny.xml"))).toHaveLength(7);
    expect(parseFeed(fixture("google-news-toms-river-nj.xml"))).toHaveLength(8);
  });

  it("keeps the title, Google's guid, the publisher and a real timestamp", () => {
    const [first] = parseFeed(fixture("google-news-lakewood-nj.xml"));
    expect(first!.title).toBe(
      "Squatter accused of arson in blaze that injured firefighter - NJ.com",
    );
    expect(first!.guid).toMatch(/^CBMi/);
    expect(first!.link).toMatch(/^https:\/\/news\.google\.com\/rss\/articles\//);
    expect(first!.source).toBe("NJ.com");
    expect(first!.published).toBe("2026-10-11T18:15:00.000Z");
  });

  it("strips the escaped HTML Google puts in the description", () => {
    for (const item of parseFeed(fixture("google-news-toms-river-nj.xml"))) {
      expect(item.description).not.toMatch(/<|&lt;|&nbsp;/);
    }
  });
});

describe("parseFeed — a county 911 feed (Monroe County, NY, recorded)", () => {
  const items = parseFeed(fixture("monroe-county-911.xml"));

  it("reads the CAD line and the coordinates on every item", () => {
    expect(items).toHaveLength(6);
    expect(items[0]!.title).toBe("MVA / NO INJURIES at 3725 DEWEY AVE GRE");
    expect(items[0]!.lat).toBeCloseTo(43.2381, 4);
    expect(items[0]!.lon).toBeCloseTo(-77.6474, 4);
    expect(items[0]!.guid).toBe("https://www.monroecounty.gov/safety-incidents?GREE2628401918");
  });

  it("reads an offset date", () => {
    expect(items[0]!.published).toBe("2026-10-11T21:09:00.000Z");
  });
});

describe("parseFeed — fire department RSS and local news Atom (synthetic)", () => {
  it("unwraps CDATA and drops markup", () => {
    const [house] = parseFeed(fixture("fire-department-sample.xml"));
    expect(house!.description).toContain("412 Pine Street");
    expect(house!.description).not.toContain("<b>");
    expect(house!.link).toContain("utm_source=rss");
  });

  it("reads Atom: the alternate link, not the enclosure; GeoRSS point; html summary decoded", () => {
    const [entry, charged] = parseFeed(fixture("local-news-sample.atom.xml"));
    expect(detectFeedFormat(fixture("local-news-sample.atom.xml"))).toBe("atom");
    expect(entry!.link).toBe(
      "https://www.shorelocal.example/news/fire-guts-lakewood-home/amp/?utm_campaign=x",
    );
    expect(entry!.lat).toBeCloseTo(40.0951, 4);
    expect(entry!.lon).toBeCloseTo(-74.2176, 4);
    expect(entry!.description).toBe(
      "A fire tore through a house at 27 5th Street in Lakewood on Sunday. One firefighter suffered minor burns.",
    );
    expect(entry!.published).toBe("2026-10-11T23:55:00.000Z");
    expect(charged!.link).toBe("https://www.shorelocal.example/news/arson-charge");
  });

  it("returns nothing for a page that is not a feed", () => {
    expect(parseFeed("<!doctype html><html><body>Not found</body></html>")).toEqual([]);
  });
});

describe("text helpers", () => {
  it("decodes the XML entities and numeric references, and nothing it does not know", () => {
    expect(decodeEntities("Fire &amp; Rescue &#8211; &#x2014; &bogus;")).toBe(
      "Fire & Rescue – — &bogus;",
    );
  });

  it("textOf collapses whitespace and strips scripts", () => {
    expect(textOf("<p>a</p>\n<script>alert(1)</script>  b")).toBe("a b");
  });

  it("parseFeedDate reads RFC 822, ISO 8601, and gives up politely", () => {
    expect(parseFeedDate("Sun, 11 Oct 2026 18:15:00 GMT")).toBe("2026-10-11T18:15:00.000Z");
    expect(parseFeedDate("2026-10-11T19:55:00-04:00")).toBe("2026-10-11T23:55:00.000Z");
    expect(parseFeedDate("yesterday-ish")).toBeNull();
  });
});
