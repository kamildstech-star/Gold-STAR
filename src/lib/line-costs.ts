import { supabase } from "@/integrations/supabase/client";

/**
 * The cost basis on a document line, and who may read it.
 *
 * Since 20260909100000_line_cost_policy, `estimate_lines` and `invoice_lines`
 * have NO table-level SELECT grant for `authenticated`; privileges are handed
 * out column by column, the way `estimate_catalog_items` (20260909090000) and
 * `profiles` are. `unit_cost` — what a line costs Gold Star — is the one
 * column left out. Three consequences every reader must respect:
 *
 *  - `select("*")`, or naming `unit_cost`, fails for EVERYONE with
 *    "permission denied for table estimate_lines" — Postgres names the table,
 *    not the column, which is what took profiles down on 2026-09-07. Always
 *    select `ESTIMATE_LINE_SELECT` / `INVOICE_LINE_SELECT`.
 *  - Cost is read through `estimate_line_costs(_estimate_id)` /
 *    `invoice_line_costs(_invoice_id)`, SECURITY DEFINER functions that
 *    answer only for holders of `job.view_costs` at the document's location
 *    (the same capability the UI gates money on via `useCan`) and return an
 *    empty set for anyone else. See `fetchEstimateLineCosts` /
 *    `fetchInvoiceLineCosts` / `mergeLineCosts`.
 *  - A line whose cost the viewer could not read carries `unit_cost: null`,
 *    never a fabricated 0. "Hidden" and "free" are different facts, and every
 *    margin that subtracts cost must show n/a for the first rather than 100%.
 *    This is the rule the running-cost panel already follows (BACKLOG.md,
 *    "Job money panels contradicting each other").
 *
 * Writing cost is unchanged: the client may still insert or patch
 * `unit_cost`. When a line is added from the catalog the client no longer
 * copies the catalog cost (it may not be able to see it); a BEFORE INSERT
 * trigger fills `unit_cost` from `estimate_catalog_items.default_cost`
 * server-side whenever `catalog_item_id` is set and the cost arrives as
 * 0 or null.
 */

/** Columns of `estimate_lines` every signed-in user may read. */
export const ESTIMATE_LINE_PUBLIC_COLUMNS = [
  "id",
  "estimate_id",
  "scope_id",
  "catalog_item_id",
  "position",
  "code",
  "name",
  "short_name",
  "description",
  "uom",
  "quantity",
  "unit_price",
  "taxable",
  "is_discount",
  "note",
  "subtotal",
  "created_at",
  "updated_at",
] as const;

/** Columns of `invoice_lines` every signed-in user may read (no short_name). */
export const INVOICE_LINE_PUBLIC_COLUMNS = [
  "id",
  "invoice_id",
  "scope_id",
  "catalog_item_id",
  "position",
  "code",
  "name",
  "description",
  "uom",
  "quantity",
  "unit_price",
  "taxable",
  "is_discount",
  "note",
  "subtotal",
  "created_at",
  "updated_at",
] as const;

/*
 * The same lists as PostgREST column strings. Kept as literals (not a `join`)
 * so supabase-js can still infer the row type; a test pins each pair together.
 */
export const ESTIMATE_LINE_SELECT =
  "id, estimate_id, scope_id, catalog_item_id, position, code, name, short_name, description, uom, quantity, unit_price, taxable, is_discount, note, subtotal, created_at, updated_at";

export const INVOICE_LINE_SELECT =
  "id, invoice_id, scope_id, catalog_item_id, position, code, name, description, uom, quantity, unit_price, taxable, is_discount, note, subtotal, created_at, updated_at";

/** One row of `estimate_line_costs()` / `invoice_line_costs()`. */
export interface LineCostRow {
  line_id: string;
  unit_cost: number;
}

/** Cost basis per estimate line; empty for viewers without `job.view_costs`. */
export async function fetchEstimateLineCosts(estimateId: string): Promise<LineCostRow[]> {
  const { data, error } = await supabase.rpc("estimate_line_costs", { _estimate_id: estimateId });
  if (error) throw error;
  return (data ?? []) as LineCostRow[];
}

/** Cost basis per invoice line; empty for viewers without `job.view_costs`. */
export async function fetchInvoiceLineCosts(invoiceId: string): Promise<LineCostRow[]> {
  const { data, error } = await supabase.rpc("invoice_line_costs", { _invoice_id: invoiceId });
  if (error) throw error;
  return (data ?? []) as LineCostRow[];
}

/**
 * Attach costs to public line rows. Lines without a cost row (no privilege,
 * RPC not called, line added since) get `unit_cost: null` rather than a
 * fabricated zero, so a screen can tell "hidden" from "free".
 */
export function mergeLineCosts<T extends { id: string }>(
  lines: readonly T[],
  costs: readonly LineCostRow[] | null | undefined,
): (T & { unit_cost: number | null })[] {
  const byId = new Map<string, number>();
  for (const c of costs ?? []) byId.set(c.line_id, Number(c.unit_cost));
  return lines.map((l) => ({ ...l, unit_cost: byId.get(l.id) ?? null }));
}

/**
 * Extended cost of a line — quantity times unit cost — or `null` when the
 * unit cost was withheld. A null never reaches arithmetic as a 0.
 */
export function lineExtendedCost(line: {
  unit_cost: number | null | undefined;
  quantity: number | string | null | undefined;
}): number | null {
  if (line.unit_cost == null) return null;
  return Number(line.unit_cost) * Number(line.quantity ?? 0);
}

/**
 * Margin as a whole percentage of the amount, or `null` when there is no
 * margin to state: the cost is hidden, or the amount is not positive.
 */
export function lineMarginPercent(amount: number, cost: number | null): number | null {
  if (cost == null || !(amount > 0)) return null;
  return Math.round(((amount - cost) / amount) * 100);
}
