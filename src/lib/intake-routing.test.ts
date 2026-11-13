import { describe, expect, it } from "vitest";

import {
  distanceKm,
  matchLocationForAddress,
  parseAddressState,
  routingPointFromFields,
  type RoutableLocation,
} from "./intake-routing";

const offices: RoutableLocation[] = [
  { id: "ny", code: "NY", name: "Brooklyn, NY", region: "NY", locality: "Brooklyn" },
  { id: "nj", code: "NJ", name: "Lakewood, NJ", region: "NJ", locality: "Lakewood" },
  { id: "nj2", code: "NJ2", name: "Newark, NJ", region: "NJ", locality: "Newark" },
  { id: "nc", code: "NC", name: "Garner, NC", region: "NC", locality: "Garner" },
  { id: "old", code: "OLD", name: "Closed, NJ", region: "NJ", locality: "Trenton", active: false },
];

describe("parseAddressState", () => {
  it("reads a two-letter code before a ZIP", () => {
    expect(parseAddressState("1309 Ridge Ave, Lakewood, NJ 08701")).toBe("NJ");
    expect(parseAddressState("1733 Flatbush Ave Brooklyn NY 11210-1234")).toBe("NY");
  });

  it("reads a two-letter code at the end or before a comma", () => {
    expect(parseAddressState("12 Maple Ave, Garner, NC")).toBe("NC");
    expect(parseAddressState("12 Maple Ave, Garner, NC, USA")).toBe("NC");
  });

  it("does not read a street name as a state", () => {
    // "IN" is not in the state slot here.
    expect(parseAddressState("40 Main St IN Building 2, Apt 5")).toBeNull();
  });

  it("takes the last code when several appear", () => {
    expect(parseAddressState("NJ Transit Way, Brooklyn, NY 11210")).toBe("NY");
  });

  it("reads a spelled-out state", () => {
    expect(parseAddressState("12 Maple Avenue, Lakewood, New Jersey")).toBe("NJ");
    expect(parseAddressState("5 Oak St, Raleigh, north carolina 27601")).toBe("NC");
  });

  it("is null when nothing is there", () => {
    expect(parseAddressState("")).toBeNull();
    expect(parseAddressState(null)).toBeNull();
    expect(parseAddressState("12 Maple Avenue")).toBeNull();
  });
});

describe("matchLocationForAddress", () => {
  it("prefers the office whose town is in the address", () => {
    expect(matchLocationForAddress("9 Elm St, Newark, NJ 07102", offices)).toEqual({
      locationId: "nj2",
      reason: "locality",
    });
  });

  it("falls back to any office in the state, first by code", () => {
    expect(matchLocationForAddress("9 Elm St, Cherry Hill, NJ 08002", offices)).toEqual({
      locationId: "nj",
      reason: "state",
    });
  });

  it("never picks an inactive office, even on a town match", () => {
    expect(matchLocationForAddress("1 State St, Trenton, NJ 08608", offices).locationId).toBe("nj");
  });

  it("uses the configured fallback when the state has no office", () => {
    expect(matchLocationForAddress("1 Ocean Dr, Miami, FL 33139", offices, "ny")).toEqual({
      locationId: "ny",
      reason: "fallback",
    });
  });

  it("uses the fallback when the address has no state at all", () => {
    expect(matchLocationForAddress("12 Maple Avenue", offices, "nj")).toEqual({
      locationId: "nj",
      reason: "fallback",
    });
  });

  it("returns nothing when there is no match and no usable fallback", () => {
    expect(matchLocationForAddress("1 Ocean Dr, Miami, FL 33139", offices)).toEqual({
      locationId: null,
      reason: "none",
    });
    expect(matchLocationForAddress("1 Ocean Dr, Miami, FL 33139", offices, "old")).toEqual({
      locationId: null,
      reason: "none",
    });
  });

  it("matches the town as a whole word only", () => {
    // "Garnerville" is not Garner.
    expect(matchLocationForAddress("3 Hill Rd, Garnerville, NY 10923", offices)).toEqual({
      locationId: "ny",
      reason: "state",
    });
  });
});

/*
 * David, 22 Sep: "one link that automatically chooses the office based on the
 * location they're reporting." When the form carries the property's point,
 * the closest office wins — inside the property's state when it has one.
 */
describe("closest office from the property's point", () => {
  const placedOffices: RoutableLocation[] = [
    {
      id: "bk",
      code: "BK",
      name: "Brooklyn",
      region: "NY",
      locality: "Brooklyn",
      lat: 40.65,
      lon: -73.95,
    },
    {
      id: "lw",
      code: "LW",
      name: "Lakewood",
      region: "NJ",
      locality: "Lakewood",
      lat: 40.0978,
      lon: -74.2176,
    },
    {
      id: "nw",
      code: "NW",
      name: "Newark",
      region: "NJ",
      locality: "Newark",
      lat: 40.7357,
      lon: -74.1724,
    },
    {
      id: "gn",
      code: "GN",
      name: "Garner",
      region: "NC",
      locality: "Garner",
      lat: 35.7113,
      lon: -78.6142,
    },
    {
      id: "zz",
      code: "ZZ",
      name: "Unplaced",
      region: "NJ",
      locality: "Toms River",
      lat: 0,
      lon: 0,
    },
    {
      id: "off",
      code: "OF",
      name: "Closed",
      region: "NJ",
      locality: "Jackson",
      lat: 40.1,
      lon: -74.3,
      active: false,
    },
  ];
  // Toms River, NJ — nearer Lakewood than Newark.
  const tomsRiver = { lat: 39.9537, lon: -74.1979 };

  it("picks the nearest placed, active office in the state", () => {
    expect(
      matchLocationForAddress("1 Main St, Toms River, NJ 08753", placedOffices, null, {
        point: tomsRiver,
      }),
    ).toEqual({ locationId: "lw", reason: "nearest" });
  });

  it("beats a town match in the text: the point is the better evidence", () => {
    // The address names Newark, but the picked point is in Toms River.
    expect(
      matchLocationForAddress("Newark Ave, Toms River, NJ", placedOffices, null, {
        point: tomsRiver,
      }).locationId,
    ).toBe("lw");
  });

  it("keeps a Jersey City job in New Jersey even though Brooklyn is closer", () => {
    const jerseyCity = { lat: 40.7178, lon: -74.0431 };
    expect(
      matchLocationForAddress("1 Grove St, Jersey City, NJ 07302", placedOffices, null, {
        point: jerseyCity,
        region: "NJ",
      }).locationId,
    ).toBe("nw");
  });

  it("goes to the nearest office anywhere when the state has none", () => {
    const philly = { lat: 39.9526, lon: -75.1652 };
    expect(
      matchLocationForAddress("1 Market St, Philadelphia, PA", placedOffices, "gn", {
        point: philly,
      }),
    ).toEqual({ locationId: "lw", reason: "nearest" });
  });

  it("falls back to the text rules without a point", () => {
    expect(
      matchLocationForAddress("9 Elm St, Newark, NJ 07102", placedOffices, null, { point: null }),
    ).toEqual({ locationId: "nw", reason: "locality" });
  });

  it("reads the point off the form fields, and only a real one", () => {
    expect(routingPointFromFields({ site_lat: "39.95", site_lon: "-74.19" })).toEqual({
      lat: 39.95,
      lon: -74.19,
    });
    expect(routingPointFromFields({ site_lat: "", site_lon: "" })).toBeNull();
    expect(routingPointFromFields({ site_lat: "0", site_lon: "0" })).toBeNull();
    expect(routingPointFromFields({ site_lat: "abc", site_lon: "-74" })).toBeNull();
    expect(routingPointFromFields({})).toBeNull();
  });

  it("measures distance sensibly", () => {
    // Lakewood to Newark is about 71 km as the crow flies.
    const km = distanceKm({ lat: 40.0978, lon: -74.2176 }, { lat: 40.7357, lon: -74.1724 });
    expect(km).toBeGreaterThan(65);
    expect(km).toBeLessThan(75);
  });
});
