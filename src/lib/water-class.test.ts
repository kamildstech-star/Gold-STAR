import { describe, expect, it } from "vitest";

import {
  WATER_CLASSES,
  describeWaterClass,
  needsSpecialtyDrying,
  parseWaterClass,
  waterClassInfo,
} from "./water-class";

describe("water class", () => {
  it("has exactly S500's four classes, in order", () => {
    expect(WATER_CLASSES.map((c) => c.value)).toEqual([1, 2, 3, 4]);
  });

  it("labels class 1 as the low-evaporation class and class 4 as bound water", () => {
    expect(waterClassInfo(1)!.name).toMatch(/slow evaporation/i);
    expect(waterClassInfo(4)!.name).toMatch(/specialty/i);
    expect(waterClassInfo(4)!.name).toMatch(/bound water/i);
  });

  it("reads numbers and the strings a Select hands back", () => {
    expect(parseWaterClass(2)).toBe(2);
    expect(parseWaterClass("3")).toBe(3);
    expect(parseWaterClass(" 4 ")).toBe(4);
  });

  it("never guesses: anything outside 1–4 is unset, not class 1", () => {
    for (const v of [null, undefined, "", 0, 5, 2.5, "two", Number.NaN]) {
      expect(parseWaterClass(v)).toBeNull();
    }
    expect(describeWaterClass(null)).toBe("No water class set");
  });

  it("describes a class the way it prints", () => {
    expect(describeWaterClass(2)).toBe("Class 2 — significant water — fast evaporation");
  });

  it("flags only class 4 as specialty drying", () => {
    expect([1, 2, 3, 4, null].map(needsSpecialtyDrying)).toEqual([
      false,
      false,
      false,
      true,
      false,
    ]);
  });
});
