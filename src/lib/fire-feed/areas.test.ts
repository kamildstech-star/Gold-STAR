import { describe, expect, it } from "vitest";

import { areaForFire, areaPlaceName } from "./areas";
import type { WatchArea } from "./types";

const area = (over: Partial<WatchArea>): WatchArea => ({
  id: "a",
  label: "a",
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

// Offices' own coordinates, as the migration seeds them.
const lakewood = area({
  id: "lkw",
  locality: "Lakewood",
  center_lat: 40.0821,
  center_lon: -74.2097,
});
const haverstraw = area({
  id: "hav",
  locality: "Haverstraw",
  state: "NY",
  center_lat: 41.1976,
  center_lon: -73.9646,
});
const tomsRiverZips = area({ id: "tr", locality: "Toms River", postal_codes: ["08753", "08755"] });
const byName = area({ id: "brk", locality: "Brooklyn", state: "NY" });

describe("areaForFire", () => {
  it("inside an office's radius", () => {
    // Jackson, NJ — about 7 miles from the Lakewood office.
    expect(
      areaForFire(
        { lat: 40.1065, lon: -74.3507, postalCode: null, locality: "Jackson", state: "NJ" },
        [lakewood],
        null,
      ),
    ).toEqual({
      area: lakewood,
      by: "radius",
    });
  });

  it("outside every radius is outside", () => {
    // Trenton — about 30 miles away.
    expect(
      areaForFire(
        { lat: 40.2171, lon: -74.7429, postalCode: null, locality: "Trenton", state: "NJ" },
        [lakewood, haverstraw],
        null,
      ),
    ).toBeNull();
  });

  it("by ZIP when the area lists ZIPs", () => {
    expect(
      areaForFire(
        { lat: 39.95, lon: -74.2, postalCode: "08753-1234", locality: null, state: "NJ" },
        [tomsRiverZips],
        null,
      )?.by,
    ).toBe("zip");
    expect(
      areaForFire(
        { lat: 39.95, lon: -74.2, postalCode: "08701", locality: "Toms River", state: "NJ" },
        [tomsRiverZips],
        null,
      ),
    ).toBeNull();
  });

  it("by town name when the area has neither a center nor ZIPs", () => {
    expect(
      areaForFire(
        { lat: 40.6, lon: -73.9, postalCode: null, locality: "Brooklyn", state: "NY" },
        [byName],
        null,
      )?.by,
    ).toBe("town");
  });

  it("never across a state line", () => {
    expect(
      areaForFire(
        { lat: 40.0821, lon: -74.2097, postalCode: null, locality: "Lakewood", state: "NY" },
        [lakewood],
        null,
      ),
    ).toBeNull();
  });

  it("skips a switched-off area", () => {
    expect(
      areaForFire(
        { lat: 40.0821, lon: -74.2097, postalCode: null, locality: null, state: null },
        [{ ...lakewood, active: false }],
        null,
      ),
    ).toBeNull();
  });

  it("two overlapping circles: the area the source asked about, else the nearest", () => {
    const near = area({ id: "near", locality: "Howell", center_lat: 40.15, center_lon: -74.2 });
    const fire = { lat: 40.14, lon: -74.2, postalCode: null, locality: null, state: "NJ" };
    expect(areaForFire(fire, [lakewood, near], null)?.area.id).toBe("near");
    expect(areaForFire(fire, [lakewood, near], "lkw")?.area.id).toBe("lkw");
  });

  it("names an area the way a person writes it", () => {
    expect(areaPlaceName(lakewood)).toBe("Lakewood, NJ");
    expect(areaPlaceName({ locality: null, county: "Rockland County", state: "NY" })).toBe(
      "Rockland County, NY",
    );
  });
});
