import { describe, expect, it } from "vitest";

import { googleNewsQuery, googleNewsUrl, splitPublisher } from "./google-news";

describe("Google News query per watch area", () => {
  it("is the fire terms, the town or county, the state, and the last day", () => {
    expect(googleNewsQuery({ locality: "Lakewood", county: "Ocean", state: "NJ" })).toBe(
      '(fire OR "house fire" OR "structure fire" OR blaze OR "2-alarm" OR "3-alarm") ("Lakewood" OR "Ocean County") NJ when:1d',
    );
  });

  it("works with a town alone, or a county alone, and never doubles 'County'", () => {
    expect(googleNewsQuery({ locality: "Haverstraw", county: null, state: "NY" })).toMatch(
      /\) "Haverstraw" NY when:1d$/,
    );
    expect(googleNewsQuery({ locality: null, county: "Rockland County", state: "NY" })).toMatch(
      /\) "Rockland County" NY when:1d$/,
    );
  });

  it("drops quotes a town name might carry, so the query cannot be broken open", () => {
    expect(googleNewsQuery({ locality: 'Lake"wood', county: null, state: "NJ" })).toContain(
      '"Lakewood"',
    );
  });

  it("is the published RSS search endpoint, not google.com search", () => {
    const url = googleNewsUrl({ locality: "Lakewood", county: null, state: "NJ" });
    expect(url.startsWith("https://news.google.com/rss/search?q=")).toBe(true);
    expect(url).toContain("&hl=en-US&gl=US&ceid=US:en");
    expect(decodeURIComponent(url)).toContain('"Lakewood" NJ when:1d');
  });
});

describe("splitPublisher", () => {
  it("splits 'Headline - Publisher' using the <source> when Google gives it", () => {
    expect(splitPublisher("Fire guts home - Asbury Park Press", "Asbury Park Press")).toEqual({
      headline: "Fire guts home",
      publisher: "Asbury Park Press",
    });
  });

  it("splits on the last ' - ' when there is no <source>", () => {
    expect(splitPublisher("House fire - a long night - News12 | New Jersey", null)).toEqual({
      headline: "House fire - a long night",
      publisher: "News12 | New Jersey",
    });
  });

  it("leaves a title without a publisher alone", () => {
    expect(splitPublisher("Fire on Main Street", null)).toEqual({
      headline: "Fire on Main Street",
      publisher: null,
    });
  });
});
