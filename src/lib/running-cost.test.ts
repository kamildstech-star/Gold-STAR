import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  REVENUE_BASIS_LABEL,
  asRevenueBasis,
  runningCostSources,
  sumOfSources,
  type CostSourceKey,
  type RunningCost,
} from "./running-cost";

/**
 * Mark: "the right side should show a runnign cost adding up all costs added
 * in from alal sources of costs from the project". The database does the
 * adding (supabase/tests/running-cost-all-sources.pglite.mjs proves that);
 * these tests pin what the drawer makes of the row it gets back.
 */

const ZERO: RunningCost = {
  equipment_cost: 0,
  equipment_days: 0,
  equipment_units: 0,
  equipment_unpriced_units: 0,
  labour_cost: 0,
  labour_minutes: 0,
  labour_uncosted_minutes: 0,
  field_ticket_cost: 0,
  field_ticket_labour_cost: 0,
  field_ticket_equipment_cost: 0,
  field_tickets: 0,
  field_tickets_unposted: 0,
  field_ticket_uncosted_minutes: 0,
  materials_cost: 0,
  stock_used_cost: 0,
  subcontractor_cost: 0,
  expenses_cost: 0,
  expenses_count: 0,
  referral_cost: 0,
  manual_cost: 0,
  calculator_cost: 0,
  total_cost: 0,
  revenue: 0,
  revenue_basis: "none",
  margin: 0,
  margin_pct: null,
};

const EVERY_SOURCE: CostSourceKey[] = [
  "field_tickets",
  "labour",
  "equipment",
  "materials",
  "stock",
  "subcontractors",
  "expenses",
  "referral",
  "manual",
];

describe("runningCostSources", () => {
  it("lists every source at $0 on an empty job, each naming where it would come from", () => {
    const rows = runningCostSources(ZERO);
    expect(rows.map((r) => r.key)).toEqual(EVERY_SOURCE);
    for (const r of rows) {
      expect(r.value).toBe(0);
      expect(r.source).toMatch(/^(from|typed on) /);
    }
    // A $0 total with nothing to explain it is what Mark was looking at.
    expect(rows.find((r) => r.key === "field_tickets")?.meta).toBe("No tickets filed");
    expect(rows.find((r) => r.key === "labour")?.meta).toBe("No clock entries");
    expect(rows.find((r) => r.key === "equipment")?.meta).toBe("Nothing deployed");
  });

  it("adds to the function's total, and the calculator projection is not among the rows", () => {
    const c: RunningCost = {
      ...ZERO,
      equipment_cost: 195,
      labour_cost: 80,
      field_ticket_cost: 830,
      field_ticket_labour_cost: 600,
      field_ticket_equipment_cost: 230,
      field_tickets: 3,
      materials_cost: 50,
      stock_used_cost: 25,
      subcontractor_cost: 300,
      expenses_cost: 75,
      expenses_count: 1,
      referral_cost: 150,
      manual_cost: 220,
      calculator_cost: 1000,
      total_cost: 1925,
    };
    const rows = runningCostSources(c);
    expect(sumOfSources(rows)).toBe(c.total_cost);
    expect(rows.some((r) => r.value === 1000)).toBe(false);
  });

  it("says what a figure could not see: unrated hours, unpriced units, tickets with no line", () => {
    const rows = runningCostSources({
      ...ZERO,
      field_tickets: 2,
      field_tickets_unposted: 1,
      field_ticket_uncosted_minutes: 240,
      labour_uncosted_minutes: 90,
      equipment_units: 3,
      equipment_days: 9,
      equipment_unpriced_units: 1,
    });
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(by.field_tickets.warning).toContain("4.0 h of crew time have no crew rate");
    expect(by.field_tickets.warning).toContain("1 ticket priced from the form");
    expect(by.labour.warning).toBe("1.5 h on the clock have no rate");
    expect(by.equipment.warning).toBe("1 unit with no daily rate");
    expect(by.equipment.meta).toBe("3 units · 9 days");
    expect(by.materials.warning).toBeUndefined();
  });
});

describe("revenue basis", () => {
  it("names every rung of the ladder, three ways, and treats anything else as none", () => {
    for (const basis of [
      "invoice",
      "estimate",
      "agreed_price",
      "estimate_sent",
      "estimate_draft",
      "cost_lines",
      "none",
    ] as const) {
      expect(asRevenueBasis(basis)).toBe(basis);
      expect(REVENUE_BASIS_LABEL[basis].short.length).toBeGreaterThan(0);
      expect(REVENUE_BASIS_LABEL[basis].badge.length).toBeGreaterThan(0);
      expect(REVENUE_BASIS_LABEL[basis].sentence).toMatch(/\.$/);
    }
    expect(asRevenueBasis("accepted")).toBe("none");
    expect(asRevenueBasis(undefined)).toBe("none");
    // A draft is called a draft: the reader must not mistake ESTIMATE-1's
    // $872 for something the customer agreed to.
    expect(REVENUE_BASIS_LABEL.estimate_draft.badge).toBe("vs draft estimate");
  });
});

/* ------------------------------------------------------------------ */
/* Source guards on the panel — there is no DOM testing library here.  */
/* ------------------------------------------------------------------ */

const PANEL = readFileSync("src/components/job-running-cost-panel.tsx", "utf8").replace(
  /\r\n/g,
  "\n",
);

describe("job-running-cost-panel.tsx", () => {
  it("prints the rows runningCostSources returns, unfiltered, keyed by source", () => {
    const rowsDecl = /const rows = runningCostSources\(c\)[^;]*;/.exec(PANEL);
    expect(rowsDecl).not.toBeNull();
    // The old panel filtered to non-zero rows, which is how an empty source
    // disappeared. Every source renders, every time.
    expect(rowsDecl![0]).not.toContain(".filter(");
    expect(PANEL).toMatch(/data-cost-source=\{r\.key\}/);
    expect(PANEL).toMatch(/\{r\.source\}/);
    expect(PANEL).toMatch(/\{r\.warning\}/);
  });

  it("audits its own rows against the total and shows the calculator projection outside it", () => {
    expect(PANEL).toMatch(/c\.total_cost - sumOfSources\(rows\)/);
    expect(PANEL).toContain("Not itemized");
    const calc = /c\.calculator_cost > 0 && \([\s\S]*?not in the total/.exec(PANEL);
    expect(calc).not.toBeNull();
  });

  it("names the revenue basis from the one table in every place it appears", () => {
    const uses = PANEL.match(/REVENUE_BASIS_LABEL\[c\.revenue_basis\]\.(badge|short|sentence)/g);
    expect(uses).not.toBeNull();
    expect(new Set(uses)).toEqual(
      new Set([
        "REVENUE_BASIS_LABEL[c.revenue_basis].badge",
        "REVENUE_BASIS_LABEL[c.revenue_basis].short",
        "REVENUE_BASIS_LABEL[c.revenue_basis].sentence",
      ]),
    );
    // No hand-rolled ternary left to drift from the table.
    expect(PANEL).not.toMatch(/revenue_basis === "/);
  });

  it("keeps the finance gate: the panel renders nothing when the RPC returns no row", () => {
    const gate = /if \(!c\) return null;/.exec(PANEL);
    expect(gate).not.toBeNull();
  });
});

/*
 * Mark, 7 Oct: "running cost needs to add that into its calculation as
 * well". Once 20261007224300 is applied the row carries commission inside
 * total_cost, and the drawer lists it so its own audit still adds up.
 */
describe("commission in the running cost", () => {
  const withCommission: RunningCost = {
    ...ZERO,
    expenses_cost: 1000,
    referrer_commission_cost: 800,
    salesman_commission_cost: 600,
    commission_cost: 1400,
    total_cost: 2400,
    revenue: 10000,
  };

  it("is a row of its own, and the rows still add to the total", () => {
    const rows = runningCostSources(withCommission);
    const row = rows.find((r) => r.key === "commission")!;
    expect(row.value).toBe(1400);
    expect(row.meta).toBe("$800 referrer · $600 salesmen");
    expect(sumOfSources(rows)).toBe(withCommission.total_cost);
  });

  it("before the migration there is no row, and nothing claims a commission", () => {
    expect(runningCostSources(ZERO).some((r) => r.key === "commission")).toBe(false);
  });
});
