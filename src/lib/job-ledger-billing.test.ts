/**
 * T11: a seller (job.view_billing, no job.view_costs) sees Billed and Paid on
 * the ledger strip and the job's Amounts card — never a cost, rate or margin.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { LEDGER_STRIP, billingRowsWithOverrides, ledgerStripCells } from "./job-ledger";

describe("ledger strip — billing tier", () => {
  const rows = billingRowsWithOverrides(1000, 400, {});

  it("billing-only shows effort plus Billed and Paid, and no cost cell", () => {
    const keys = ledgerStripCells(rows, { showMoney: false, showBilling: true }).map((c) => c.key);
    expect(keys).toEqual(["days", "guys", "hours", "billed", "paid"]);
  });

  it("no billing shows effort only", () => {
    const keys = ledgerStripCells(rows, { showMoney: false }).map((c) => c.key);
    expect(keys).toEqual(["days", "guys", "hours"]);
  });

  it("only Billed and Paid are billing cells", () => {
    expect(LEDGER_STRIP.filter((c) => c.billing).map((c) => c.key)).toEqual(["billed", "paid"]);
  });

  it("carries the figures", () => {
    expect(rows.map((r) => [r.key, r.value])).toEqual([
      ["billed", 1000],
      ["paid", 400],
    ]);
  });
});

describe("wiring", () => {
  const page = readFileSync("src/routes/_authenticated/jobs.$id.tsx", "utf8");

  it("the job page reads job.view_billing for the strip and the Amounts card", () => {
    expect(page).toContain('const showBilling = useCan("job.view_billing");');
    expect(page).toContain(
      "<JobLedgerStrip jobId={job.id} showMoney={showMoney} showBilling={showBilling} />",
    );
  });

  it("every cost surface on the job page stays on job.view_costs", () => {
    for (const cost of [
      "<JobRunningCostWidgets",
      "<LargeLossExpensesCard",
      "<JobCommissionsCard",
      "<JobLabourPanel",
    ]) {
      const at = page.indexOf(cost);
      expect(at, cost).toBeGreaterThan(-1);
      const before = page.slice(Math.max(0, at - 400), at);
      expect(before, cost).toMatch(/showMoney/);
      expect(before, cost).not.toMatch(/showBilling \?|showBilling &&/);
    }
  });
});
