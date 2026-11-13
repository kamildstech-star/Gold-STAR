/**
 * Job costing from the T&M data (TM7, 27 Oct): what the job COST Gold Star,
 * worked out from exactly what the T&M bill bills — the signed sign-in hours,
 * the field forms, the supply lists — at each code's internal cost rate
 * (Settings › T&M rate codes, or the job's own sheet), instead of its client
 * rate.
 *
 * INTERNAL ONLY. Nothing here is part of `TmBill`: the invoice lines, the
 * customer copy and the detail workbook are built from the bill alone and
 * cannot reach a cost. The loader reads cost rates through the cost RPCs,
 * which answer only finance or job.view_costs holders.
 *
 * MULTIPLIERS — A SEAM. David's job-ledger multiplier spreadsheet (per-day
 * multipliers on supplies and equipment) and the equipment cost spreadsheet
 * are not in yet. COST_MULTIPLIERS holds placeholders of 1, flagged
 * `awaitingDavid`, and the panel says so; drop the real figures in here.
 */
import type { ItemRow, LaborRow, PricedCode, TmBill } from "@/lib/tm-bill";
import { roundMoneyLoose } from "@/lib/money";

export const COST_MULTIPLIERS = Object.freeze({
  /** Cost of a premium (overtime / weekend) hour × the cost rate. Placeholder. */
  premiumLabor: 1,
  /** Per-day multiplier on supplies at cost. Placeholder. */
  supplies: 1,
  /** Per-day multiplier on equipment and vehicles at cost. Placeholder. */
  equipment: 1,
  /** True until David's multiplier spreadsheet replaces the placeholders. */
  awaitingDavid: true,
});

export type TmJobCost = {
  labor: number;
  materials: number;
  equipment: number;
  /** Third-party bills at cost (pass-through: their own amount). */
  passThrough: number;
  total: number;
  /** Codes used on the job with no cost rate entered — their cost counts as $0. */
  missingCost: string[];
  /** The multipliers are placeholders until David's spreadsheet is in. */
  provisional: boolean;
};

const round2 = roundMoneyLoose;

export function tmJobCost(
  bill: Pick<
    TmBill,
    | "labor"
    | "materials"
    | "equipment"
    | "vehicles"
    | "subcontractors"
    | "lodging"
    | "reimbursables"
  >,
  codes: readonly PricedCode[],
  multipliers = COST_MULTIPLIERS,
): TmJobCost {
  const cost = new Map(codes.map((c) => [c.code.toUpperCase(), c.costRate ?? null]));
  const missing = new Set<string>();
  const rate = (code: string): number => {
    const r = cost.get(code.toUpperCase());
    if (r == null) {
      if (code) missing.add(code);
      return 0;
    }
    return r;
  };
  const laborCost = (l: LaborRow) =>
    rate(l.code) * (l.regular + l.premium * multipliers.premiumLabor);
  const itemsCost = (rows: readonly ItemRow[], m: number) =>
    rows.reduce((s, r) => s + (r.code ? rate(r.code) * r.qty * m : 0), 0);
  // Pass-through lines are the receipt itself; their cost is the base amount.
  // (A "$" line at price ≥ 1 is the pass-through itself; the O&P line, at
  // price 0.2, is margin and has no cost.)
  const passThrough = [...bill.subcontractors, ...bill.lodging, ...bill.reimbursables]
    .filter((r) => r.unit === "$" && r.price >= 1)
    .reduce((s, r) => s + r.qty, 0);

  const labor = round2(bill.labor.reduce((s, l) => s + laborCost(l), 0));
  const materials = round2(itemsCost(bill.materials, multipliers.supplies));
  const equipment = round2(itemsCost([...bill.equipment, ...bill.vehicles], multipliers.equipment));
  const pass = round2(passThrough);
  return {
    labor,
    materials,
    equipment,
    passThrough: pass,
    total: round2(labor + materials + equipment + pass),
    missingCost: [...missing].sort(),
    provisional: multipliers.awaitingDavid,
  };
}

/** Billed − cost, and as a percent of billed (null when nothing is billed). */
export function tmMargin(billed: number, cost: number): { margin: number; pct: number | null } {
  const margin = round2(billed - cost);
  return { margin, pct: billed > 0 ? Math.round((margin / billed) * 1000) / 10 : null };
}
