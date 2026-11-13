import { describe, expect, it } from "vitest";

import { positionFromTitle } from "@/lib/company-hierarchy";

/**
 * Mark, 2026-09-09: "this should be on creating the contact and it needs to be
 * smart from the title."
 *
 * Position was only settable afterwards, on the hierarchy panel, so in practice
 * almost nobody set one: 26 of 87 contacts had a position and not a single one
 * had a manager, which is exactly why the org chart draws a flat list.
 *
 * These are the same rules, in the same order, as the backfill in migration
 * 20260903090000. Two different answers for one title would be worse than no
 * guess, so the order is part of the contract and is tested as such.
 */
describe("guessing a position from a job title", () => {
  it("reads the titles the trade actually uses", () => {
    expect(positionFromTitle("Owner")).toBe("owner_ceo");
    expect(positionFromTitle("CEO")).toBe("owner_ceo");
    expect(positionFromTitle("Chief Executive Officer")).toBe("owner_ceo");
    expect(positionFromTitle("Regional Manager")).toBe("regional");
    expect(positionFromTitle("District Manager")).toBe("regional");
    expect(positionFromTitle("Asset Manager")).toBe("asset_manager");
    expect(positionFromTitle("Building Superintendent")).toBe("building_super");
    expect(positionFromTitle("Resident manager")).toBe("building_super");
    expect(positionFromTitle("Accounts Payable")).toBe("billing");
    expect(positionFromTitle("Controller")).toBe("billing");
    expect(positionFromTitle("Maintenance Tech")).toBe("maintenance");
    expect(positionFromTitle("Facilities director")).toBe("maintenance");
  });

  it("keeps the backfill's order where a title could be read two ways", () => {
    // Billing wins: who pays the invoice is the more useful thing to know.
    expect(positionFromTitle("Regional Billing Manager")).toBe("billing");
    // Super beats asset: the person on site is who gets called at 2am.
    expect(positionFromTitle("Asset superintendent")).toBe("building_super");
  });

  it("does not mistake a supervisor for a building super", () => {
    // Without a word boundary "super" matches inside "supervisor", which would
    // put a maintenance supervisor in charge of the building.
    expect(positionFromTitle("Maintenance Supervisor")).toBe("maintenance");
    expect(positionFromTitle("Supervisor")).toBeNull();
  });

  it("says nothing rather than guessing", () => {
    expect(positionFromTitle("")).toBeNull();
    expect(positionFromTitle("   ")).toBeNull();
    expect(positionFromTitle(null)).toBeNull();
    expect(positionFromTitle(undefined)).toBeNull();
    // A real title it has no rule for. "No position" is honest; a wrong guess
    // sends the 2am call to the wrong person.
    expect(positionFromTitle("Leasing consultant")).toBeNull();
  });

  it("ignores case and surrounding words", () => {
    expect(positionFromTitle("  senior REGIONAL manager, east  ")).toBe("regional");
    expect(positionFromTitle("co-owner")).toBe("owner_ceo");
  });
});
