import { describe, expect, it } from "vitest";

import {
  ALL_LOCATIONS,
  locationIdOf,
  locationLabel,
  officeLabel,
  officesLabel,
  resolveLocationChoice,
} from "@/lib/report-location";

const NJ = "11111111-1111-1111-1111-111111111111";
const MD = "22222222-2222-2222-2222-222222222222";
const CA = "33333333-3333-3333-3333-333333333333";
const GONE = "99999999-9999-9999-9999-999999999999";
const visibleIds = [NJ, MD, CA];

describe("which office a report opens on", () => {
  it("honors an explicit choice from the URL", () => {
    expect(resolveLocationChoice({ visibleIds, explicit: MD, currentLocationId: NJ })).toBe(MD);
  });

  it("treats an explicit 'all' as a real choice, not a missing one", () => {
    expect(
      resolveLocationChoice({
        visibleIds,
        explicit: ALL_LOCATIONS,
        currentLocationId: NJ,
        primaryLocationId: NJ,
      }),
    ).toBe(ALL_LOCATIONS);
  });

  it("follows the sidebar office over the primary office", () => {
    expect(
      resolveLocationChoice({ visibleIds, currentLocationId: CA, primaryLocationId: NJ }),
    ).toBe(CA);
  });

  it("treats the sidebar sitting on 'All my locations' as a real answer", () => {
    /*
     * This used to resolve to the primary office. The sidebar stores "All my
     * locations" as null, so the screen said "All my locations" while Jobs and
     * the Leaderboard quietly filtered to one office — an admin saw two jobs in
     * a twelve-office workspace. Null is the switcher's answer, not a gap in it.
     */
    expect(
      resolveLocationChoice({ visibleIds, currentLocationId: null, primaryLocationId: NJ }),
    ).toBe(ALL_LOCATIONS);
  });

  it("still falls back to the primary office when no switcher value was supplied", () => {
    // `undefined` is a caller with no notion of the sidebar, which is not the
    // same as a caller reporting that the sidebar is set to "All".
    expect(resolveLocationChoice({ visibleIds, primaryLocationId: NJ })).toBe(NJ);
  });

  it("defaults a single-office user to their own office", () => {
    expect(resolveLocationChoice({ visibleIds, membershipIds: [MD] })).toBe(MD);
  });

  it("does not guess for someone who belongs to several offices", () => {
    expect(resolveLocationChoice({ visibleIds, membershipIds: [NJ, MD] })).toBe(ALL_LOCATIONS);
  });

  it("ignores an office the viewer may no longer see", () => {
    // A stale URL or a revoked membership must not produce an empty report.
    expect(resolveLocationChoice({ visibleIds, explicit: GONE })).toBe(ALL_LOCATIONS);
    expect(
      resolveLocationChoice({ visibleIds, currentLocationId: GONE, primaryLocationId: NJ }),
    ).toBe(NJ);
    expect(resolveLocationChoice({ visibleIds, membershipIds: [GONE] })).toBe(ALL_LOCATIONS);
  });

  it("returns 'all' when the viewer can see nothing", () => {
    expect(resolveLocationChoice({ visibleIds: [], primaryLocationId: NJ })).toBe(ALL_LOCATIONS);
  });
});

describe("turning the choice into a query filter", () => {
  it("leaves the query untouched for 'all' and pins one office otherwise", () => {
    expect(locationIdOf(ALL_LOCATIONS)).toBeNull();
    expect(locationIdOf(NJ)).toBe(NJ);
  });
});

describe("labelling", () => {
  const locations = [
    { id: NJ, code: "GS-NJ", name: "Jersey" },
    { id: MD, code: "MD", name: "MD" },
    { id: CA, code: "NY-UP", name: "NY-Upstate" },
  ];

  /*
   * Mark's screenshot of the office dropdown read "NC · NC, CA · CA, GA · GA"
   * down the list: most offices are named after their code, so printing both
   * said everything twice. The name leads; the code only follows when it adds
   * something.
   */
  it("prints the name alone when the code is the same word", () => {
    expect(officeLabel({ code: "NC", name: "NC" })).toBe("NC");
    expect(officeLabel({ code: "ca", name: "CA" })).toBe("CA");
    expect(officeLabel({ code: " GA ", name: "GA" })).toBe("GA");
  });

  it("appends the code when it differs from the name", () => {
    expect(officeLabel({ code: "NY-UP", name: "NY-Upstate" })).toBe("NY-Upstate · NY-UP");
    expect(officeLabel({ code: "TX", name: "HTX" })).toBe("HTX · TX");
    expect(officeLabel({ code: "GS-NJ", name: "Jersey" })).toBe("Jersey · GS-NJ");
  });

  it("falls back to the code when the name is blank", () => {
    expect(officeLabel({ code: "TX", name: "" })).toBe("TX");
  });

  it("names the office, or says all", () => {
    expect(locationLabel(ALL_LOCATIONS, locations)).toBe("All offices");
    expect(locationLabel(NJ, locations)).toBe("Jersey · GS-NJ");
    expect(locationLabel(MD, locations)).toBe("MD");
    expect(locationLabel(GONE, locations)).toBe("Unknown office");
  });

  it("labels a set of offices: all, one, a few names, or a count", () => {
    expect(officesLabel([], locations)).toBe("All offices");
    expect(officesLabel([NJ], locations)).toBe("Jersey · GS-NJ");
    expect(officesLabel([NJ, MD], locations)).toBe("Jersey, MD");
    expect(officesLabel([NJ, MD, CA], locations)).toBe("Jersey, MD, NY-Upstate");
    expect(officesLabel([GONE], locations)).toBe("Unknown office");
    const many = [NJ, MD, CA, GONE.replace("9", "8")].map((id, i) => ({
      id,
      code: `C${i}`,
      name: `Office ${i}`,
    }));
    expect(
      officesLabel(
        many.map((l) => l.id),
        many,
      ),
    ).toBe("4 offices");
  });
});
