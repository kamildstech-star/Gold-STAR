import { describe, expect, it } from "vitest";

import { canManageTradeshows, canSeeMoney, type AppRole } from "@/lib/roles";

/* Melly (29 Oct): returns and spend on Tradeshows, and revenue on the
   Leaderboard, are for department heads, admins and executives. Reps see
   points and activity. */
const REPS: AppRole[] = [
  "sales_person",
  "outside_sales_rep",
  "sales_rep",
  "cold_caller",
  "field_chaser",
  "crew",
];
const LEADERS: AppRole[] = [
  "owner",
  "admin",
  "dev",
  "regional",
  "location_manager",
  "sales_head",
  "sales_manager",
];

describe("canManageTradeshows", () => {
  it.each(REPS)("a %s neither manages shows nor sees their money", (role) => {
    expect(canManageTradeshows([role])).toBe(false);
  });
  it.each(LEADERS)("a %s manages shows and sees their money", (role) => {
    expect(canManageTradeshows([role])).toBe(true);
  });
  it("a rep who also holds a leadership role gets the leadership view", () => {
    expect(canManageTradeshows(["sales_person", "sales_manager"])).toBe(true);
  });
  it("nobody with no roles", () => {
    expect(canManageTradeshows([])).toBe(false);
  });
});

describe("canSeeMoney", () => {
  it.each(REPS)("a %s never sees money", (role) => {
    expect(canSeeMoney([role])).toBe(false);
  });
  it.each(LEADERS)("a %s sees money", (role) => {
    expect(canSeeMoney([role])).toBe(true);
  });
});
