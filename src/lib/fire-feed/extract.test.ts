import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  addressOf,
  alarmLevelOf,
  extractByRules,
  mentionedArea,
  mightBeAFire,
  townNamedIn,
} from "./extract";
import { splitPublisher } from "./google-news";
import { parseFeed } from "./rss-parse";
import type { RawItem, WatchArea } from "./types";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

const area = (over: Partial<WatchArea>): WatchArea => ({
  id: over.locality ?? "a",
  label: over.locality ?? "a",
  locality: null,
  county: null,
  state: "NJ",
  postal_codes: [],
  center_lat: null,
  center_lon: null,
  radius_miles: 15,
  active: true,
  ...over,
});
const AREAS = [
  area({ id: "lkw", locality: "Lakewood", county: "Ocean" }),
  area({ id: "tr", locality: "Toms River" }),
  area({ id: "hav", locality: "Haverstraw", state: "NY" }),
];

const item = (title: string, text = "", over: Partial<RawItem> = {}): RawItem => ({
  key: title,
  sourceKind: "rss",
  sourceId: "s",
  title,
  url: null,
  publisher: null,
  publishedAt: "2026-10-11T19:00:00.000Z",
  text,
  areaId: null,
  ...over,
});

describe("the recorded Google News samples: nothing in them is a structure-fire lead", () => {
  // Every headline Google returned for three watch areas on 11 Oct 2026.
  const headlines = [
    "google-news-lakewood-nj.xml",
    "google-news-haverstraw-ny.xml",
    "google-news-toms-river-nj.xml",
  ].flatMap((f) => parseFeed(fixture(f)).map((it) => splitPublisher(it.title, it.source).headline));

  it.each(headlines)("%s", (headline) => {
    const ex = extractByRules(item(headline), AREAS);
    const wouldLead = ex.category === "structure" && !ex.followUp;
    expect(wouldLead).toBe(false);
  });

  it("refuses them for the right reasons", () => {
    const why = (h: string) => {
      const ex = extractByRules(item(h), AREAS);
      return ex.followUp ? "follow_up" : ex.category;
    };
    expect(
      why(
        "Man Opens Fire on Speeding Car That Nearly Hit Him Outside Delaware Restaurant, Police Say",
      ),
    ).toBe("not_fire");
    expect(
      why(
        "What about the jet skis? Clark Fire Official's Jersey Shore Trip in Department Vehicle Raises Criticism",
      ),
    ).toBe("not_fire");
    expect(why("Ocean County Italian Festival celebrates food, fun in Seaside Heights")).toBe(
      "not_fire",
    );
    expect(
      why("Plumsted Man Charged With Arson After Firefighter Injured Battling Garage Fire"),
    ).toBe("follow_up");
    expect(why("Squatter accused of arson in blaze that injured firefighter")).toBe("follow_up");
    expect(why("Unoccupied Boat Catches Fire, Drifts Toward Shore at Long Island Marina")).toBe(
      "vehicle",
    );
  });
});

describe("structure fires, read by rules", () => {
  it("a two-alarm house fire with an address, displacement and the Red Cross", () => {
    const [house] = parseFeed(fixture("fire-department-sample.xml"));
    const ex = extractByRules(item(house!.title, house!.description), AREAS);
    expect(ex).toMatchObject({
      category: "structure",
      occupancy: "residential",
      address: "412 Pine Street",
      locality: "Lakewood",
      state: "NJ",
      alarmLevel: "2nd alarm",
      displaced: true,
      injuries: false,
      buildingType: "Single-family home",
      followUp: false,
      method: "rules",
    });
  });

  it("a restaurant kitchen fire is commercial, with an injury", () => {
    const ex = extractByRules(
      item(
        "Firefighters knock down kitchen fire at Main St. restaurant",
        "A kitchen fire at a restaurant at 88 Main St., Toms River, was contained. One employee was treated for smoke inhalation.",
      ),
      AREAS,
    );
    expect(ex.category).toBe("structure");
    expect(ex.occupancy).toBe("commercial");
    expect(ex.address).toBe("88 Main St");
    expect(ex.locality).toBe("Toms River");
    expect(ex.injuries).toBe(true);
    expect(ex.buildingType).toBe("Commercial (restaurant)");
  });

  it("an apartment fire at cross streets is multi-family, with the cross streets kept", () => {
    const ex = extractByRules(
      item(
        "Apartment fire at Cedar & Oak avenues; residents evacuated",
        "Heavy smoke was showing from a three-story apartment building at Cedar Avenue and Oak Avenue in Haverstraw. Several residents were displaced.",
      ),
      AREAS,
    );
    expect(ex.category).toBe("structure");
    expect(ex.occupancy).toBe("multi_family");
    expect(ex.address).toBeNull();
    expect(ex.crossStreets).toBe("Cedar Avenue & Oak Avenue");
    expect(ex.locality).toBe("Haverstraw");
    expect(ex.state).toBe("NY");
    expect(ex.buildingType).toMatch(/^Multi-family/);
  });

  it("brush, vehicle and an open house are not structure fires", () => {
    expect(extractByRules(item("Brush fire burns 3 acres near Route 9"), AREAS).category).toBe(
      "brush",
    );
    expect(
      extractByRules(item("Car fire on Garden State Parkway snarls traffic"), AREAS).category,
    ).toBe("vehicle");
    expect(
      extractByRules(item("Fire Prevention Week open house Saturday at Station 2"), AREAS).category,
    ).toBe("not_fire");
  });

  it("a 911 CAD line: STRUCTURE FIRE at an address, in capitals", () => {
    const ex = extractByRules(item("STRUCTURE FIRE at 266 MOULSON ST ROC"), AREAS);
    expect(ex.category).toBe("structure");
    expect(ex.address).toBe("266 Moulson St");
  });

  it("a 911 CAD line that is not a fire", () => {
    expect(extractByRules(item("MVA / NO INJURIES at 3725 DEWEY AVE GRE"), AREAS).category).toBe(
      "not_fire",
    );
  });

  it("a structured row's own type and address win over the prose", () => {
    const ex = extractByRules(
      item("Call", "", {
        structured: {
          incidentType: "FIRE - RESIDENTIAL",
          address: "10 ELM ST",
          locality: "Lakewood",
        },
      }),
      AREAS,
    );
    expect(ex.category).toBe("structure");
    expect(ex.address).toBe("10 Elm St");
    expect(ex.locality).toBe("Lakewood");
  });
});

describe("pieces", () => {
  it.each([
    ["Two-alarm fire", "2nd alarm"],
    ["3-alarm blaze", "3rd alarm"],
    ["a fourth-alarm was struck", "4th alarm"],
    ["an all-hands fire", "all hands"],
    ["fire alarm sounded", null],
  ])("alarmLevelOf(%s)", (text, want) => {
    expect(alarmLevelOf(text)).toBe(want);
  });

  it("reads a block address as approximate", () => {
    expect(addressOf("Fire in the 100 block of Clifton Avenue")).toEqual({
      address: "100 Clifton Avenue",
      crossStreets: null,
      blockLevel: true,
    });
  });

  it("reads a numbered route", () => {
    expect(addressOf("Fire at 1500 Route 9 business").address).toBe("1500 Route 9");
  });

  it("does not read a year as a house number", () => {
    expect(addressOf("2026 Fire Company Parade Route").address).toBeNull();
  });

  it.each([
    ["A kitchen fire at a restaurant at 88 Main St., Toms River, was contained.", "Toms River"],
    ["Smoke showed from an apartment building in Haverstraw.", "Haverstraw"],
    ["Fire broke out in Ocean County on Sunday.", null],
    ["Fire broke out in the morning.", null],
    ["Crews were called in Sunday.", null],
  ])("townNamedIn(%s)", (text, want) => {
    expect(townNamedIn(text)).toBe(want);
  });

  it("names the area by town before county", () => {
    expect(mentionedArea("blaze in Toms River, Ocean County", AREAS)?.id).toBe("tr");
    expect(mentionedArea("blaze somewhere in Ocean County", AREAS)?.id).toBe("lkw");
    expect(mentionedArea("blaze in Trenton", AREAS)).toBeNull();
  });

  it("the cheap gate keeps the model off items with no fire word at all", () => {
    expect(mightBeAFire(item("Ocean County Italian Festival celebrates food"))).toBe(false);
    expect(mightBeAFire(item("Man opens fire on car"))).toBe(false);
    expect(mightBeAFire(item("Blaze damages home"))).toBe(true);
  });
});
