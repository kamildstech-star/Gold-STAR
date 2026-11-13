import { describe, expect, it } from "vitest";

import type { MoneyValueRow } from "@/lib/office-values";
import {
  compareEngine,
  engineAt,
  engineDraftToChanges,
  engineTimeline,
  explainCompare,
  perHour,
  typedAmount,
  type OverheadComponent,
  type OverheadUnit,
} from "@/lib/overhead";

/*
 * The overhead engine's composition math, to the cent. Wage, General
 * liability and Workers' comp are dollars per field-labor hour; their sum is
 * the true cost of one. Every figure is worked in the comment beside it.
 */
const NY = "ny";
const comp = (key: string, name: string, sort: number, over: Partial<OverheadComponent> = {}) => ({
  key,
  name,
  note: null,
  system: true,
  sort_order: sort,
  archived_at: null,
  ...over,
});
const COMPONENTS: OverheadComponent[] = [
  comp("wage", "Wage", 10),
  comp("general_liability", "General liability", 20),
  comp("workers_comp", "Workers' comp", 30),
];
const r = (
  item_key: string,
  office_id: string | null,
  effective_from: string,
  value: number | null,
): MoneyValueRow => ({
  book: "overhead",
  item_key,
  measure: "cost_hr",
  office_id,
  effective_from,
  value,
});
const ROWS = [
  r("wage", null, "2020-01-01", 45),
  r("general_liability", null, "2026-03-01", 3),
  r("wage", null, "2026-06-01", 46),
  r("wage", NY, "2026-05-01", 50),
];

describe("composition", () => {
  it("sums the parts into the cost of a field hour, naming the empty ones", () => {
    const e = engineAt(ROWS, COMPONENTS, null, "2026-10-29");
    // 46 + 3 = 49.00; Workers' comp has no value yet
    expect(e.total).toBe(49);
    expect(e.missing).toEqual(["Workers' comp"]);
    expect(e.parts.map((p) => [p.key, p.value, p.source])).toEqual([
      ["wage", 46, "default"],
      ["general_liability", 3, "default"],
      ["workers_comp", null, "none"],
    ]);
  });

  it("an office's own value wins only for its own part", () => {
    // NY: its own 50 wage + the default 3 GL = 53.00
    expect(engineAt(ROWS, COMPONENTS, NY, "2026-10-29").total).toBe(53);
    expect(engineAt(ROWS, COMPONENTS, NY, "2026-04-01").total).toBe(48);
  });

  it("adds in whole cents, never floating point", () => {
    const rows = [
      r("wage", null, "2026-01-01", 17.1),
      r("general_liability", null, "2026-01-01", 3.35),
      r("workers_comp", null, "2026-01-01", 1.15),
    ];
    // 17.10 + 3.35 + 1.15 = 21.60 (a float sum gives 21.6000000000000014)
    expect(engineAt(rows, COMPONENTS, null, "2026-02-01").total).toBe(21.6);
  });

  it("an archived component stops counting from its archive day, never before", () => {
    const comps = [
      ...COMPONENTS,
      comp("c_truck", "Truck", 40, { system: false, archived_at: "2026-09-15T14:00:00Z" }),
    ];
    const rows = [...ROWS, r("c_truck", null, "2026-07-01", 2)];
    expect(engineAt(rows, comps, null, "2026-09-14").total).toBe(51);
    expect(engineAt(rows, comps, null, "2026-09-15").total).toBe(49);
  });
});

describe("year over year", () => {
  it("lists each day the cost moved and why", () => {
    const t = engineTimeline(ROWS, COMPONENTS, null);
    expect(t.map((p) => [p.date, p.total])).toEqual([
      ["2020-01-01", 45],
      ["2026-03-01", 48],
      ["2026-06-01", 49],
    ]);
    expect(t[1]!.changes).toEqual([
      { key: "general_liability", name: "General liability", from: null, to: 3, delta: 3 },
    ]);
    // NY's own wage change is not a default-timeline point.
    expect(t.some((p) => p.date === "2026-05-01")).toBe(false);
    expect(engineTimeline(ROWS, COMPONENTS, NY).map((p) => [p.date, p.total])).toEqual([
      ["2020-01-01", 45],
      ["2026-03-01", 48],
      ["2026-05-01", 53],
    ]);
  });

  it("explains any two dates in one line", () => {
    const c = compareEngine(ROWS, COMPONENTS, null, "2026-01-01", "2026-10-29");
    expect(c).toMatchObject({ from: { total: 45 }, to: { total: 49 }, delta: 4 });
    expect(explainCompare(c)).toBe("Why $45→$49: General liability +$3 (Mar), Wage +$1 (Jun)");
    expect(explainCompare(compareEngine(ROWS, COMPONENTS, null, "2026-10-29", "2026-01-01"))).toBe(
      "Why $45→$49: General liability +$3 (Mar), Wage +$1 (Jun)",
    );
    expect(explainCompare(compareEngine(ROWS, COMPONENTS, null, "2026-07-01", "2026-08-01"))).toBe(
      "Why $49→$49: nothing changed",
    );
    const across = compareEngine(ROWS, COMPONENTS, null, "2025-12-01", "2026-04-01");
    expect(explainCompare(across)).toBe("Why $45→$48: General liability +$3 (Mar 2026)");
  });
});

describe("the save", () => {
  it("sends one value per component and scope; reset is null", () => {
    expect(
      engineDraftToChanges(
        { "wage|default": { value: "$46.50" }, [`wage|${NY}`]: { reset: true } },
        "",
      ),
    ).toEqual([
      { op: "value", component: "wage", office_id: null, value: 46.5, effective_from: "" },
      { op: "value", component: "wage", office_id: NY, value: null, effective_from: "" },
    ]);
  });
});

describe("units (20261104120000)", () => {
  const YEAR: OverheadUnit = {
    key: "year",
    name: "Year",
    hours: 2080,
    system: false,
    sort_order: 50,
  };
  const MONTH: OverheadUnit = {
    key: "month",
    name: "Month",
    hours: 173.33,
    system: false,
    sort_order: 40,
  };
  const row = (measure: string, value: number, office: string | null = null) => ({
    book: "overhead",
    item_key: "general_liability",
    measure,
    office_id: office,
    effective_from: "2026-10-30",
    value,
  });

  it("an amount per year or month comes to the database's round(amount / hours, 2)", () => {
    expect(perHour(12000, YEAR)).toBe(5.77); // 12000 / 2080 = 5.769…
    expect(perHour(1000, MONTH)).toBe(5.77); // 1000 / 173.33 = 5.769…
    expect(perHour(40, { hours: 1 })).toBe(40);
  });

  it("a value typed in a unit goes as its amount and unit; the $/hour beside it", () => {
    const changes = engineDraftToChanges(
      { "general_liability|default": { value: "12,000" } },
      "",
      () => YEAR,
    );
    expect(changes).toEqual([
      {
        op: "value",
        component: "general_liability",
        office_id: null,
        value: 5.77,
        amount: 12000,
        unit: "year",
        effective_from: "",
      },
    ]);
    // Per hour: no amount, as before.
    expect(engineDraftToChanges({ "wage|default": { value: "40" } }, "")[0]).not.toHaveProperty(
      "amount",
    );
  });

  it("shows the amount as typed, not the $/hour multiplied back", () => {
    const rows = [row("cost_hr", 5.77), row("amount_year", 12000)] as MoneyValueRow[];
    expect(typedAmount(rows, "general_liability", YEAR, null, "2026-10-31")).toEqual({
      amount: 12000,
      source: "default",
      exact: true,
    });
  });

  it("a value saved per hour shows multiplied into the new unit, marked as such", () => {
    const rows = [row("cost_hr", 5.77)] as MoneyValueRow[];
    expect(typedAmount(rows, "general_liability", YEAR, null, "2026-10-31")).toEqual({
      amount: 12001.6, // 5.77 × 2080
      source: "default",
      exact: false,
    });
  });
});
