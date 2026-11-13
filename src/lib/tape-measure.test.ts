import { describe, expect, it } from "vitest";

import { formatFeet, formatInches, parseFeet, parseInches } from "./tape-measure";

describe("parseFeet — a room length as a crew types it", () => {
  it.each([
    ["12.5", 12.5],
    ["12", 12],
    [".5", 0.5],
    ["12'6\"", 12.5],
    ["12'6", 12.5],
    ["12' 6\"", 12.5],
    ["12-6", 12.5],
    ["12 - 6", 12.5],
    ["12 6", 12.5],
    ["12ft 6in", 12.5],
    ["12 ft 6 in", 12.5],
    ["12 feet 6 inches", 12.5],
    ["12'", 12],
    ["12' 0\"", 12],
    ['150"', 12.5],
    ["150 in", 12.5],
    ["  10'  ", 10],
  ])("reads %j as %s ft", (input, feet) => {
    expect(parseFeet(input)).toBe(feet);
  });

  it("reads the marks a phone keyboard substitutes", () => {
    expect(parseFeet("12′6″")).toBe(12.5);
    expect(parseFeet("12’6”")).toBe(12.5);
    // Two apostrophes for an inch mark, as people type on a keyboard without "
    expect(parseFeet("12'6''")).toBe(12.5);
  });

  it("reads fractions of an inch off the tape", () => {
    expect(parseFeet("12' 6 1/2\"")).toBeCloseTo(12 + 6.5 / 12, 4);
    expect(parseFeet("12 6 1/2")).toBeCloseTo(12 + 6.5 / 12, 4);
    expect(parseFeet("12-6-1/2")).toBeCloseTo(12 + 6.5 / 12, 4);
    expect(parseFeet("12'6½\"")).toBeCloseTo(12 + 6.5 / 12, 4);
    expect(parseFeet('6 1/2"')).toBeCloseTo(6.5 / 12, 4);
  });

  it("reads a whole and a fraction with no marks as feet, the way it is said aloud", () => {
    expect(parseFeet("12 1/2")).toBe(12.5);
    expect(parseFeet("9-3/4")).toBe(9.75);
  });

  it("refuses 12 or more inches after a feet figure — that is a typo, not a length", () => {
    expect(parseFeet("12 66")).toBeNull();
    expect(parseFeet("12'12\"")).toBeNull();
    expect(parseFeet("12 11")).toBeCloseTo(12 + 11 / 12, 4);
  });

  it("says it could not read anything else rather than guessing", () => {
    for (const bad of ["abc", "12'6'7", "-3", "12/0", "1 2 3", "12..5", "'6"]) {
      expect(parseFeet(bad), bad).toBeNull();
    }
  });

  it("treats an empty box as no value", () => {
    expect(parseFeet("")).toBeNull();
    expect(parseFeet("   ")).toBeNull();
  });
});

describe("parseInches — a door or window width", () => {
  it.each([
    ["32", 32],
    ['32"', 32],
    ["32 in", 32],
    ["30 1/2", 30.5],
    ["30-1/2", 30.5],
    ["30½", 30.5],
    ["2'8\"", 32],
    ["2'8", 32],
    ["2' 8\"", 32],
    ["2-8", 32],
    ["2 8", 32],
    ["3'", 36],
    ["2ft 8in", 32],
  ])("reads %j as %s in", (input, inches) => {
    expect(parseInches(input)).toBe(inches);
  });

  it("refuses what it cannot read", () => {
    for (const bad of ["", "door", "2'14\"", "-30", "30/0"]) {
      expect(parseInches(bad), bad).toBeNull();
    }
  });
});

describe("formatting what was understood", () => {
  it("writes feet and inches back the way a tape reads", () => {
    expect(formatFeet(12.5)).toBe(`12' 6"`);
    expect(formatFeet(10)).toBe(`10'`);
    expect(formatFeet(0.5)).toBe(`6"`);
    expect(formatFeet(12 + 6.5 / 12)).toBe(`12' 6½"`);
    expect(formatFeet(12 + 0.125 / 12)).toBe(`12' ⅛"`);
    // 11' 11.99" rounds up to the next foot, not 11' 12"
    expect(formatFeet(11 + 11.99 / 12)).toBe(`12'`);
    expect(formatFeet(null)).toBe("");
    expect(formatFeet(Number.NaN)).toBe("");
  });

  it("writes inches to the eighth", () => {
    expect(formatInches(32)).toBe(`32"`);
    expect(formatInches(30.5)).toBe(`30½"`);
    expect(formatInches(null)).toBe("");
  });

  it("reads back exactly what it writes", () => {
    for (const ft of [12.5, 10, 0.5, 12 + 6.5 / 12, 7.25, 23 + 11 / 12]) {
      expect(parseFeet(formatFeet(ft))).toBeCloseTo(ft, 3);
    }
    for (const inch of [32, 30.5, 24.125, 80]) {
      expect(parseInches(formatInches(inch))).toBeCloseTo(inch, 3);
    }
  });
});
