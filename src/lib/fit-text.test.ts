import { describe, expect, it } from "vitest";

import { FIT_FLOOR, fitScale, overflowsAtFloor } from "./fit-text";

/**
 * Mark: "we need the words to be auto resizing so there are no ... anywhere"
 *
 * The component around this is DOM-bound; the decision is not. These pin the
 * three behaviours that matter: text that fits is not touched, text that
 * overflows shrinks by exactly the ratio, and nothing shrinks past the floor.
 */
describe("fitScale", () => {
  it("leaves text that fits at exactly 1", () => {
    // "29" in a 122px tile. Nothing that was fine before may change.
    expect(fitScale(40, 122)).toBe(1);
    expect(fitScale(122, 122)).toBe(1);
  });

  it("treats half a pixel over as fitting", () => {
    // ResizeObserver widths are fractional; a 0.3px overshoot is rounding.
    expect(fitScale(122.3, 122)).toBe(1);
  });

  it("scales by the ratio when the text overflows", () => {
    // 20% too wide → 1/1.2.
    expect(fitScale(120, 100)).toBeCloseTo(0.833, 3);
    // "$394,821" measured 144px in a 122px tile.
    expect(fitScale(144, 122)).toBeCloseTo(0.847, 3);
  });

  it("floors, never rounds up, so the result is never half a pixel too wide", () => {
    // 100/120 = 0.8333…; 0.834 would put 120 * 0.834 = 100.08px into 100px.
    expect(fitScale(120, 100)).toBe(0.833);
  });

  it("clamps at the floor", () => {
    // Ten times too wide would be 0.1; the floor holds it at half.
    expect(fitScale(1000, 100)).toBe(FIT_FLOOR);
    expect(fitScale(1000, 100, 0.4)).toBe(0.4);
  });

  it("does not shrink an unmeasured box", () => {
    // A tile on a hidden tab reports 0 wide; shrinking to fit 0 is nonsense.
    expect(fitScale(144, 0)).toBe(1);
    expect(fitScale(0, 122)).toBe(1);
    expect(fitScale(Number.NaN, 122)).toBe(1);
  });

  it("keeps the floor inside 0–1", () => {
    expect(fitScale(120, 100, 5)).toBe(1);
    expect(fitScale(1000, 100, -1)).toBe(0.1);
  });
});

describe("overflowsAtFloor", () => {
  it("is false while the floor still fits", () => {
    expect(overflowsAtFloor(144, 122)).toBe(false);
    expect(overflowsAtFloor(200, 100)).toBe(false);
  });

  it("is true once even the floor spills, which is when the text wraps instead", () => {
    expect(overflowsAtFloor(202, 100)).toBe(true);
    expect(overflowsAtFloor(1000, 100)).toBe(true);
  });

  it("never asks an unmeasured box to wrap", () => {
    expect(overflowsAtFloor(1000, 0)).toBe(false);
  });
});
