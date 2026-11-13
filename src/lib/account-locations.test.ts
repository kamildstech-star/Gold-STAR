import { describe, expect, it } from "vitest";

import {
  accountMatchesOffices,
  diffLocationRows,
  footprintLabel,
  isNational,
  servingLocationIds,
} from "./account-locations";

const NJ = "loc-nj";
const NY = "loc-ny";
const CA = "loc-ca";
const ALL = [NJ, NY, CA];

describe("servingLocationIds", () => {
  it("is the owner alone for a single-office account, whatever was ticked", () => {
    expect(servingLocationIds(NJ, [NY, CA], false)).toEqual([NJ]);
  });

  it("adds the extra offices when multi-location, without duplicating the owner", () => {
    expect(servingLocationIds(NJ, [NJ, CA, CA], true)).toEqual([NJ, CA]);
  });

  it("drops blank ids", () => {
    expect(servingLocationIds(NJ, ["", NY], true)).toEqual([NJ, NY]);
  });
});

describe("isNational / footprintLabel", () => {
  it("is national only when every office serves the account", () => {
    expect(isNational([NJ, NY, CA], ALL)).toBe(true);
    expect(isNational([NJ, NY], ALL)).toBe(false);
    expect(isNational([NJ, NY, CA], [])).toBe(false);
  });

  it("labels single, multi and national", () => {
    expect(
      footprintLabel({ isMultiLocation: false, servingIds: [NJ, NY, CA], allOfficeIds: ALL }),
    ).toBe("Single office");
    expect(footprintLabel({ isMultiLocation: true, servingIds: [NJ, NY], allOfficeIds: ALL })).toBe(
      "Multi-location · 2 offices",
    );
    expect(
      footprintLabel({ isMultiLocation: true, servingIds: [NJ, NY, CA], allOfficeIds: ALL }),
    ).toBe("National");
    expect(footprintLabel({ isMultiLocation: true, servingIds: [NJ], allOfficeIds: ALL })).toBe(
      "Multi-location",
    );
  });
});

describe("accountMatchesOffices", () => {
  it("matches everything on an empty filter", () => {
    expect(accountMatchesOffices(NJ, [NJ], [])).toBe(true);
    expect(accountMatchesOffices(null, undefined, [])).toBe(true);
  });

  it("matches on the owning office", () => {
    expect(accountMatchesOffices(NJ, undefined, [NJ])).toBe(true);
    expect(accountMatchesOffices(NJ, undefined, [CA])).toBe(false);
  });

  it("matches on a serving office — a Jersey company worked by California is on the California list", () => {
    expect(accountMatchesOffices(NJ, [NJ, CA], [CA])).toBe(true);
    expect(accountMatchesOffices(NJ, [NJ, CA], [NY])).toBe(false);
  });
});

describe("diffLocationRows", () => {
  it("computes inserts and deletes", () => {
    expect(diffLocationRows([NJ, NY], [NJ, CA])).toEqual({ toAdd: [CA], toRemove: [NY] });
  });

  it("is a no-op when nothing changed", () => {
    expect(diffLocationRows([NJ, NY], [NY, NJ])).toEqual({ toAdd: [], toRemove: [] });
  });
});
