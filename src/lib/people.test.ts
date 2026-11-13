import { describe, expect, it } from "vitest";

import { countStages, personStage, roleTitle, timeAtGoldStar, type PeopleStage } from "./people";

/**
 * Melly's People tab: stages Interviewing, Onboarding, Active, Offboarding,
 * Former. Most are derived from records the app already keeps, so the page
 * cannot disagree with the lockout or the offboarding checklist.
 */
describe("personStage", () => {
  const base = {
    isActive: true,
    approvalStatus: "approved",
    storedStage: null,
    openOffboarding: false,
  };

  it("an approved, active person is Active", () => {
    expect(personStage(base)).toBe("active");
  });
  it("an open offboarding checklist wins over everything", () => {
    expect(personStage({ ...base, openOffboarding: true, storedStage: "onboarding" })).toBe(
      "offboarding",
    );
    expect(personStage({ ...base, openOffboarding: true, isActive: false })).toBe("offboarding");
  });
  it("a deactivated profile is Former, whatever was stored", () => {
    expect(personStage({ ...base, isActive: false, storedStage: "interviewing" })).toBe("former");
  });
  it("a manager can mark Interviewing or Onboarding", () => {
    expect(personStage({ ...base, storedStage: "interviewing" })).toBe("interviewing");
    expect(personStage({ ...base, storedStage: "onboarding" })).toBe("onboarding");
  });
  it("a stored Offboarding or Former without the action behind it is ignored", () => {
    expect(personStage({ ...base, storedStage: "former" })).toBe("active");
    expect(personStage({ ...base, storedStage: "offboarding" })).toBe("active");
  });
  it("a signup waiting for approval is Onboarding", () => {
    expect(personStage({ ...base, approvalStatus: "pending" })).toBe("onboarding");
  });
});

describe("countStages", () => {
  it("counts every stage, zero included", () => {
    const people: { stage: PeopleStage }[] = [
      { stage: "active" },
      { stage: "active" },
      { stage: "former" },
      { stage: "offboarding" },
    ];
    expect(countStages(people)).toEqual({
      interviewing: 0,
      onboarding: 0,
      active: 2,
      offboarding: 1,
      former: 1,
    });
  });
});

describe("timeAtGoldStar", () => {
  // Local noon, so the calendar day is 9 Nov in every timezone the suite runs in.
  const NOW = new Date(2026, 10, 9, 12).getTime();
  it("reads in days, months, then years", () => {
    expect(timeAtGoldStar("2026-11-01", NOW)).toBe("8 days");
    expect(timeAtGoldStar("2026-06-01", NOW)).toBe("5 mo");
    expect(timeAtGoldStar("2026-10-09", NOW)).toBe("1 mo");
    expect(timeAtGoldStar("2024-01-15", NOW)).toBe("2 yr 9 mo");
    expect(timeAtGoldStar("2025-11-09", NOW)).toBe("1 yr");
  });
  it("says when a start date is still ahead, and dashes nothing", () => {
    expect(timeAtGoldStar("2026-11-13", NOW)).toBe("Starts in 4 days");
    expect(timeAtGoldStar(null, NOW)).toBe("—");
  });
});

describe("roleTitle", () => {
  it("names the most senior role", () => {
    expect(roleTitle(["sales_person", "sales_head"])).toBe(roleTitle(["sales_head"]));
    expect(roleTitle([])).toBe("No role");
  });
});
