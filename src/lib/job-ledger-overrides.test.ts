import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { ledgerCellChange } from "@/components/job-ledger-cell";
import {
  LEDGER_CELL_SOURCES,
  LEDGER_EDITABLE_KEYS,
  LEDGER_EDIT_ROLES,
  LEDGER_STRIP,
  canEditLedger,
  effortRowsWithOverrides,
  jobLedgerRows,
  jobProfit,
  ledgerRowsWithOverrides,
  ledgerTotalExplanation,
  type LedgerInput,
  type LedgerOverrides,
  type LedgerRow,
} from "./job-ledger";

/*
 * Mark, of the pinned Job ledger strip: "can we make each box editable".
 * These hold the cell map, the arithmetic of a typed figure, and the
 * migration to each other.
 */

const input: LedgerInput = {
  cost: {
    labour_cost: 9000,
    field_ticket_labour_cost: 1000,
    equipment_cost: 2500,
    field_ticket_equipment_cost: 500,
    materials_cost: 700,
    stock_used_cost: 300,
    subcontractor_cost: 400,
    referral_cost: 600,
    // 10,000 labor + 3,000 equipment + 1,000 supplies + 400 subs + 600
    // referral = 15,000; the other 1,250 is logged expenses and cost lines.
    total_cost: 16250,
    revenue: 30000,
  } as LedgerInput["cost"],
  effort: { days: 3, crew: 4, personHours: 96 },
  billed: 25000,
  paid: 10000,
  referral: null,
  commission: 3000,
};

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const MIGRATION = read("supabase/migrations/20261007224500_job_ledger_overrides.sql");
const byKey = (rows: LedgerRow[]) => new Map(rows.map((r) => [r.key, r]));

describe("the cell → source map", () => {
  it("names a source and an edit rule for every cell on the strip, and nothing else", () => {
    expect(Object.keys(LEDGER_CELL_SOURCES).sort()).toEqual(LEDGER_STRIP.map((c) => c.key).sort());
    for (const [key, s] of Object.entries(LEDGER_CELL_SOURCES)) {
      expect(s.source.length, key).toBeGreaterThan(10);
    }
  });

  it("types the three columns nothing records, and overrides the calculated ones", () => {
    const of = (edit: string) =>
      Object.entries(LEDGER_CELL_SOURCES)
        .filter(([, s]) => s.edit === edit)
        .map(([k]) => k);
    expect(of("entry")).toEqual(["garbage", "truck_fee", "misc_fees"]);
    expect(of("override")).toEqual([
      "days",
      "guys",
      "hours",
      "supplies",
      "equipment",
      "sub_fees",
      "labor",
      "billed",
      "paid",
    ]);
    // The Commissions card owns these two, Labor rates owns the charge; the
    // totals follow their parts.
    expect(of("elsewhere")).toEqual(["supplies_charge", "labor_charge", "referral", "commission"]);
    expect(of("total")).toEqual(["total_expenses", "profit"]);
  });

  it("matches the migration's cell_key CHECK exactly", () => {
    const check = MIGRATION.match(/cell_key text NOT NULL CHECK \(cell_key IN \(([^)]*)\)\)/)!;
    const keys = [...check[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(keys.sort()).toEqual([...LEDGER_EDITABLE_KEYS].sort());
    for (const k of ["referral", "commission", "total_expenses", "profit"]) {
      expect(keys).not.toContain(k);
    }
  });

  it("treats effort as readable without cost access, in the code and the database alike", () => {
    const fn = MIGRATION.match(
      /FUNCTION public\.job_ledger_cell_readable[\s\S]*?\$\$([\s\S]*?)\$\$/,
    )![1];
    expect(fn).toContain("_cell_key IN ('days', 'guys', 'hours')");
    expect(LEDGER_STRIP.filter((c) => !c.money).map((c) => c.key)).toEqual([
      "days",
      "guys",
      "hours",
    ]);
    expect(fn).toContain("public.can_view_finance(auth.uid())");
    expect(fn).toContain("'job.view_costs', j.location_id");
  });

  it("lets exactly the job-money writers type, in the code and the database alike", () => {
    const fn = MIGRATION.match(
      /FUNCTION public\.job_ledger_cell_writable[\s\S]*?\$\$([\s\S]*?)\$\$/,
    )![1];
    const roles = [...fn.match(/ARRAY\[([^\]]*)\]/)![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(roles).toEqual([...LEDGER_EDIT_ROLES]);
    // The same three the job_cost_lines write policy names.
    const costLines = read(
      "supabase/migrations/20260807220752_d83f0a49-dca6-408d-94db-7e3588a0077c.sql",
    ).match(/"Finance roles write job cost lines"[\s\S]*?USING \(([^;]*)\)\s*WITH CHECK/)![1];
    expect(costLines).toContain("ARRAY['owner','admin','sales_head']");
    expect(canEditLedger(["owner"])).toBe(true);
    expect(canEditLedger(["sales_head"])).toBe(true);
    expect(canEditLedger(["office", "crew"])).toBe(false);
    expect(canEditLedger(["dev"])).toBe(false);
    expect(canEditLedger(undefined)).toBe(false);
  });
});

describe("a typed figure, laid over the calculated rows", () => {
  it("changes nothing when nothing is typed", () => {
    const plain = jobLedgerRows(input);
    const over = ledgerRowsWithOverrides(input, {});
    expect(over.map((r) => [r.key, r.value])).toEqual(plain.map((r) => [r.key, r.value]));
    expect(over.every((r) => !r.manual)).toBe(true);
    expect(byKey(over).get("supplies")!.calculated).toBe(1000);
  });

  it("moves Total Expenses and Total Profit by exactly what the typed cells add", () => {
    const rows = byKey(
      ledgerRowsWithOverrides(input, {
        garbage: { value: 350 },
        truck_fee: { value: 150 },
        equipment: { value: 2000 }, // calculated 3,000: 1,000 less
      }),
    );
    expect(rows.get("garbage")!.value).toBe(350);
    expect(rows.get("garbage")!.manual).toBe(true);
    expect(rows.get("garbage")!.tracked).toBe(true);
    expect(rows.get("equipment")!.calculated).toBe(3000);
    // 16,250 + 350 + 150 − 1,000
    expect(rows.get("total_expenses")!.value).toBe(15750);
    // The shared profit, 30,000 − 16,250 − 3,000 = 10,750, plus the 500 saved.
    expect(jobProfit(input)).toBe(10750);
    expect(rows.get("profit")!.value).toBe(11250);
  });

  it("never re-adds commission: profit starts from the shared figure", () => {
    const rows = byKey(ledgerRowsWithOverrides(input, { misc_fees: { value: 100 } }));
    expect(rows.get("profit")!.value).toBe(jobProfit(input) - 100);
    // Commission stays the Commissions card's figure.
    expect(rows.get("commission")!.value).toBe(3000);
    expect(rows.get("commission")!.manual).toBeUndefined();
  });

  it("takes the profit from a typed Billed, and leaves Paid and the effort out of the totals", () => {
    const rows = byKey(
      ledgerRowsWithOverrides(input, {
        billed: { value: 28000 },
        paid: { value: 28000 },
        days: { value: 5 },
        hours: { value: 120 },
      }),
    );
    expect(rows.get("billed")!.calculated).toBe(25000);
    expect(rows.get("total_expenses")!.value).toBe(16250);
    // Revenue 28,000 instead of the engine's 30,000.
    expect(rows.get("profit")!.value).toBe(10750 - 2000);
    expect(rows.get("days")!.value).toBe(5);
    expect(rows.get("days")!.calculated).toBe(3);
  });

  it("types an effort cell for a viewer who sees no money", () => {
    const rows = effortRowsWithOverrides(input.effort, { guys: { value: 6 } });
    expect(rows.map((r) => r.key)).toEqual(["days", "guys", "hours"]);
    expect(rows[1]).toMatchObject({ value: 6, manual: true, calculated: 4 });
  });

  it("ignores a typed figure for a cell that is not typeable", () => {
    const rows = byKey(
      ledgerRowsWithOverrides(input, {
        commission: { value: 1 },
        referral: { value: 1 },
        profit: { value: 1 },
        total_expenses: { value: 1 },
      }),
    );
    expect(rows.get("commission")!.value).toBe(3000);
    expect(rows.get("referral")!.value).toBe(600);
    expect(rows.get("total_expenses")!.value).toBe(16250);
    expect(rows.get("profit")!.value).toBe(10750);
  });
});

describe("what clicking a total says", () => {
  const sum = (lines: { value: number | null; sign: number }[]) =>
    Math.round(lines.reduce((s, l) => s + l.sign * (l.value ?? 0), 0) * 100) / 100;

  it("lists the cells that make up Total Expenses, and they add up to it", () => {
    for (const overrides of [
      {},
      { garbage: { value: 350 }, labor: { value: 8000 } },
    ] as LedgerOverrides[]) {
      const rows = ledgerRowsWithOverrides(input, overrides);
      const { lines, total } = ledgerTotalExplanation("total_expenses", rows, input.cost);
      expect(lines.map((l) => l.label)).toEqual([
        "Garbage",
        "Supplies",
        "Truck Fee",
        "Misc Fees",
        "Equipment",
        "Sub Fees",
        "Labor",
        "Referral",
        "Other recorded costs (expenses, cost lines)",
      ]);
      expect(sum(lines)).toBe(total);
    }
  });

  it("explains Total Profit as revenue less expenses less commission, typed Billed included", () => {
    for (const overrides of [
      {},
      { billed: { value: 20000 }, supplies: { value: 0 } },
    ] as LedgerOverrides[]) {
      const rows = ledgerRowsWithOverrides(input, overrides);
      const { lines, total } = ledgerTotalExplanation("profit", rows, input.cost);
      expect(lines.map((l) => l.label.split(" (")[0])).toEqual([
        "Revenue",
        "Total Expenses",
        "Commission",
      ]);
      expect(sum(lines)).toBe(total);
    }
  });
});

describe("what saving a cell means", () => {
  const calc: LedgerRow = {
    key: "equipment",
    label: "Equipment",
    value: 3000,
    kind: "money",
    tracked: true,
    calculated: 3000,
    manual: false,
  };
  const typed: LedgerRow = { ...calc, value: 2000, manual: true };

  it("saves a new figure and clears to calculated on an empty cell", () => {
    expect(ledgerCellChange(calc, 2500)).toBe(2500);
    expect(ledgerCellChange(typed, 2500)).toBe(2500);
    expect(ledgerCellChange(typed, null)).toBeNull();
  });

  it("does nothing when nothing changed — and never pins the calculated figure as manual", () => {
    expect(ledgerCellChange(calc, null)).toBe("unchanged");
    expect(ledgerCellChange(calc, 3000)).toBe("unchanged");
    expect(ledgerCellChange(typed, 2000)).toBe("unchanged");
  });

  it("saves a zero into an entry that had no figure", () => {
    const garbage: LedgerRow = {
      key: "garbage",
      label: "Garbage",
      value: null,
      kind: "money",
      tracked: false,
      calculated: null,
      manual: false,
    };
    expect(ledgerCellChange(garbage, 0)).toBe(0);
  });
});

/*
 * Mark, 7 Oct: "a card called commissions ... and that should be connected to
 * the card". The Referral cell is the card's referrer figure: typed referral
 * costs (inside the running cost's total) plus what the referrer's deal comes
 * to (not inside it). Clicking a total must still add up.
 */
describe("the totals with a referrer's deal on the Commissions card", () => {
  const owed: LedgerInput = { ...input, referral: 900 };
  const sum = (lines: { value: number | null; sign: number }[]) =>
    Math.round(lines.reduce((s, l) => s + l.sign * (l.value ?? 0), 0) * 100) / 100;

  it("Total Expenses counts only the typed part of Referral", () => {
    const rows = ledgerRowsWithOverrides(owed, {});
    expect(byKey(rows).get("referral")!.value).toBe(1500);
    const { lines, total } = ledgerTotalExplanation("total_expenses", rows, owed.cost);
    expect(lines.find((l) => l.label === "Referral")!.value).toBe(600);
    expect(total).toBe(16250);
    expect(sum(lines)).toBe(total);
  });

  it("Total Profit takes the deal off once, by name", () => {
    const rows = ledgerRowsWithOverrides(owed, {});
    const { lines, total } = ledgerTotalExplanation("profit", rows, owed.cost);
    expect(lines.map((l) => l.label.split(" (")[0])).toEqual([
      "Revenue",
      "Total Expenses",
      "Referral owed",
      "Commission",
    ]);
    expect(total).toBe(30000 - 16250 - 900 - 3000);
    expect(sum(lines)).toBe(total);
  });
});

/*
 * Mark, 7 Oct: "running cost needs to add that into its calculation as
 * well". Once the running cost counts commission (20261007224300), the
 * Referral and Commission cells sit inside Total Expenses whole and Total
 * Profit is revenue less Total Expenses — the same profit, counted once.
 */
describe("the totals once the running cost counts commission", () => {
  const before: LedgerInput = { ...input, referral: 900 };
  const after: LedgerInput = {
    ...input,
    referral: 900,
    cost: { ...input.cost, total_cost: 16250 + 900 + 3000, commission_cost: 3900 },
  };
  const sum = (lines: { value: number | null; sign: number }[]) =>
    Math.round(lines.reduce((s, l) => s + l.sign * (l.value ?? 0), 0) * 100) / 100;

  it("gives the same Total Profit as before, from Total Expenses alone", () => {
    const a = byKey(ledgerRowsWithOverrides(after, {}));
    const b = byKey(ledgerRowsWithOverrides(before, {}));
    expect(a.get("profit")!.value).toBe(b.get("profit")!.value);
    const rows = ledgerRowsWithOverrides(after, {});
    const { lines, total } = ledgerTotalExplanation("profit", rows, after.cost);
    expect(lines.map((l) => l.label)).toEqual(["Revenue", "Total Expenses"]);
    expect(sum(lines)).toBe(total);
  });

  it("lists Referral and Commission inside Total Expenses, and they add up", () => {
    const rows = ledgerRowsWithOverrides(after, { garbage: { value: 200 } });
    const { lines, total } = ledgerTotalExplanation("total_expenses", rows, after.cost);
    expect(lines.find((l) => l.label === "Referral")!.value).toBe(1500);
    expect(lines.find((l) => l.label === "Commission")!.value).toBe(3000);
    expect(sum(lines)).toBe(total);
  });
});
