import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_COMMISSION_SOURCES,
  jobLedgerRows,
  jobProfit,
  parseCommissionSources,
} from "@/lib/job-ledger";
import { basisAmount, resolveReferrerBasis } from "@/lib/job-commission";
import type { RunningCost } from "@/lib/running-cost";

/** The "Came from" rate through THE calculation, as the card applies it. */
const sourceDeal = (source: string | null, override: number | null = null) =>
  resolveReferrerBasis({
    accountId: null,
    contactId: null,
    sourceKey: source,
    overridePct: override,
    overrideFlat: null,
    rules: [],
    sources: DEFAULT_COMMISSION_SOURCES,
    on: "2026-10-01",
  });

/**
 * David's jobs spreadsheet, as the job's own money view.
 *
 * David, 17 Sep: "pretty much the items like I have on the spreadsheet I sent
 * you — that we track all the jobs, that counts the days and the guys and the
 * hours and our expenses, what we're billing and all that, commissions. I want
 * to try to replicate that in the system... the goal is to just have one
 * automated system and everybody shouldn't have to put everything in five
 * times."
 *
 * The rule these tests exist to hold: NOTHING here computes a cost. Every
 * figure is read from job_running_cost, the one costing engine, and commission
 * is the single new arithmetic. And a column with no source shows as
 * not-tracked rather than as a zero — a zero claims nothing was spent.
 */
const MIGRATION = readFileSync(
  "supabase/migrations/20260918190000_job_commission.sql",
  "utf8",
).replace(/\r\n/g, "\n");

const cost = (over: Partial<RunningCost> = {}): RunningCost =>
  ({
    equipment_cost: 400,
    equipment_days: 8,
    equipment_units: 4,
    equipment_unpriced_units: 0,
    labour_cost: 300,
    labour_minutes: 600,
    labour_uncosted_minutes: 0,
    field_ticket_cost: 900,
    field_ticket_labour_cost: 720,
    field_ticket_equipment_cost: 180,
    field_tickets: 3,
    field_tickets_unposted: 0,
    field_ticket_uncosted_minutes: 0,
    materials_cost: 120,
    stock_used_cost: 30,
    subcontractor_cost: 500,
    expenses_cost: 0,
    expenses_count: 0,
    referral_cost: 250,
    manual_cost: 0,
    calculator_cost: 0,
    total_cost: 2000,
    revenue: 10000,
    revenue_basis: "invoice",
    margin: 8000,
    margin_pct: 80,
    ...over,
  }) as RunningCost;

const input = (over = {}) => ({
  cost: cost(),
  effort: { days: 3, crew: 2, personHours: 48 },
  billed: 10000,
  paid: 6000,
  referral: null as number | null,
  commission: 1000 as number | null,
  ...over,
});

describe("the sheet's columns, in his order", () => {
  it("carries every column he tracks", () => {
    expect(jobLedgerRows(input()).map((r) => r.label)).toEqual([
      "Days",
      "Guys",
      "Hours",
      "Garbage",
      "Supplies",
      // 23 Oct: each supply × its charge (Settings › Cost rates).
      "Supplies Charge",
      "Truck Fee",
      "Misc Fees",
      "Equipment",
      "Sub Fees",
      "Labor",
      // 22 Oct: the labor charge rate (Settings › Labor rates) × hours.
      "Labor Charge",
      "Total Expenses",
      "Billed",
      "Paid",
      "Referral",
      "Commission",
      "Total Profit",
    ]);
  });

  it("reads every cost from the engine, adding nothing of its own", () => {
    const rows = jobLedgerRows(input());
    const at = (k: string) => rows.find((r) => r.key === k)!.value;
    // Labour is the clock plus the tickets; equipment is placements plus the
    // machines on tickets; supplies is requests plus stock off the shelf.
    expect(at("labor")).toBe(300 + 720);
    expect(at("equipment")).toBe(400 + 180);
    expect(at("supplies")).toBe(120 + 30);
    expect(at("sub_fees")).toBe(500);
    expect(at("referral")).toBe(250);
    // And the total is the engine's own, not a re-addition of the rows above.
    expect(at("total_expenses")).toBe(2000);
  });
});

describe("columns with no source say so", () => {
  it("marks garbage, truck fee and misc fees as not tracked", () => {
    /*
     * A zero is a claim that nothing was spent. "Not tracked" is the truth,
     * and it is the difference between the office trusting this against the
     * spreadsheet and quietly going back to the spreadsheet.
     */
    const rows = jobLedgerRows(input());
    for (const key of ["garbage", "truck_fee", "misc_fees"]) {
      const row = rows.find((r) => r.key === key)!;
      expect(row.tracked, `${key} should not claim to be tracked`).toBe(false);
      expect(row.value).toBeNull();
      expect(row.note).toBeTruthy();
    }
  });

  it("marks days, guys and hours untracked when no ticket was filed", () => {
    const rows = jobLedgerRows(input({ effort: null }));
    for (const key of ["days", "guys", "hours"]) {
      expect(rows.find((r) => r.key === key)!.tracked).toBe(false);
    }
  });

  it("counts the largest crew on a day, not the sum across days", () => {
    // Two men over three days is two guys on his sheet, not six.
    const rows = jobLedgerRows(input({ effort: { days: 3, crew: 2, personHours: 48 } }));
    expect(rows.find((r) => r.key === "guys")!.value).toBe(2);
    expect(rows.find((r) => r.key === "days")!.value).toBe(3);
  });
});

describe("commission", () => {
  it("uses the rate for the source", () => {
    const deal = sourceDeal("pa");
    expect(deal?.value).toBe(20);
    expect(basisAmount(deal, 10000)).toBe(2000);
  });

  it("carries his per-person rates, not just the roles", () => {
    const by = (k: string) => DEFAULT_COMMISSION_SOURCES.find((s) => s.key === k)?.pct;
    expect(by("salesman")).toBe(10);
    expect(by("broker")).toBe(10);
    expect(by("pa")).toBe(20);
    expect(by("called_in")).toBe(0);
    expect(by("shia_spira")).toBe(25);
    expect(by("star_moore")).toBe(30);
    expect(by("klein_gsr")).toBe(20);
    expect(by("klein_out_of_town")).toBe(25);
    expect(by("klein_in_town")).toBe(35);
  });

  it("lets one job override its source's rate", () => {
    expect(sourceDeal("pa", 12.5)?.value).toBe(12.5);
  });

  it("is null, never zero, when nobody has said where the job came from", () => {
    /*
     * "No commission is owed" and "nobody has said who this came from" are
     * different facts, and only one of them is safe to put in a profit line.
     */
    expect(sourceDeal(null)).toBeNull();
    expect(basisAmount(null, 10000)).toBeNull();
  });

  it("is zero for Called In, which is a real rate of nought", () => {
    const deal = sourceDeal("called_in");
    expect(deal?.value).toBe(0);
    expect(basisAmount(deal, 10000)).toBe(0);
  });

  it("falls back whole when the stored table is unusable, and field by field otherwise", () => {
    expect(parseCommissionSources(null)).toEqual(DEFAULT_COMMISSION_SOURCES);
    expect(parseCommissionSources({ sources: [] })).toEqual(DEFAULT_COMMISSION_SOURCES);
    // A bad row is dropped; the good ones survive.
    expect(
      parseCommissionSources({
        sources: [
          { key: "a", label: "A", pct: 5 },
          { key: "", label: "nameless", pct: 5 },
          { key: "b", pct: 200 },
        ],
      }),
    ).toEqual([{ key: "a", label: "A", pct: 5 }]);
  });
});

describe("profit", () => {
  it("is revenue less costs less commission", () => {
    expect(jobProfit(input())).toBe(10000 - 2000 - 1000);
  });

  it("treats an unset commission as zero in the figure, but the row says so", () => {
    // The profit line has to show a number; the Commission row above says it
    // is not set, so nobody reads the figure as final.
    expect(jobProfit(input({ commission: null }))).toBe(8000);
    const row = jobLedgerRows(input({ commission: null })).find((r) => r.key === "commission")!;
    expect(row.tracked).toBe(false);
    expect(row.note).toContain("Commissions card");
  });

  /*
   * Mark, 7 Oct: "and reports, it needs to be able to separate salesman and
   * referrers." Referral is what the referrer is owed (plus referral costs
   * typed on the job, which are already in the running cost); Commission is
   * the salesmen. Profit comes off both, and never twice.
   */
  it("takes the referrer's deal and the salesmen off, once each", () => {
    const both = input({ referral: 600, commission: 400 });
    expect(jobProfit(both)).toBe(10000 - 2000 - 600 - 400);
    const at = (k: string) => jobLedgerRows(both).find((r) => r.key === k)!.value;
    // 250 typed (inside total_cost) + 600 owed: the column shows both...
    expect(at("referral")).toBe(850);
    expect(at("commission")).toBe(400);
    // ...but only the 600 comes off profit again; the 250 already did.
    expect(at("profit")).toBe(7000);
  });

  it("a referrer with no deal and nothing typed is a dash, not $0", () => {
    const row = jobLedgerRows(input({ cost: cost({ referral_cost: 0 }) })).find(
      (r) => r.key === "referral",
    )!;
    expect(row.value).toBeNull();
    expect(row.tracked).toBe(false);
    expect(row.note).toContain("General tab");
  });
});

describe("the migration", () => {
  it("puts the source and an optional override on the job", () => {
    expect(MIGRATION).toContain("ADD COLUMN IF NOT EXISTS commission_source text");
    expect(MIGRATION).toContain("ADD COLUMN IF NOT EXISTS commission_rate_pct numeric(5,2)");
  });

  it("refuses a rate outside 0–100", () => {
    expect(MIGRATION).toContain("commission_rate_pct >= 0 AND commission_rate_pct <= 100");
  });

  it("seeds his rate table without overwriting a renegotiated one", () => {
    expect(MIGRATION).toContain("'commission_rates'");
    expect(MIGRATION).toContain("ON CONFLICT (key) DO NOTHING");
  });

  it("changes no RLS", () => {
    expect(MIGRATION).not.toMatch(/CREATE POLICY|DROP POLICY|ALTER POLICY/);
  });
});

describe("commission counted once, wherever it is counted", () => {
  /*
   * Mark, 7 Oct: "running cost needs to add that into its calculation as
   * well". After 20261007224300 the running cost's total already holds the
   * commission, so the profit is its margin and nothing more comes off; before
   * it, the ledger takes the card's figures off itself. Same answer both ways.
   */
  it("gives the same profit before and after the running cost counts it", () => {
    const before = input({ referral: 600, commission: 400 });
    const after = input({
      referral: 600,
      commission: 400,
      cost: cost({ total_cost: 2000 + 1000, commission_cost: 1000 }),
    });
    expect(jobProfit(before)).toBe(10000 - 2000 - 1000);
    expect(jobProfit(after)).toBe(jobProfit(before));
  });

  it("says so on Total Expenses", () => {
    const after = input({ cost: cost({ commission_cost: 0 }) });
    const row = jobLedgerRows(after).find((r) => r.key === "total_expenses")!;
    expect(row.note).toContain("the running cost counts them");
  });
});
