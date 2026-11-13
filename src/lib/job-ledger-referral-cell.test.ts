import { describe, expect, it } from "vitest";

import {
  commissionCellFigure,
  jobLedgerRows,
  ledgerStripCells,
  type LedgerInput,
} from "@/lib/job-ledger";

/*
 * David, 26 Oct: on the job ledger strip the Referral cell shows WHO referred
 * the job, and Commission shows the commission amount — the referrer's plus
 * the sales reps'. The rows' own values (and so the totals and the report)
 * are unchanged.
 */
const COST = {
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
  revenue: 10000,
  commission_cost: 0,
} as unknown as LedgerInput["cost"];

const input = (over: Partial<LedgerInput>): LedgerInput => ({
  cost: COST,
  effort: null,
  billed: null,
  paid: null,
  referral: null,
  commission: null,
  ...over,
});
const cells = (i: LedgerInput) => ledgerStripCells(jobLedgerRows(i), { showMoney: true });
const at = (i: LedgerInput, k: string) => cells(i).find((c) => c.key === k)!;

describe("the Referral and Commission cells", () => {
  it("Referral shows the referrer's name, its money unchanged on the row", () => {
    const i = input({ referral: 500, referrerName: "ABC Plumbing" });
    expect(at(i, "referral").shown).toEqual({ text: "ABC Plumbing" });
    expect(at(i, "referral").row?.value).toBe(500);
    expect(at(i, "referral").row?.note).toMatch(/Referred by ABC Plumbing · \$500\.00 owed/);
  });

  it("Commission shows the referrer's commission plus the sales reps', and says how it splits", () => {
    const i = input({ referral: 500, commission: 250, referrerName: "ABC Plumbing" });
    expect(at(i, "commission").shown).toEqual({
      money: 750,
      note: "Referral (ABC Plumbing) $500.00 + Sales reps $250.00 — the Commissions card.",
    });
    expect(commissionCellFigure(jobLedgerRows(input({ referral: 500 }))).money).toBe(500);
  });

  it("is a dash, not a zero, when nothing is set", () => {
    const i = input({});
    expect(at(i, "referral").shown).toEqual({ text: null });
    expect(at(i, "commission").shown).toMatchObject({ money: null });
  });

  it("leaves Total Profit exactly as before", () => {
    const before = jobLedgerRows(input({ referral: 500, commission: 250 })).find(
      (r) => r.key === "profit",
    )!.value;
    const after = jobLedgerRows(input({ referral: 500, commission: 250, referrerName: "X" })).find(
      (r) => r.key === "profit",
    )!.value;
    expect(after).toBe(before);
  });
});
