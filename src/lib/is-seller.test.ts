import { describe, expect, it } from "vitest";

import { SELLING_ROLES, isSeller, type AppRole } from "@/lib/roles";

/**
 * Mark, 2026-09-09, looking at the New customer dialog: "keep this collapsed
 * unless you're a salesman."
 *
 * "Relationship details — what survives a rep change" opened expanded for
 * everyone. Birthdays, gift policy and personal preferences are a seller's
 * working notes; for an office admin typing a name and a phone number they are
 * a wall of fields between the thing they came to do and the Create button.
 *
 * This decides only what the form OPENS with. The section is one click away for
 * anybody and nothing in it is hidden, which is why managers are not counted
 * here: reviewing an account is not building the relationship.
 */
describe("who the relationship section opens for", () => {
  it("opens for the people who sell", () => {
    for (const role of SELLING_ROLES) {
      expect(isSeller([role]), role).toBe(true);
    }
  });

  it("stays shut for everyone else", () => {
    const others: AppRole[] = [
      "owner",
      "admin",
      "dev",
      "regional",
      "location_manager",
      "office",
      "sales_manager",
      "sales_head",
      "field_chaser",
      "field",
      "crew",
    ];
    for (const role of others) {
      expect(isSeller([role]), role).toBe(false);
    }
  });

  it("opens for someone who sells among other roles", () => {
    // Roles stack. Holding one selling role is enough.
    expect(isSeller(["office", "sales_rep"])).toBe(true);
    expect(isSeller(["sales_head", "outside_sales_rep"])).toBe(true);
  });

  it("stays shut for somebody with no role at all", () => {
    expect(isSeller([])).toBe(false);
  });

  it("counts a cold caller, who is gathering exactly these details", () => {
    expect(isSeller(["cold_caller"])).toBe(true);
  });
});
