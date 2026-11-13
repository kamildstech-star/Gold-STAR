import { describe, expect, it } from "vitest";

import { percentOf, roundMoney, sumMoney, toCents } from "@/lib/money";

describe("integer cents, half away from zero", () => {
  it("rounds half a cent away from zero, both signs", () => {
    expect(toCents(0.125)).toBe(13);
    expect(toCents(-0.125)).toBe(-13);
    expect(toCents(0.124)).toBe(12);
    expect(toCents(2.675)).toBe(268);
  });

  it("is not fooled by binary floats", () => {
    // Math.round(1.005 * 100) is 100 — a cent short.
    expect(Math.round(1.005 * 100)).toBe(100);
    expect(toCents(1.005)).toBe(101);
    expect(roundMoney(1.005)).toBe(1.01);
    expect(roundMoney(8.875 * 10)).toBe(88.75);
  });

  it("sums cents, not floats", () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(sumMoney([0.1, 0.2])).toBe(0.3);
    expect(sumMoney([21.12, 21.12, 21.12])).toBe(63.36);
  });

  it("takes a percent to the cent", () => {
    expect(percentOf(704, 3)).toBe(21.12);
    expect(percentOf(1234.56, 2.5)).toBe(30.86);
    expect(percentOf(0.5, 1)).toBe(0.01);
  });

  it("refuses what is not a number", () => {
    expect(() => toCents(Number.NaN)).toThrow();
    expect(() => toCents(Infinity)).toThrow();
  });
});
