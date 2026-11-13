import { describe, expect, it } from "vitest";

import { derive, dewPointF, grainsPerPound, isUsableReading } from "@/lib/psychrometrics";

/**
 * Dew point and grains per pound are the numbers an insurance carrier disputes
 * when it decides whether to pay for a week of dehumidifier rental. They are
 * derived, never typed, so this file is the only thing standing between a
 * transposed constant and a drying log that argues the wrong case.
 *
 * Expected values are from published psychrometric tables, not from a previous
 * run of this code — a golden-file test of your own output proves nothing.
 */

/** Dew point, °F, from standard temperature/RH dew point tables. */
const DEW_POINT_TABLE: [tempF: number, rh: number, expected: number][] = [
  [70, 50, 50.5],
  [80, 60, 65],
  [90, 60, 74],
  [60, 60, 46],
  [32, 80, 26.5],
  [85, 90, 82],
];

/** Humidity ratio, grains per pound of dry air, at standard sea-level pressure. */
const GPP_TABLE: [tempF: number, rh: number, expected: number][] = [
  [70, 50, 54.5],
  [80, 60, 92],
  [90, 60, 128],
  [60, 60, 46],
];

describe("dew point", () => {
  it.each(DEW_POINT_TABLE)("is %i °F / %i%% RH -> %f °F", (tempF, rh, expected) => {
    expect(dewPointF(tempF, rh)).toBeCloseTo(expected, 0);
  });

  it("equals the dry-bulb temperature at saturation", () => {
    // The one exact identity in the Magnus form: at 100% RH the log term is
    // zero and the whole expression collapses to T. A constant typed wrongly
    // breaks this before it breaks anything a table would catch.
    for (const tempF of [-4, 32, 55.5, 73.4, 110]) {
      expect(dewPointF(tempF, 100)).toBeCloseTo(tempF, 6);
    }
  });

  it("never exceeds the dry-bulb temperature", () => {
    for (const tempF of [35, 60, 75, 95]) {
      for (const rh of [5, 25, 50, 75, 99]) {
        expect(dewPointF(tempF, rh)!).toBeLessThan(tempF);
      }
    }
  });

  it("rises with humidity at a fixed temperature", () => {
    const climb = [10, 30, 50, 70, 90].map((rh) => dewPointF(75, rh)!);
    expect(climb).toEqual([...climb].sort((a, b) => a - b));
  });
});

describe("grains per pound", () => {
  it.each(GPP_TABLE)("is %i °F / %i%% RH -> %f gr/lb", (tempF, rh, expected) => {
    expect(grainsPerPound(tempF, rh)).toBeCloseTo(expected, 0);
  });

  it("shows why relative humidity alone documents nothing", () => {
    // The whole argument for logging dew point: the same 60% RH is nearly
    // three times the water at 90 °F that it is at 60 °F.
    const hot = grainsPerPound(90, 60)!;
    const cold = grainsPerPound(60, 60)!;
    expect(hot / cold).toBeGreaterThan(2.5);
  });

  it("is a function of dew point alone, whatever the dry bulb", () => {
    // Two readings with the same dew point hold the same water. This is what
    // makes an affected room's dew point converging on the unaffected room's
    // the proof that drying is progressing.
    const a = grainsPerPound(80, 41.4)!; // dew point ~= 54.5 °F
    const b = grainsPerPound(65, 68.7)!; // dew point ~= 54.5 °F
    expect(dewPointF(80, 41.4)).toBeCloseTo(dewPointF(65, 68.7)!, 2);
    expect(a).toBeCloseTo(b, 1);
  });
});

describe("unusable readings", () => {
  it("rejects a missing, zero or impossible humidity rather than inventing one", () => {
    expect(isUsableReading(70, null)).toBe(false);
    expect(dewPointF(70, null)).toBeNull();
    expect(dewPointF(null, 50)).toBeNull();
    // ln(0) is -Infinity; a meter never reads a true zero, so this is bad input.
    expect(dewPointF(70, 0)).toBeNull();
    expect(dewPointF(70, 101)).toBeNull();
    expect(grainsPerPound(70, 0)).toBeNull();
    expect(dewPointF(Number.NaN, 50)).toBeNull();
  });
});

describe("derive", () => {
  it("rounds to the tenth both figures are recorded at", () => {
    expect(derive(70, 50)).toEqual({ dewPointF: 50.5, gpp: 54.4 });
    expect(derive(70, null)).toEqual({ dewPointF: null, gpp: null });
  });
});
