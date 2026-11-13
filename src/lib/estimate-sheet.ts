/**
 * The estimate as a SHEET — the catalogue laid out like David's Job Calculator,
 * one quantity box per rate, instead of a table you build row by row.
 *
 * Mark: "job calculator he likes better than the current estimate system can
 * we copy that style and add custom line item options".
 *
 * Why the calculator feels faster: it is a fixed sheet. Every rate is already
 * on the page, there is nothing to add, and the only thing anyone types is a
 * quantity. The estimate editor is a table that starts empty — add a row, pick
 * it from the catalogue, then price it — so the same twelve lines are twelve
 * trips through a picker. The speed comes precisely from the calculator not
 * being customizable, which is why "copy that style AND add custom line items"
 * is a design question rather than a reskin.
 *
 * How it is resolved here: the sheet is a second PRESENTATION of the same
 * `estimate_lines`, not a second data model. Every active catalogue item is a
 * row whose quantity box is bound to the estimate line carrying that
 * `catalog_item_id` in the chosen scope — typing 3 inserts the line, typing 0
 * deletes it, anything else patches `quantity`. Lines the sheet cannot bind to
 * a catalogue row (no `catalog_item_id`, a retired item, a second copy of the
 * same item) are listed underneath as custom lines, fully editable in place.
 * Nothing about the table, the PDF, the invoice conversion, discounts, tax or
 * price-list resolution changes: the sheet writes the same rows the table
 * writes, and switching views shows the same estimate.
 *
 * The calculator's own data (`job_calculations`) is untouched and separate.
 *
 * Fees: the catalogue has no fees concept and `estimate_lines` has no column
 * that could mark one, so the calculator's Garbage / Miscellaneous become
 * custom lines added from a preset — a lump-sum line named for the fee whose
 * price is the amount. Nothing new to store; nothing the table cannot show.
 */
import * as React from "react";

import { supabase } from "@/integrations/supabase/client";
import {
  discountAmount,
  num,
  round2,
  scopeSubtotal,
  splitDiscounts,
  type CatalogHeader,
  type CatalogItemPublic,
  type DiscountLine,
  type EstimateLine,
} from "@/lib/estimates";
import { resolveCatalogPrice, type PriceBook, type ResolvedPrice } from "@/lib/price-lists";

/* ------------------------------------------------------- view preference */

export const ESTIMATE_VIEWS = ["table", "sheet"] as const;
export type EstimateView = (typeof ESTIMATE_VIEWS)[number];

/**
 * Its own row in `user_view_prefs`, the same table and shape as the card
 * density and the pipeline view, so a rep who works in the sheet gets the
 * sheet on the next estimate and the next machine. The default is the table
 * everybody already knows: nobody who never touches the switch notices it.
 */
export const ESTIMATE_VIEW_SCOPE = "estimate_editor_view";
export const DEFAULT_ESTIMATE_VIEW: EstimateView = "table";

/** Anything that is not one of the two is the table. */
export function parseEstimateView(raw: string | null | undefined): EstimateView {
  return (ESTIMATE_VIEWS as readonly string[]).includes(raw ?? "")
    ? (raw as EstimateView)
    : DEFAULT_ESTIMATE_VIEW;
}

export async function loadEstimateView(userId: string): Promise<EstimateView> {
  const { data } = await supabase
    .from("user_view_prefs")
    .select("view_mode")
    .eq("user_id", userId)
    .eq("scope", ESTIMATE_VIEW_SCOPE)
    .maybeSingle();
  return parseEstimateView(data?.view_mode);
}

export async function saveEstimateView(userId: string, view: EstimateView): Promise<void> {
  const { error } = await supabase.from("user_view_prefs").upsert(
    {
      user_id: userId,
      scope: ESTIMATE_VIEW_SCOPE,
      view_mode: view,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,scope" },
  );
  if (error) throw error;
}

/**
 * The person's view, read once and written on every change. A failed read
 * leaves the default and a failed write says nothing — the editor in front of
 * them has already switched, exactly as the card density behaves.
 */
export function useEstimateView(
  userId: string | null | undefined,
  persistEnabled = true,
): { view: EstimateView; setView: (v: EstimateView) => void } {
  const [view, setLocal] = React.useState<EstimateView>(DEFAULT_ESTIMATE_VIEW);

  React.useEffect(() => {
    let cancelled = false;
    if (!userId) return;
    loadEstimateView(userId)
      .then((v) => {
        if (!cancelled) setLocal(v);
      })
      .catch(() => {
        /* the default is a fine answer */
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const setView = React.useCallback(
    (v: EstimateView) => {
      setLocal(v);
      if (!userId || !persistEnabled) return;
      void saveEstimateView(userId, v).catch(() => {
        /* see above */
      });
    },
    [userId, persistEnabled],
  );

  return { view, setView };
}

/* ---------------------------------------------------------------- rows */

/** A catalogue rate on the sheet, bound to the line that carries it (if any). */
export interface SheetCatalogRow {
  item: CatalogItemPublic;
  /** The estimate line for this item in the chosen scope, or null if none yet. */
  line: EstimateLine | null;
  /** What the box shows: the line's quantity, or 0 for an item not on the estimate. */
  quantity: number;
  /**
   * The price a NEW line would be written with — resolved for this document
   * through the same function the table's picker uses. A line already on the
   * estimate keeps the price it was written with (see `rowUnitPrice`).
   */
  price: ResolvedPrice;
}

export interface SheetSection {
  /** Header id, or `OTHER_SECTION_ID` for items with no active header. */
  id: string;
  name: string;
  rows: SheetCatalogRow[];
}

export const OTHER_SECTION_ID = "__other";
export const OTHER_SECTION_NAME = "Other items";

export interface Sheet {
  sections: SheetSection[];
  /**
   * Work lines in the scope the sheet could not bind to a catalogue row: ad hoc
   * lines, lines of a retired item, and a second line for an item that already
   * has one. Shown under the sections, editable in place. Discounts are not
   * here — they are deductions, edited in the table and listed in the totals.
   */
  custom: EstimateLine[];
}

/**
 * The price a row displays. A line already written holds the number the
 * customer may have been shown, and nothing rewrites a stored `unit_price` —
 * so the sheet shows that, and only an unbound row shows the resolved price
 * the line WOULD be written with.
 */
export function rowUnitPrice(row: SheetCatalogRow): number {
  return row.line ? round2(num(row.line.unit_price)) : row.price.unit_price;
}

/**
 * Lay the catalogue out as sections of rows and bind each row to its line.
 *
 * Binding is by `catalog_item_id`, first line in position order wins. The
 * sheet has one box per rate, so it can only speak for one line per item;
 * any further line for the same item is listed as custom rather than hidden,
 * because a line that exists on the estimate must be visible on the sheet.
 *
 * Only active items on active headers are laid out — a retired rate is not
 * offered — but a line written against a retired item stays visible as a
 * custom line for the same reason.
 */
export function buildSheet(args: {
  headers: readonly CatalogHeader[];
  items: readonly CatalogItemPublic[];
  /** The lines of ONE scope. Discounts are filtered out here. */
  lines: readonly EstimateLine[];
  book: PriceBook;
}): Sheet {
  const work = splitDiscounts([...args.lines])
    .items.slice()
    .sort(byPosition);
  const activeItems = args.items.filter((it) => it.is_active);

  const boundLine = new Map<string, EstimateLine>();
  const bound = new Set<string>();
  const offered = new Set(activeItems.map((it) => it.id));
  for (const line of work) {
    const itemId = line.catalog_item_id;
    if (!itemId || !offered.has(itemId) || boundLine.has(itemId)) continue;
    boundLine.set(itemId, line);
    bound.add(line.id);
  }

  const toRow = (item: CatalogItemPublic): SheetCatalogRow => {
    const line = boundLine.get(item.id) ?? null;
    return {
      item,
      line,
      quantity: line ? round2(num(line.quantity)) : 0,
      // The one resolution path: customer > branch > state > catalogue, the
      // same call `EstimateLinePicker` and the table's insert make.
      price: resolveCatalogPrice(item, args.book),
    };
  };

  const activeHeaders = args.headers
    .filter((h) => h.is_active)
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order);
  const headerIds = new Set(activeHeaders.map((h) => h.id));
  const bySort = (a: CatalogItemPublic, b: CatalogItemPublic) =>
    a.sort_order - b.sort_order || a.name.localeCompare(b.name);

  const sections: SheetSection[] = [];
  for (const header of activeHeaders) {
    const rows = activeItems
      .filter((it) => it.header_id === header.id)
      .sort(bySort)
      .map(toRow);
    if (rows.length) sections.push({ id: header.id, name: header.name, rows });
  }
  const orphans = activeItems
    .filter((it) => !it.header_id || !headerIds.has(it.header_id))
    .sort(bySort)
    .map(toRow);
  if (orphans.length) {
    sections.push({ id: OTHER_SECTION_ID, name: OTHER_SECTION_NAME, rows: orphans });
  }

  return { sections, custom: work.filter((l) => !bound.has(l.id)) };
}

function byPosition(a: EstimateLine, b: EstimateLine) {
  return num(a.position) - num(b.position);
}

/** Every row on the sheet whose name or code contains the needle. */
export function filterSheet(sheet: Sheet, query: string): Sheet {
  const needle = query.trim().toLowerCase();
  if (!needle) return sheet;
  const hit = (s: string | null | undefined) => (s ?? "").toLowerCase().includes(needle);
  return {
    sections: sheet.sections
      .map((s) => ({
        ...s,
        rows: s.rows.filter((r) => hit(r.item.name) || hit(r.item.code) || hit(r.item.description)),
      }))
      .filter((s) => s.rows.length > 0),
    custom: sheet.custom.filter((l) => hit(l.name) || hit(l.code) || hit(l.description)),
  };
}

/* -------------------------------------------------------------- writes */

/** The insert for a catalogue line. Same columns the table's picker writes. */
export interface NewCatalogLine {
  estimate_id: string;
  scope_id: string;
  catalog_item_id: string;
  code: string;
  name: string;
  description: string | null;
  uom: string;
  quantity: number;
  unit_price: number;
  taxable: boolean;
  position: number;
}

/**
 * What one quantity typed into a catalogue row means for `estimate_lines`.
 *
 * `qty` is the committed number, null for an emptied box. Nothing below zero
 * is a quantity, so a negative reads as 0 and removes the line the same way
 * an emptied box does. A number equal to what is already stored is a no-op —
 * a blur is not an edit.
 */
export type SheetWrite =
  | { kind: "insert"; values: NewCatalogLine }
  | { kind: "update"; lineId: string; patch: { quantity: number } }
  | { kind: "remove"; lineId: string }
  | { kind: "none" };

export function quantityWrite(
  row: SheetCatalogRow,
  qty: number | null,
  ctx: { estimateId: string; scopeId: string; position: number },
): SheetWrite {
  const next = round2(Math.max(0, num(qty)));
  if (next === row.quantity) return { kind: "none" };
  if (row.line) {
    if (next <= 0) return { kind: "remove", lineId: row.line.id };
    return { kind: "update", lineId: row.line.id, patch: { quantity: next } };
  }
  if (next <= 0) return { kind: "none" };
  const it = row.item;
  return {
    kind: "insert",
    values: {
      estimate_id: ctx.estimateId,
      scope_id: ctx.scopeId,
      catalog_item_id: it.id,
      code: it.code,
      name: it.name,
      description: it.description,
      uom: it.uom,
      quantity: next,
      // unit_cost is deliberately not sent: `estimate_lines_fill_cost` copies
      // it from the catalogue server-side, for every user, exactly as it does
      // for a line added from the table's picker.
      unit_price: row.price.unit_price,
      taxable: it.taxable,
      position: ctx.position,
    },
  };
}

/** The presets the calculator's "Other fees" section offers. */
export const FEE_PRESETS = [
  { name: "Garbage", uom: "LS" },
  { name: "Miscellaneous", uom: "LS" },
] as const;

/**
 * The insert for a custom line. Same values the table's "Custom line" button
 * writes — no catalogue item and no code is what marks it ad hoc — with the
 * name and unit a fee preset supplies.
 */
export function customLineValues(ctx: {
  estimateId: string;
  scopeId: string;
  position: number;
  name?: string;
  uom?: string;
}) {
  return {
    estimate_id: ctx.estimateId,
    scope_id: ctx.scopeId,
    catalog_item_id: null,
    code: null,
    name: ctx.name ?? "Custom item",
    description: null,
    uom: ctx.uom ?? "EA",
    quantity: 1,
    unit_cost: 0,
    unit_price: 0,
    taxable: true,
    position: ctx.position,
  };
}

/**
 * Fractional digits a quantity box accepts. A count of units is whole; hours,
 * days, square feet and gallons are measured and take a fraction.
 */
export function quantityDecimals(uom: string | null | undefined): number {
  const u = (uom ?? "").trim().toUpperCase();
  return u === "EA" || u === "LS" || u === "EACH" || u === "SET" ? 0 : 2;
}

/* -------------------------------------------------------------- totals */

export interface SheetTotals {
  /** Gross work, before discounts — the table's "Subtotal" line. */
  subtotal: number;
  /** Whole-document deductions, positive, with the row they come from. */
  discounts: { line: DiscountLine & { id: string }; amount: number }[];
  tax: number;
  total: number;
}

/**
 * The running total, from the lines in hand rather than the header row, so
 * the bar moves the moment a quantity is committed instead of after the
 * refetch. Same arithmetic as `recalc_estimate_totals` in the database: tax
 * is the rate on the sum of taxable subtotals (discount rows included, which
 * is how a taxable discount pulls the base down), rounded once; the total is
 * the rounded net plus that tax. The table's Totals card reads the same
 * numbers back from the header once the trigger has run.
 */
export function sheetTotals(lines: readonly EstimateLine[], rate: number): SheetTotals {
  const all = [...lines];
  const net = round2(all.reduce((s, l) => s + num(l.subtotal), 0));
  const taxable = all.filter((l) => l.taxable).reduce((s, l) => s + num(l.subtotal), 0);
  const tax = round2(taxable * num(rate));
  return {
    subtotal: scopeSubtotal(all),
    discounts: splitDiscounts(all).discounts.map((line) => ({
      line,
      amount: discountAmount(line),
    })),
    tax,
    total: round2(net + tax),
  };
}
