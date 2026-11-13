import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { roundMoney } from "@/lib/money";
import { TONE } from "@/lib/tone";

/**
 * Estimates are the customer-facing scope of work: what we intend to do,
 * broken into scopes (a trade plus a room), each scope a set of catalog lines.
 *
 * Two rules the rest of the app depends on:
 *  - Numbering is per job. The first estimate on a job is ESTIMATE-1 whatever
 *    else exists in the system, so a job with three revisions reads 1/2/3.
 *  - Totals are computed in the database from the lines, never in the client.
 *    A trigger recalculates subtotal/tax/total on every line change, so two
 *    people editing the same estimate can never disagree about the number.
 */

export type EstimateStatus = Database["public"]["Enums"]["estimate_status"];

export const ESTIMATE_STATUSES: EstimateStatus[] = ["draft", "sent", "approved", "declined"];

export const ESTIMATE_STATUS_LABEL: Record<EstimateStatus, string> = {
  draft: "Draft",
  sent: "Sent",
  approved: "Approved",
  declined: "Declined",
};

export const ESTIMATE_STATUS_TONE: Record<EstimateStatus, string> = {
  draft: TONE.neutral,
  sent: TONE.info,
  approved: TONE.success,
  declined: TONE.danger,
};

/** Units of measure offered on a line. Free text is still allowed. */
export const UOMS = ["EA", "HR", "DAY", "WK", "MO", "SF", "LF", "SY", "CY", "GAL", "LS"] as const;

export function estimateLabel(seq: number | null | undefined) {
  return `ESTIMATE-${seq ?? 1}`;
}

export function fmtMoney(n: number | null | undefined) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(Number(n ?? 0));
}

/**
 * A quantity is a count of things, not a price. The calculator preview prints
 * whatever the box is worth, and over a Qty box `fmtMoney` would render three
 * square feet as "$3.00", so quantities get the plain number instead.
 *
 * Rounded to the two decimals `estimate_lines.quantity` actually stores, and
 * with trailing zeros dropped, so a whole number reads as "55" rather than
 * "55.00" and 10/3 reads as the 3.33 that will be saved.
 */
export function fmtQuantity(n: number | null | undefined) {
  return String(round2(Number(n ?? 0)));
}

export function num(v: unknown, fallback = 0) {
  const n = typeof v === "number" ? v : Number.parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : fallback;
}

export interface EstimateRow {
  id: string;
  job_id: string;
  location_id: string;
  seq: number;
  status: EstimateStatus;
  title: string | null;
  call_date: string | null;
  estimate_date: string;
  job_number: string | null;
  customer_name: string | null;
  address: string | null;
  locality: string | null;
  region: string | null;
  postal_code: string | null;
  subtotal: number;
  tax: number;
  total: number;
  tax_rate: number;
  created_at: string;
}

export interface CatalogHeader {
  id: string;
  code: string;
  name: string;
  sort_order: number;
  is_active: boolean;
}

/**
 * Columns of `estimate_catalog_items` that every signed-in user may read.
 *
 * Since 20260909090000_estimate_catalog_cost_policy the table has NO
 * table-level SELECT grant for `authenticated`; privileges are handed out
 * column by column, exactly as `public.profiles` is. `default_cost` (what an
 * item costs Gold Star) is the one column left out. Two consequences every
 * reader of this table must respect:
 *
 *  - `select("*")`, or naming `default_cost`, fails for EVERYONE with
 *    "permission denied for table estimate_catalog_items" — Postgres names the
 *    table, not the column, which is what took profiles down on 2026-09-07.
 *    Always select `CATALOG_ITEM_SELECT`.
 *  - Cost is read through the `estimate_catalog_item_costs()` RPC, which
 *    answers only for holders of `job.view_costs` (the same capability the UI
 *    gates money on via `useCan`) and returns an empty set for anyone else.
 *    See `fetchCatalogCosts` / `mergeCatalogCosts`.
 */
export const CATALOG_ITEM_PUBLIC_COLUMNS = [
  "id",
  "header_id",
  "code",
  "name",
  "description",
  "uom",
  "default_unit_price",
  "taxable",
  "is_active",
  "sort_order",
] as const;

/**
 * The same list as one PostgREST column string. Kept as a literal (not a
 * `join`) so supabase-js can still infer the row type; a test pins the two
 * together.
 */
export const CATALOG_ITEM_SELECT =
  "id, header_id, code, name, description, uom, default_unit_price, taxable, is_active, sort_order";

export interface CatalogItem {
  id: string;
  header_id: string | null;
  code: string;
  name: string;
  description: string | null;
  uom: string;
  default_unit_price: number;
  /** `null` when the viewer does not hold `job.view_costs` — "cost hidden". */
  default_cost: number | null;
  taxable: boolean;
  is_active: boolean;
  sort_order: number;
}

/** A catalog row as read straight from the table: everything but cost. */
export type CatalogItemPublic = Omit<CatalogItem, "default_cost">;

/** One row of `estimate_catalog_item_costs()`. */
export interface CatalogCostRow {
  id: string;
  default_cost: number;
}

/**
 * Attach costs to public catalog rows. Items without a cost row (no
 * privilege, RPC unavailable, item added since) get `default_cost: null`
 * rather than a fabricated zero, so screens can tell "hidden" from "free".
 */
export function mergeCatalogCosts(
  items: readonly CatalogItemPublic[],
  costs: readonly CatalogCostRow[] | null | undefined,
): CatalogItem[] {
  const byId = new Map<string, number>();
  for (const c of costs ?? []) byId.set(c.id, num(c.default_cost));
  return items.map((it) => ({ ...it, default_cost: byId.get(it.id) ?? null }));
}

/** Cost basis per catalog item; empty for viewers without `job.view_costs`. */
export async function fetchCatalogCosts(): Promise<CatalogCostRow[]> {
  const { data, error } = await supabase.rpc("estimate_catalog_item_costs");
  if (error) throw error;
  return (data ?? []) as CatalogCostRow[];
}

export interface EstimateScope {
  id: string;
  estimate_id: string;
  name: string;
  room_name: string | null;
  notes: string | null;
  position: number;
}

export interface EstimateLine {
  id: string;
  estimate_id: string;
  scope_id: string | null;
  catalog_item_id: string | null;
  position: number;
  code: string | null;
  name: string;
  description: string | null;
  uom: string;
  quantity: number;
  /**
   * `null` when the viewer does not hold `job.view_costs` — "cost hidden".
   * The column is not SELECT-granted; see src/lib/line-costs.ts.
   */
  unit_cost: number | null;
  unit_price: number;
  taxable: boolean;
  is_discount: boolean;
  note: string | null;
  subtotal: number;
}

/**
 * Tax on a line only counts when the line is flagged taxable. A discount row is
 * flagged taxable on purpose — its negative subtotal is what pulls the taxable
 * base down — but it is never drawn as a line, so it never prints its own tax.
 */
export function lineTax(line: DiscountLine, rate: number) {
  if (!line.taxable) return 0;
  return round2(num(line.subtotal) * rate);
}

export function lineTotal(line: DiscountLine, rate: number) {
  return round2(num(line.subtotal) + lineTax(line, rate));
}

/*
 * A discount is not a line item. It is a deduction taken off the scope
 * subtotal, and it must never sort among the work or be dragged into the
 * ordering. It lives in the lines table only because there is nowhere else to
 * put it without a migration, flagged `is_discount`.
 *
 * Encoding, using the columns that already exist:
 *   fixed amount   code null          unit_price = -amount
 *   percentage     code "PCT:12.5"    unit_price = -(base x 12.5%)
 * `quantity` stays 1 either way. `subtotal` is generated in the database as
 * quantity * unit_price and every stored total is summed from it, so the
 * resolved dollars have to sit in `unit_price` whatever was typed; the percent
 * is bookkeeping the client re-resolves whenever the base moves. Rows written
 * before percentages existed carry no code and read as fixed amounts, which is
 * why the reader never assumes a code is there.
 *
 * A discount can also be aimed at particular lines instead of the whole job:
 *   targets       description "LN:<uuid>,<uuid>"
 * `code` is already spoken for by PCT: and `note` is the reason the customer
 * reads on the printed document, so neither can carry a machine list. A
 * discount row's `description` is the one field nothing renders — the row is
 * drawn from name/percent/note in both editors and both PDFs — which makes it
 * the only free column short of a migration. No marker means the whole
 * document: a row written before targeting existed still reads as untargeted,
 * and on a single-scope estimate — which is what most of them are — resolves
 * to the money it always did.
 */
const DISCOUNT_PCT = "PCT:";
const DISCOUNT_TARGETS = "LN:";

/** The fields the discount helpers need — an estimate line or an invoice line. */
/*
 * Deliberately structural rather than the full EstimateLine: the PDF builders
 * read rows straight off the query, where the generated `subtotal` column is
 * nullable. num() already treats null as zero.
 */
export type DiscountLine = Omit<
  Pick<
    EstimateLine,
    "name" | "code" | "description" | "note" | "quantity" | "unit_price" | "taxable" | "is_discount"
  >,
  "subtotal"
> & { subtotal: number | null };

/** A line a discount can be pointed at — anything the target list can name. */
export type TargetableLine = DiscountLine & { id: string };

/** Work and discounts never mix, so every caller splits them at the door. */
export function splitDiscounts<T extends { is_discount: boolean }>(lines: T[]) {
  return {
    items: lines.filter((l) => !l.is_discount),
    discounts: lines.filter((l) => l.is_discount),
  };
}

/** Percent off, or null when the row is a flat dollar amount. */
export function discountPercent(line: DiscountLine): number | null {
  const pct = line.code?.startsWith(DISCOUNT_PCT)
    ? Number.parseFloat(line.code.slice(DISCOUNT_PCT.length))
    : Number.NaN;
  return Number.isFinite(pct) ? pct : null;
}

export function discountCode(percent: number | null) {
  return percent == null ? null : `${DISCOUNT_PCT}${percent}`;
}

/** Dollars off, always positive — stored rows carry it as a negative price. */
export function discountAmount(line: DiscountLine) {
  return round2(Math.abs(num(line.subtotal)));
}

/** What a discount is worth against the base it applies to, right now. */
export function discountFor(line: DiscountLine, base: number) {
  const pct = discountPercent(line);
  return pct == null ? discountAmount(line) : round2((base * pct) / 100);
}

/** Discount rows always store the resolved dollars as a negative unit price. */
export function discountUnitPrice(amount: number) {
  return -round2(Math.abs(amount));
}

/** True once a discount has been aimed at particular lines. */
export function discountIsTargeted(line: DiscountLine) {
  return (line.description ?? "").startsWith(DISCOUNT_TARGETS);
}

/** The line ids a discount covers; empty for a whole-scope discount. */
export function discountTargets(line: DiscountLine): string[] {
  if (!discountIsTargeted(line)) return [];
  return (line.description ?? "")
    .slice(DISCOUNT_TARGETS.length)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** What to store in `description`. No ids means the whole scope, i.e. no marker. */
export function discountTargetMark(ids: string[]) {
  return ids.length ? `${DISCOUNT_TARGETS}${ids.join(",")}` : null;
}

/** The chosen lines that are still on the document, in document order. */
export function discountTargetLines<T extends TargetableLine>(line: DiscountLine, all: T[]) {
  const ids = new Set(discountTargets(line));
  return splitDiscounts(all).items.filter((l) => ids.has(l.id));
}

/**
 * The money a discount measures itself against: its chosen lines, or the whole
 * document when it has none. Ids that no longer match a line are simply absent
 * from the sum, so deleting a covered line takes its share of the discount with
 * it instead of leaving the customer credited for work that was dropped.
 *
 * `all` is every work line on the estimate or invoice, not the lines of the
 * scope the discount happens to sit in. An untargeted discount is "a dollar
 * off or a percentage off the whole invoice", and a scope is only where the
 * row was typed: measured against its own scope, 10% off a job with the
 * discount parked in an empty scope came to nothing at all. Targeted
 * discounts filter by id, so the wider array is a superset and resolves them
 * to exactly the same money.
 */
export function discountBase(line: DiscountLine, all: TargetableLine[]) {
  if (!discountIsTargeted(line)) return scopeSubtotal(all);
  return round2(discountTargetLines(line, all).reduce((s, l) => s + num(l.subtotal), 0));
}

/**
 * What a discount is worth right now against the money it covers, never more
 * than that money. A targeted flat amount has to come down when its lines
 * shrink or are deleted, or a $500 discount would outlive the $500 of work it
 * was granted on; an untargeted one is capped at the document for the same
 * reason, because $5,000 off $800 of work is a negative invoice. The cap is
 * per discount — two of them can still be written to overshoot together, and
 * that is a decision someone made twice rather than an arithmetic accident.
 */
export function discountResolved(line: DiscountLine, all: TargetableLine[]) {
  const base = discountBase(line, all);
  return round2(Math.min(discountFor(line, base), Math.max(base, 0)));
}

export function discountLabel(line: DiscountLine, all: TargetableLine[] = []) {
  const pct = discountPercent(line);
  let head = `${line.name || "Discount"}${pct == null ? "" : ` (${pct}%)`}`;
  // A deduction the reader cannot tie to anything is the thing to avoid, so a
  // targeted discount names its lines rather than floating in the totals stack.
  if (discountIsTargeted(line)) {
    const names = discountTargetLines(line, all).map((l) => l.name);
    const shown = names.slice(0, 3).join(", ");
    const more = names.length > 3 ? ` +${names.length - 3} more` : "";
    head += names.length ? ` on ${shown}${more}` : " on removed line items";
  }
  const reason = line.note?.trim();
  return reason ? `${head} — ${reason}` : head;
}

/**
 * What the customer is allowed to see.
 *
 * The internal label names the lines a discount covers and the reason it was
 * given, and neither belongs on the document: a customer who can see that one
 * item was cut 30% will ask why the others were not, and the reason is a note
 * to ourselves. They get the deduction and the amount, nothing else.
 *
 * The percentage goes too, but only on a targeted discount — 10% off one line
 * is not 10% off the estimate, so printing it beside a total-line deduction
 * would be a figure that does not divide into anything on the page. A
 * whole-document percentage is taken off the gross work and does reconcile,
 * so it stays.
 */
export function discountPublicLabel(line: DiscountLine) {
  const name = line.name?.trim() || "Discount";
  const pct = discountPercent(line);
  return pct == null || discountIsTargeted(line) ? name : `${name} (${pct}%)`;
}

/**
 * Where a discount belongs on the printed document.
 *
 * A discount aimed at particular lines is part of the work: it reads as a
 * credit inside the scope it came off, and a scope whose header total is lower
 * than the rows beneath it is a document the customer has to argue with. A
 * whole-document discount has no scope to sit in, so it stays a deduction
 * under the subtotal.
 *
 * Either way a discount worth nothing prints nowhere — a "-$0.00" row is a
 * question with no answer.
 */
export function discountPrintsInline(line: DiscountLine) {
  return discountIsTargeted(line) && discountAmount(line) > 0;
}

/** The complement: whole-document discounts, which print in the totals stack. */
export function discountPrintsInTotals(line: DiscountLine) {
  return !discountIsTargeted(line) && discountAmount(line) > 0;
}

/**
 * A discount reduces the taxable base rather than being taxed on top: the row
 * is written taxable so the database subtracts it inside its
 * SUM(subtotal) FILTER (WHERE taxable). With no taxable work to reduce it goes
 * the other way, or a discount on an exempt job would mint negative tax.
 */
export function discountIsTaxable(lines: DiscountLine[]) {
  return splitDiscounts(lines).items.some((l) => l.taxable && num(l.subtotal) > 0);
}

/**
 * The flag one discount row is written with. It follows the work it reduces —
 * the lines it targets, or the whole document when it targets none — because
 * that is the base it was measured against. Reading it off the surrounding
 * scope instead would write a document-level discount on an empty scope as
 * non-taxable and leave the tax on the full job.
 */
export function discountTaxable(line: DiscountLine, all: TargetableLine[]) {
  return discountIsTaxable(discountIsTargeted(line) ? discountTargetLines(line, all) : all);
}

/** Gross work in a scope, before any discount. */
export function scopeSubtotal(lines: DiscountLine[]) {
  return round2(splitDiscounts(lines).items.reduce((s, l) => s + num(l.subtotal), 0));
}

/**
 * Dollars a scope's own discounts take off, positive — only the ones aimed at
 * lines inside it. A document-level discount is measured against the whole
 * job and is deducted once, in the document totals, so counting it against
 * the scope that happens to hold the row would print a scope worth less than
 * the work listed under it and deduct the same money twice on the page.
 */
export function scopeDiscount(lines: DiscountLine[]) {
  return round2(
    splitDiscounts(lines)
      .discounts.filter(discountIsTargeted)
      .reduce((s, l) => s + discountAmount(l), 0),
  );
}

/** What a scope is worth: its work, less the discounts taken off that work. */
export function scopeTotal(lines: DiscountLine[]) {
  return round2(scopeSubtotal(lines) - scopeDiscount(lines));
}

// The evaluator lives in formula.ts so a UI box can use it without this
// module's database client; re-exported so every import of it keeps working.
export { evalExpression, normalizeFormulaSymbols } from "./formula";

/** Dollars to the cent: src/lib/money.ts's one rule (half away from zero). */
export function round2(n: number) {
  return roundMoney(n);
}

/** Admin-configured sales tax rate, stored alongside the other app settings. */
export async function fetchDefaultTaxRate(): Promise<number> {
  const { data, error } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "estimates")
    .maybeSingle();
  if (error) throw error;
  const value = data?.value as { tax_rate?: number } | null;
  return num(value?.tax_rate, 0);
}

export async function saveDefaultTaxRate(rate: number) {
  const { error } = await supabase
    .from("app_settings")
    .upsert({ key: "estimates", value: { tax_rate: rate } }, { onConflict: "key" });
  if (error) throw error;
}

export interface JobPrefill {
  id: string;
  job_number: string;
  location_id: string;
  customer_name: string | null;
  account_id: string | null;
  address: string | null;
  address_line2: string | null;
  locality: string | null;
  region: string | null;
  postal_code: string | null;
  call_date: string | null;
}

/**
 * Creates an estimate off a job, snapshotting the customer, the property
 * address and the office block of the job's branch. Snapshots because a
 * printed estimate must not silently change when someone edits the job later.
 */
export async function createEstimateFromJob(job: JobPrefill, userId: string) {
  const [{ data: loc, error: locErr }, rate] = await Promise.all([
    supabase
      .from("locations")
      .select("name, address, locality, region, postal_code, office_phone, office_email")
      .eq("id", job.location_id)
      .maybeSingle(),
    fetchDefaultTaxRate(),
  ]);
  if (locErr) throw locErr;

  const officeAddress = [loc?.address, loc?.locality, loc?.region, loc?.postal_code]
    .filter(Boolean)
    .join(", ");

  const { data, error } = await supabase
    .from("estimates")
    .insert({
      job_id: job.id,
      location_id: job.location_id,
      created_by: userId,
      status: "draft",
      call_date: job.call_date,
      estimate_date: new Date().toISOString().slice(0, 10),
      job_number: job.job_number,
      customer_name: job.customer_name,
      account_id: job.account_id,
      address: job.address,
      address_line2: job.address_line2,
      locality: job.locality,
      region: job.region,
      postal_code: job.postal_code,
      office_name: loc?.name ?? null,
      office_phone: loc?.office_phone ?? null,
      office_email: loc?.office_email ?? null,
      office_address: officeAddress || null,
      tax_rate: rate,
    })
    .select("id, seq")
    .single();
  if (error) throw error;
  return data;
}

/** Turns a saved scope template into real lines on a scope. */
export async function applyScopeTemplate(
  templateId: string,
  estimateId: string,
  scopeId: string,
  startPosition: number,
) {
  const { data: lines, error } = await supabase
    .from("estimate_scope_template_lines")
    .select(
      "catalog_item_id, code, name, description, uom, quantity, unit_cost, unit_price, taxable, position",
    )
    .eq("template_id", templateId)
    .order("position");
  if (error) throw error;
  if (!lines?.length) return 0;

  const { error: insErr } = await supabase.from("estimate_lines").insert(
    lines.map((l, i) => ({
      estimate_id: estimateId,
      scope_id: scopeId,
      catalog_item_id: l.catalog_item_id,
      code: l.code,
      name: l.name,
      description: l.description,
      uom: l.uom,
      quantity: l.quantity,
      unit_cost: l.unit_cost,
      unit_price: l.unit_price,
      taxable: l.taxable,
      position: startPosition + i,
    })),
  );
  if (insErr) throw insErr;
  return lines.length;
}

/**
 * Saves the current line set of a scope so the next job can reuse it. Discounts
 * are left behind: a give-away was negotiated for one job, and the template has
 * no is_discount column to carry it as anything but a negative work line.
 */
export async function saveScopeAsTemplate(
  name: string,
  scopeLines: EstimateLine[],
  userId: string,
  locationId: string | null,
) {
  const lines = splitDiscounts(scopeLines).items;

  const { data: tpl, error } = await supabase
    .from("estimate_scope_templates")
    .insert({ name, created_by: userId, location_id: locationId })
    .select("id")
    .single();
  if (error) throw error;

  if (lines.length) {
    const { error: linesErr } = await supabase.from("estimate_scope_template_lines").insert(
      lines.map((l, i) => ({
        template_id: tpl.id,
        catalog_item_id: l.catalog_item_id,
        code: l.code,
        name: l.name,
        description: l.description,
        uom: l.uom,
        quantity: l.quantity,
        // A hidden cost cannot travel onto the template; it lands as 0 and
        // the fill trigger re-costs catalog lines when the template is applied.
        unit_cost: l.unit_cost ?? 0,
        unit_price: l.unit_price,
        taxable: l.taxable,
        position: i,
      })),
    );
    if (linesErr) throw linesErr;
  }
  return tpl.id;
}
