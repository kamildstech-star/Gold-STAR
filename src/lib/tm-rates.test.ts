import { describe, expect, it } from "vitest";

import type { MoneyValueRow } from "@/lib/office-values";
import {
  EMPTY_RATES_DRAFT,
  cellFor,
  cellKey,
  completeness,
  marginPercent,
  ratesDraftToChanges,
  validateRatesDraft,
  type RateItem,
} from "@/lib/tm-rates";

const NJ = "nj";
const NC = "nc";
const TODAY = "2026-10-30";
const r = (
  item_key: string,
  office_id: string | null,
  effective_from: string,
  value: number | null,
): MoneyValueRow => ({
  book: "tm_rates",
  item_key,
  measure: "bill_rate",
  office_id,
  effective_from,
  value,
});
const ROWS = [
  r("GL", null, "2000-01-01", 70),
  r("GL", NJ, "2026-06-01", 65),
  r("SCL", null, "2000-01-01", 88),
  r("SCL", NJ, "2026-03-01", 90),
  r("SCL", NJ, "2026-09-01", null), // NJ reset to default
  r("SCL", null, "2026-10-01", 92), // newer default
  r("CCF", NJ, "2026-01-01", 98), // NJ only; no default
];
const item = (
  key: string,
  category: RateItem["category"] = "labor",
  over: Partial<RateItem> = {},
): RateItem => ({
  key,
  code: key,
  name: key,
  category,
  unitLabel: "per hour",
  active: true,
  archived: false,
  ...over,
});

describe("a cell, office by office", () => {
  it("an office inherits the default, greyed as 'from default'", () => {
    expect(cellFor(ROWS, EMPTY_RATES_DRAFT, "GL", NC, TODAY)).toMatchObject({
      value: 70,
      source: "default",
      overridden: false,
    });
  });

  it("an override is the office's own, and says when the default is newer", () => {
    expect(cellFor(ROWS, EMPTY_RATES_DRAFT, "GL", NJ, TODAY)).toMatchObject({
      value: 65,
      source: "office",
      overridden: true,
      olderThanDefault: false,
    });
    const older = [...ROWS, r("GL", null, "2026-08-01", 72)];
    expect(cellFor(older, EMPTY_RATES_DRAFT, "GL", NJ, TODAY).olderThanDefault).toBe(true);
  });

  it("a reset office reads the default again", () => {
    expect(cellFor(ROWS, EMPTY_RATES_DRAFT, "SCL", NJ, TODAY)).toMatchObject({
      value: 92,
      source: "default",
      overridden: false,
    });
  });

  it("an item priced only at one office is a gap everywhere else", () => {
    expect(cellFor(ROWS, EMPTY_RATES_DRAFT, "CCF", NC, TODAY)).toMatchObject({
      value: null,
      source: "none",
    });
    expect(cellFor(ROWS, EMPTY_RATES_DRAFT, "CCF", null, TODAY).source).toBe("none");
  });

  it("the draft shows through: a typed override, a reset, a new default", () => {
    const d = {
      cells: {
        [cellKey("GL", NC)]: { value: "68" },
        [cellKey("GL", NJ)]: { reset: true as const },
        [cellKey("SCL", null)]: { value: "95.5" },
      },
      smallTools: {},
    };
    expect(cellFor(ROWS, d, "GL", NC, TODAY)).toMatchObject({
      value: 68,
      source: "office",
      edited: true,
    });
    expect(cellFor(ROWS, d, "GL", NJ, TODAY)).toMatchObject({
      value: 70,
      source: "default",
      edited: true,
    });
    expect(cellFor(ROWS, d, "SCL", NC, TODAY)).toMatchObject({ value: 95.5, source: "default" });
  });
});

describe("checks", () => {
  it("refuses a blank default and sub-cent values, in plain words", () => {
    const p = validateRatesDraft({
      cells: {
        [cellKey("GL", null)]: { value: "" },
        [cellKey("SCL", NJ)]: { value: "88.125" },
        [cellKey("CCF", NC)]: { value: "abc" },
      },
      smallTools: {},
    });
    expect(p.get(cellKey("GL", null))).toMatch(/company default needs a rate/);
    expect(p.get(cellKey("SCL", NJ))).toMatch(/Dollars and cents/);
    expect(p.get(cellKey("CCF", NC))).toMatch(/Dollars and cents/);
  });
});

describe("completeness", () => {
  const items = [
    item("GL"),
    item("SCL"),
    item("CCF"),
    item("OLD", "labor", { archived: true }),
    item("100", "consumable"),
  ];
  it("counts live items with no rate, per office and category", () => {
    const nc = completeness(items, ROWS, EMPTY_RATES_DRAFT, NC, TODAY);
    expect(nc).toMatchObject({ total: 4, priced: 2, missing: ["CCF", "100"], overrides: 0 });
    expect(nc.byCategory.labor).toEqual({ total: 3, missing: 1 });
    expect(nc.byCategory.consumable).toEqual({ total: 1, missing: 1 });
    const nj = completeness(items, ROWS, EMPTY_RATES_DRAFT, NJ, TODAY);
    expect(nj).toMatchObject({ priced: 3, missing: ["100"], overrides: 2 });
  });
});

describe("the save", () => {
  it("sends each cell once, copies to chosen offices, resets overrides on request", () => {
    const d = {
      cells: {
        [cellKey("GL", NC)]: { value: "68" },
        [cellKey("GL", null)]: { value: "71" },
        [cellKey("SCL", NJ)]: { reset: true as const },
      },
      smallTools: { GL: false },
    };
    expect(
      ratesDraftToChanges(d, ROWS, {
        effectiveFrom: TODAY,
        alsoOffices: [NJ],
        resetOverrides: true,
      }),
    ).toEqual([
      { op: "rate", item_key: "GL", office_id: null, value: 71, effective_from: TODAY },
      { op: "rate", item_key: "GL", office_id: NJ, value: null, effective_from: TODAY },
      { op: "rate", item_key: "GL", office_id: NC, value: 68, effective_from: TODAY },
      { op: "rate", item_key: "SCL", office_id: NJ, value: null, effective_from: TODAY },
      { op: "small_tools", code: "GL", on: false },
    ]);
  });
});

describe("margin", () => {
  it("is (rate − cost) / rate to one decimal", () => {
    expect(marginPercent(88, 52.8)).toBe(40);
    expect(marginPercent(70, 45)).toBe(35.7);
    expect(marginPercent(70, null)).toBeNull();
    expect(marginPercent(0, 10)).toBeNull();
  });
});
