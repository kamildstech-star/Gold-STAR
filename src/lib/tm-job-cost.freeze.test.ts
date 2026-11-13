import { describe, expect, it } from "vitest";

import { resolveOfficeValue, type MoneyValueRow } from "@/lib/office-values";
import type { LaborRow, PricedCode, TmBill } from "@/lib/tm-bill";
import { tmJobCost } from "@/lib/tm-job-cost";
import { withJobCostRates } from "@/lib/tm-job-rates";

/*
 * Billing & Costs prompt 3: a job's labor cost resolves through the cost
 * store as it stood the day the job was made (tm_cost_rates), so publishing
 * the overhead engine never moves an existing job's expense. The SQL side is
 * proven in supabase/tests/billing-costs-cost-overhead.pglite.mjs; this pins
 * the expense the Amounts card shows, to the cent, through the same
 * resolution rule (office-values.ts is the TypeScript twin of
 * resolve_money_value) and the loader's own merge (withJobCostRates).
 */
const NJ = "nj";
const CODES: PricedCode[] = [
  { code: "SCL", label: "Structural Cleaning Labor", section: "labor", rate: 88 },
  { code: "104", label: "6 Mil Poly", section: "consumable", rate: 150 },
];
const labor = (date: string, regular: number, premium: number): LaborRow => ({
  date,
  name: "Jose",
  code: "SCL",
  title: "SCL",
  rate: 88,
  regular,
  premium,
  premiumAmount: 0,
  premiumNote: null,
  total: 0,
  unpriced: null,
  unsigned: false,
  problem: null,
});
// Two days of 8 regular + 3 overtime hours, and two rolls of poly.
const BILL = {
  labor: [labor("2026-01-20", 8, 3), labor("2026-01-21", 8, 3)],
  materials: [
    {
      date: "2026-01-20",
      code: "104",
      description: "Poly",
      qty: 2,
      unit: "RL",
      price: 150,
      total: 300,
    },
  ],
  equipment: [],
  vehicles: [],
  subcontractors: [],
  lodging: [],
  reimbursables: [],
} as unknown as Pick<
  TmBill,
  "labor" | "materials" | "equipment" | "vehicles" | "subcontractors" | "lodging" | "reimbursables"
>;

const cost = (
  item_key: string,
  office_id: string | null,
  effective_from: string,
  value: number | null,
): MoneyValueRow => ({
  book: "cost",
  item_key,
  measure: "cost_rate",
  office_id,
  effective_from,
  value,
});
/** Carried over from T&M rate codes by the migration. */
const SEED = [cost("SCL", null, "2000-01-01", 52.8), cost("104", null, "2000-01-01", 80)];
/** The engine's first publish: default 49.50, NJ 54.50 (its own wage). */
const PUBLISH = [cost("SCL", null, "2026-10-29", 49.5), cost("SCL", NJ, "2026-10-29", 54.5)];

/** What tm_cost_rates answers for a job without a sheet: the store at its office on its day. */
const resolved = (rows: MoneyValueRow[], office: string, createdOn: string) =>
  new Map(
    CODES.map((c) => [
      c.code,
      resolveOfficeValue(
        rows,
        { book: "cost", item_key: c.code, measure: "cost_rate" },
        office,
        createdOn,
      )?.value ?? null,
    ]),
  );
const expense = (costs: Map<string, number | null>) =>
  tmJobCost(BILL, withJobCostRates(CODES, null, costs), {
    premiumLabor: 1,
    supplies: 1,
    equipment: 1,
    awaitingDavid: true,
  });

describe("a job's expense through the cost store", () => {
  it("an old job is unchanged by a new engine publish, to the cent", () => {
    const before = expense(resolved(SEED, NJ, "2026-01-15"));
    // 22 h × 52.80 = 1,161.60 labor; 2 × 80.00 = 160.00 materials → 1,321.60
    expect(before).toMatchObject({ labor: 1161.6, materials: 160, total: 1321.6 });
    const after = expense(resolved([...SEED, ...PUBLISH], NJ, "2026-01-15"));
    expect(after).toEqual(before);
  });

  it("a frozen sheet wins over the store, whatever is published", () => {
    const sheet = new Map<string, number | null>([
      ["SCL", 50],
      ["104", 80],
    ]);
    // 22 × 50.00 = 1,100.00 + 160.00 = 1,260.00 — before and after
    expect(expense(sheet).total).toBe(1260);
    const merged = withJobCostRates(
      CODES,
      resolved([...SEED, ...PUBLISH], NJ, "2026-10-30"),
      sheet,
    );
    expect(merged.find((c) => c.code === "SCL")?.costRate).toBe(50);
  });

  it("a job made after the publish costs the engine's figure at its office", () => {
    const fresh = expense(resolved([...SEED, ...PUBLISH], NJ, "2026-10-30"));
    // 22 × 54.50 = 1,199.00 + 160.00 = 1,359.00
    expect(fresh).toMatchObject({ labor: 1199, total: 1359 });
    const elsewhere = expense(resolved([...SEED, ...PUBLISH], "ny", "2026-10-30"));
    // NY takes the default: 22 × 49.50 = 1,089.00 + 160.00 = 1,249.00
    expect(elsewhere.total).toBe(1249);
  });
});
