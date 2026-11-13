import { describe, expect, it } from "vitest";

import {
  geocodeCacheKey,
  resolveStopPositions,
  stopAddressQuery,
  unresolvedQueries,
} from "./stop-positions";
import type { PlannableStop } from "./visits";

const stop = (id: string, over: Partial<PlannableStop> = {}): PlannableStop => ({
  id,
  name: id,
  address: null,
  street: null,
  city: null,
  state: null,
  postal_code: null,
  area: null,
  last_in_person_at: null,
  kind: "prospect",
  stage_id: null,
  stage_key: null,
  stage_name: null,
  stage_order: null,
  value: 0,
  stage_color: null,
  health_name: null,
  health_color: null,
  owner_id: null,
  owner_name: null,
  contact_name: null,
  email: null,
  phone: null,
  ...over,
});

describe("geocodeCacheKey", () => {
  it("normalizes case and whitespace the way the server does", () => {
    expect(geocodeCacheKey("  12 Main   St,  Newark, NJ ")).toBe("12 main st, newark, nj");
  });
});

describe("stopAddressQuery", () => {
  it("joins the parts of a full address", () => {
    expect(
      stopAddressQuery({ street: "12 Main St", city: "Newark", state: "NJ", postal_code: "07102" }),
    ).toBe("12 Main St, Newark, NJ, 07102");
  });
  it("refuses a city-only address rather than pinning the town center", () => {
    expect(stopAddressQuery({ street: null, city: "Newark", state: "NJ", postal_code: null })).toBe(
      null,
    );
  });
  it("refuses a bare street name with nothing to anchor it", () => {
    expect(
      stopAddressQuery({ street: "Main St", city: null, state: null, postal_code: null }),
    ).toBe(null);
  });
  it("accepts a numbered street on its own", () => {
    expect(
      stopAddressQuery({ street: "12 Main St", city: null, state: null, postal_code: null }),
    ).toBe("12 Main St");
  });
});

describe("resolveStopPositions", () => {
  const a = stop("a", { street: "12 Main St", city: "Newark", state: "NJ" });
  const b = stop("b", { street: "9 Elm Ave", city: "Newark", state: "NJ" });
  const c = stop("c");

  it("prefers the geocoded address over a past visit", () => {
    const geocoded = new Map([
      [geocodeCacheKey("12 Main St, Newark, NJ"), { lat: 40.7, lon: -74.2 }],
    ]);
    const visits = new Map([["a", { lat: 1, lon: 1 }]]);
    const pos = resolveStopPositions([a], geocoded, visits);
    expect(pos.get("a")).toEqual({ lat: 40.7, lon: -74.2, source: "geocode" });
  });

  it("falls back to where the last visit was logged", () => {
    const pos = resolveStopPositions([b], new Map(), new Map([["b", { lat: 40.71, lon: -74.21 }]]));
    expect(pos.get("b")).toEqual({ lat: 40.71, lon: -74.21, source: "visit" });
  });

  it("uses a visit when the geocoder could not resolve the address", () => {
    const geocoded = new Map([[geocodeCacheKey("9 Elm Ave, Newark, NJ"), null]]);
    const pos = resolveStopPositions([b], geocoded, new Map([["b", { lat: 2, lon: 3 }]]));
    expect(pos.get("b")?.source).toBe("visit");
  });

  it("leaves a stop with neither out entirely", () => {
    const pos = resolveStopPositions([c], new Map(), new Map());
    expect(pos.has("c")).toBe(false);
  });
});

describe("unresolvedQueries", () => {
  it("lists addresses the cache has not answered, once each", () => {
    const a = stop("a", { street: "12 Main St", city: "Newark" });
    const dup = stop("dup", { street: "12 main st", city: "newark" });
    const known = stop("k", { street: "9 Elm Ave", city: "Newark" });
    const none = stop("n");
    const geocoded = new Map([[geocodeCacheKey("9 Elm Ave, Newark"), null]]);
    expect(unresolvedQueries([a, dup, known, none], geocoded)).toEqual(["12 Main St, Newark"]);
  });
});
