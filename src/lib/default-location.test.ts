import { describe, expect, it } from "vitest";

import { orderPrimaryFirst, resolveDefaultLocationId } from "./default-location";

const BALTIMORE = "loc-baltimore";
const JERSEY = "loc-jersey";
const CALIFORNIA = "loc-california";

describe("resolveDefaultLocationId", () => {
  it("returns null when the user can write nowhere", () => {
    expect(
      resolveDefaultLocationId({
        writableIds: [],
        primaryLocationId: JERSEY,
        membershipIds: [JERSEY],
      }),
    ).toBeNull();
  });

  it("prefers the primary office over the alphabetically-first membership", () => {
    // The bug the client hit: Baltimore sorts before Jersey.
    expect(
      resolveDefaultLocationId({
        writableIds: [BALTIMORE, JERSEY],
        primaryLocationId: JERSEY,
        membershipIds: [BALTIMORE, JERSEY],
      }),
    ).toBe(JERSEY);
  });

  it("lets the sidebar context switcher override the primary", () => {
    expect(
      resolveDefaultLocationId({
        writableIds: [BALTIMORE, JERSEY],
        currentLocationId: BALTIMORE,
        primaryLocationId: JERSEY,
        membershipIds: [BALTIMORE, JERSEY],
      }),
    ).toBe(BALTIMORE);
  });

  it("ignores a context switcher or primary the user cannot write to", () => {
    expect(
      resolveDefaultLocationId({
        writableIds: [BALTIMORE],
        currentLocationId: CALIFORNIA,
        primaryLocationId: JERSEY,
        membershipIds: [BALTIMORE],
      }),
    ).toBe(BALTIMORE);
  });

  it("falls back to a direct membership before the first offered office", () => {
    // A regional member sees California through the region, but is a direct
    // member of Jersey only.
    expect(
      resolveDefaultLocationId({
        writableIds: [CALIFORNIA, JERSEY],
        primaryLocationId: null,
        membershipIds: [JERSEY],
      }),
    ).toBe(JERSEY);
  });

  it("falls back to the first offered office with no primary or membership", () => {
    expect(resolveDefaultLocationId({ writableIds: [CALIFORNIA, JERSEY] })).toBe(CALIFORNIA);
  });
});

describe("orderPrimaryFirst", () => {
  const list = [{ id: BALTIMORE }, { id: CALIFORNIA }, { id: JERSEY }];

  it("moves the primary to the top and keeps the rest in order", () => {
    expect(orderPrimaryFirst(list, JERSEY).map((l) => l.id)).toEqual([
      JERSEY,
      BALTIMORE,
      CALIFORNIA,
    ]);
  });

  it("leaves the order alone when there is no primary or it is not offered", () => {
    expect(orderPrimaryFirst(list, null).map((l) => l.id)).toEqual([BALTIMORE, CALIFORNIA, JERSEY]);
    expect(orderPrimaryFirst(list, "loc-elsewhere").map((l) => l.id)).toEqual([
      BALTIMORE,
      CALIFORNIA,
      JERSEY,
    ]);
  });

  it("does not mutate the input", () => {
    const copy = [...list];
    orderPrimaryFirst(list, JERSEY);
    expect(list).toEqual(copy);
  });
});
