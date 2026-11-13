import { describe, expect, it } from "vitest";

import {
  WATER_CATEGORIES,
  describeWaterCategory,
  isGrosslyContaminated,
  parseWaterCategory,
  waterCategoryInfo,
} from "@/lib/water-category";

describe("the water category", () => {
  it("keeps the three the trade uses, in order", () => {
    expect(WATER_CATEGORIES.map((c) => c.value)).toEqual([1, 2, 3]);
    expect(WATER_CATEGORIES.map((c) => c.name)).toEqual(["Clean", "Gray", "Black"]);
  });

  it("reads a number from the database and a string from a picker", () => {
    expect(parseWaterCategory(2)).toBe(2);
    expect(parseWaterCategory("2")).toBe(2);
    expect(parseWaterCategory(" 3 ")).toBe(3);
  });

  it("reads an unset category as unset, never as clean", () => {
    // Defaulting to 1 is the bug that tells a crew sewage can be dried in place.
    for (const v of [null, undefined, "", "none", 0, 4, -1, Number.NaN, "cat 2", {}]) {
      expect(parseWaterCategory(v)).toBeNull();
    }
  });

  it("describes what it has, and says plainly when it has nothing", () => {
    expect(describeWaterCategory(1)).toBe("Category 1 — clean");
    expect(describeWaterCategory(3)).toBe("Category 3 — black");
    expect(describeWaterCategory(null)).toBe("No water category set");
  });

  it("flags category 3 and nothing else", () => {
    expect(isGrosslyContaminated(3)).toBe(true);
    expect(isGrosslyContaminated("3")).toBe(true);
    expect(isGrosslyContaminated(2)).toBe(false);
    expect(isGrosslyContaminated(null)).toBe(false);
  });

  it("hands back the row behind a value, or null", () => {
    expect(waterCategoryInfo(2)?.name).toBe("Gray");
    expect(waterCategoryInfo(9)).toBeNull();
  });
});
