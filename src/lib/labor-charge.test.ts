import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  jobLedgerRows,
  laborChargeRow,
  ledgerRowsWithOverrides,
  type LedgerInput,
} from "@/lib/job-ledger";
import { ledgerLaborCharge } from "@/lib/labour-bill-rates";

/*
 * Mark / David, 22 Oct:
 *   - Settings › Labor rates: "the option here to put in the labor charge to
 *     customers as well & this is where the job ledger will get the info from."
 *   - Billing: "a third button here that accomplishes the pull from job
 *     invoice… near the quick invoice and new invoice" — called "Field items".
 */
const ZERO = {
  equipment_cost: 0,
  equipment_days: 0,
  equipment_units: 0,
  equipment_unpriced_units: 0,
  labour_cost: 1200,
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
  total_cost: 1200,
  revenue: 5000,
  commission_cost: 0,
} as unknown as LedgerInput["cost"];

const input = (over: Partial<LedgerInput> = {}): LedgerInput => ({
  cost: ZERO,
  effort: { days: 2, crew: 3, personHours: 40 },
  billed: 5000,
  paid: 0,
  referral: null,
  commission: null,
  laborCharge: { rate: 65, source: "this office's charge rate" },
  ...over,
});
const at = (rows: ReturnType<typeof jobLedgerRows>, k: string) => rows.find((r) => r.key === k)!;

describe("the job ledger's Labor Charge", () => {
  it("is the ledger's hours × the office's charge rate", () => {
    const row = at(jobLedgerRows(input()), "labor_charge");
    expect(row).toMatchObject({ label: "Labor Charge", value: 2600, tracked: true, kind: "money" });
    expect(row.note).toMatch(/\$65\.00\/hr — this office's charge rate/);
  });

  it("sits right after Labor, the cost", () => {
    const keys = jobLedgerRows(input()).map((r) => r.key);
    expect(keys.indexOf("labor_charge")).toBe(keys.indexOf("labor") + 1);
  });

  it("is not an expense and not profit — those do not move with it", () => {
    const withRate = jobLedgerRows(input());
    const without = jobLedgerRows(input({ laborCharge: null }));
    for (const k of ["total_expenses", "profit"])
      expect(at(withRate, k).value).toBe(at(without, k).value);
  });

  it("follows a typed Hours cell", () => {
    const rows = ledgerRowsWithOverrides(input(), { hours: { value: 10 } });
    expect(at(rows, "labor_charge").value).toBe(650);
  });

  it("says so when no rate is set, rather than inventing one", () => {
    expect(laborChargeRow(40, null)).toMatchObject({ value: null, tracked: false });
    expect(laborChargeRow(40, null).note).toMatch(/Billing & Costs › General Rates/);
    expect(laborChargeRow(null, { rate: 65, source: "x" })).toMatchObject({
      value: null,
      tracked: false,
    });
  });

  it("names where the rate came from", () => {
    expect(ledgerLaborCharge({ rate: 65, source: "location" })?.source).toBe(
      "this office's charge rate",
    );
    expect(ledgerLaborCharge({ rate: 70, source: "builtin" })?.source).toMatch(
      /standard charge rate/,
    );
    expect(ledgerLaborCharge(null)).toBeNull();
    expect(ledgerLaborCharge({ rate: 0, source: "location" })).toBeNull();
  });

  it("is fed the office's rate on the job page and in the Job ledger report", () => {
    const panel = readFileSync("src/components/job-ledger-panel.tsx", "utf8");
    expect(panel).toMatch(/laborCharge: chargeQ\.data\?\.laborCharge \?\? null/);
    const report = readFileSync("src/lib/job-ledger-report.ts", "utf8");
    expect(report).toMatch(/laborCharge: chargeBy\.get\(j\.location_id\) \?\? null/);
  });
});

describe("Labor charge rate by office (Client Agreements until prompt 4)", () => {
  const page = readFileSync("src/components/admin/labor-rates-section.tsx", "utf8");

  it("shows the charge rate for every office, not only after picking one", () => {
    expect(page).toMatch(/Labor charge rate by office/);
    expect(page).toMatch(/const offices = app\.visibleLocations;/);
    expect(page).not.toMatch(
      /Pick one location in the location switcher to see and set its bill rate/,
    );
  });

  it("comes before the client rates, and can set every office at once", () => {
    expect(page.indexOf("<BillRateCard />")).toBeLessThan(page.indexOf("<ClientRatesCard />"));
    expect(page).toMatch(
      /save\.mutate\(\{ ids: offices\.map\(\(o\) => o\.id\), rate: Number\(allDraft\) \}\)/,
    );
  });
});

describe("Billing › Field items", () => {
  it("is its own button beside Quick invoice and New invoice, doing Pull from job in one press", () => {
    const panel = readFileSync("src/components/job-billing-panel.tsx", "utf8");
    const quick = panel.indexOf(">\n                    Quick invoice\n");
    const field = panel.indexOf("data-field-items-invoice");
    const fresh = panel.indexOf('"New invoice"');
    expect(quick).toBeGreaterThan(-1);
    expect(field).toBeGreaterThan(quick);
    expect(field).toBeLessThan(fresh);
    const button = panel.slice(panel.lastIndexOf("<Button", field), field);
    expect(button).toMatch(/onClick=\{\(\) => void newInvoice\(\{ pull: true \}\)\}/);
  });
});

describe("Labor by office (voice note, 23 Oct) — absorbed by Compare offices (prompt 3)", () => {
  const page = readFileSync("src/components/admin/labor-rates-section.tsx", "utf8");

  it("keeps the charged rate per office; each office's cost is the Cost tab's Compare view", () => {
    expect(page).toMatch(/Labor rate — charged \(USD\/hr\)/);
    expect(page).not.toMatch(/data-office-cost/);
    expect(readFileSync("src/components/billing-costs/tm-rates-tab.tsx", "utf8")).toMatch(
      /<Columns3 aria-hidden \/> Compare offices/,
    );
  });

  it("reads an office's own cost first, else the company default", async () => {
    const { officeCrewCost } = await import("@/lib/labour");
    const row = (over: Record<string, unknown>) =>
      ({
        crew_class: "gsr",
        user_id: null,
        location_id: null,
        hourly_rate: 45,
        effective_from: "2020-01-01",
        effective_to: null,
        ...over,
      }) as never;
    const rates = [row({}), row({ location_id: "ny", hourly_rate: 50 })];
    expect(officeCrewCost(rates, "ny", "2026-10-23")).toEqual({ rate: 50, own: true });
    expect(officeCrewCost(rates, "nj", "2026-10-23")).toEqual({ rate: 45, own: false });
    expect(officeCrewCost([], "nj", "2026-10-23")).toBeNull();
  });
});

describe("the job ledger's Labor = each day's hours at that day's crew rate (P5.1)", () => {
  const cost = { rate: 45, source: "the default crew cost" };

  it("is the running cost's work-date labor, not all hours × today's rate", () => {
    const base = jobLedgerRows(input());
    const rows = jobLedgerRows(input({ laborCost: cost }));
    // Old: 40 h × today's 45.00 = 1,800.00. New: the running cost's 1,200.00
    // (each day's hours at the rate in force that day). Totals no longer shift.
    expect(at(rows, "labor")).toMatchObject({ value: 1200 });
    expect(at(rows, "labor").note).toMatch(/at that day's crew rate/);
    expect(at(rows, "total_expenses").value).toBe(at(base, "total_expenses").value);
    expect(at(rows, "profit").value).toBe(at(base, "profit").value);
  });

  it("falls back to the running cost's labor with no cost rate", () => {
    expect(at(jobLedgerRows(input()), "labor").value).toBe(1200);
    expect(at(jobLedgerRows(input({ laborCost: { rate: 0, source: "x" } })), "labor").value).toBe(
      1200,
    );
  });

  it("follows a typed Hours cell, and a typed Labor still wins", () => {
    const typedHours = ledgerRowsWithOverrides(input({ laborCost: cost }), {
      hours: { value: 10 },
    });
    expect(at(typedHours, "labor").value).toBe(450);
    expect(at(typedHours, "labor").manual).toBeFalsy();
    const base = jobLedgerRows(input({ laborCost: cost }));
    // Typed hours have no work days: 10 × 45.00 = 450.00, against the 1,200.00 shown.
    expect(at(typedHours, "total_expenses").value).toBe(
      (at(base, "total_expenses").value ?? 0) - 750,
    );
    const typedLabor = ledgerRowsWithOverrides(input({ laborCost: cost }), {
      hours: { value: 10 },
      labor: { value: 999 },
    });
    expect(at(typedLabor, "labor").value).toBe(999);
  });

  it("is fed the office's crew cost on the job page and in the report", () => {
    expect(readFileSync("src/components/job-ledger-panel.tsx", "utf8")).toMatch(
      /laborCost: chargeQ\.data\?\.laborCost \?\? null/,
    );
    expect(readFileSync("src/lib/job-ledger-report.ts", "utf8")).toMatch(
      /laborCost: costBy\.get\(j\.location_id\) \?\? null/,
    );
  });
});
