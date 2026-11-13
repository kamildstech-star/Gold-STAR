/**
 * "This month we spent £X at supplier Y on item Z."
 *
 * David keeps that answer in a spreadsheet today, and wants it for purchasing
 * power: knowing that four locations each buy the same dehumidifier filter from
 * a different merchant at a different price is the whole point of asking.
 *
 * Pure. The rows come from `supply_purchases`; everything below is arithmetic
 * on them, so the totals a buyer will negotiate with can be tested without a
 * database.
 */

import type { SupplyPurchase } from "@/lib/supply-inventory";
import { roundMoneyLoose } from "@/lib/money";

const round2 = roundMoneyLoose;

/** The item's name, whatever survives: the catalogue's, or what was typed. */
export function purchaseItemName(p: SupplyPurchase): string {
  return p.item_name?.trim() || p.item_label?.trim() || "Unnamed item";
}

export type SpendGroup = {
  key: string;
  label: string;
  total: number;
  quantity: number;
  /** How many separate purchases make up the total. */
  purchases: number;
};

function group(
  rows: readonly SupplyPurchase[],
  keyOf: (p: SupplyPurchase) => string,
  labelOf: (p: SupplyPurchase) => string,
): SpendGroup[] {
  const acc = new Map<string, SpendGroup>();
  for (const p of rows) {
    const key = keyOf(p);
    const existing = acc.get(key) ?? {
      key,
      label: labelOf(p),
      total: 0,
      quantity: 0,
      purchases: 0,
    };
    existing.total += Number(p.total_cost) || 0;
    existing.quantity += Number(p.quantity) || 0;
    existing.purchases += 1;
    acc.set(key, existing);
  }
  return [...acc.values()]
    .map((g) => ({ ...g, total: round2(g.total), quantity: round2(g.quantity) }))
    .sort((a, b) => b.total - a.total);
}

/** Biggest spend first — the supplier worth a phone call is at the top. */
export function spendBySupplier(rows: readonly SupplyPurchase[]): SpendGroup[] {
  return group(
    rows,
    (p) => p.supplier_name.trim().toLowerCase(),
    (p) => p.supplier_name.trim(),
  );
}

export function spendByItem(rows: readonly SupplyPurchase[]): SpendGroup[] {
  return group(rows, (p) => p.item_id ?? purchaseItemName(p).toLowerCase(), purchaseItemName);
}

/** Oldest month first, so a trend reads left to right. */
export function spendByMonth(rows: readonly SupplyPurchase[]): SpendGroup[] {
  return group(
    rows,
    (p) => (p.purchased_on ?? "").slice(0, 7),
    (p) => (p.purchased_on ?? "").slice(0, 7),
  ).sort((a, b) => a.key.localeCompare(b.key));
}

export function spendTotal(rows: readonly SupplyPurchase[]): number {
  return round2(rows.reduce((sum, p) => sum + (Number(p.total_cost) || 0), 0));
}

export type ItemPriceSpread = {
  itemKey: string;
  itemName: string;
  suppliers: number;
  /** Cheapest and dearest unit price paid in the period. */
  low: number;
  high: number;
  /** Total quantity ÷ total spend, so a big order counts for more than a small one. */
  weightedAverage: number;
  /** What buying every unit at the lowest price would have saved. */
  potentialSaving: number;
};

/**
 * The same item bought at different prices — the purchasing-power question.
 *
 * Only items bought from more than one supplier appear: a single price is not a
 * comparison, and listing it would bury the handful of lines worth acting on.
 * The saving is deliberately the crude figure — every unit at the best price
 * seen — because it is an argument for a phone call, not a forecast.
 */
export function itemPriceSpread(rows: readonly SupplyPurchase[]): ItemPriceSpread[] {
  const byItem = new Map<
    string,
    { name: string; suppliers: Set<string>; qty: number; spend: number; low: number; high: number }
  >();

  for (const p of rows) {
    const unit = Number(p.unit_price) || 0;
    const qty = Number(p.quantity) || 0;
    if (qty <= 0) continue;
    const key = p.item_id ?? purchaseItemName(p).toLowerCase();
    const existing = byItem.get(key) ?? {
      name: purchaseItemName(p),
      suppliers: new Set<string>(),
      qty: 0,
      spend: 0,
      low: unit,
      high: unit,
    };
    existing.suppliers.add(p.supplier_name.trim().toLowerCase());
    existing.qty += qty;
    existing.spend += Number(p.total_cost) || 0;
    existing.low = Math.min(existing.low, unit);
    existing.high = Math.max(existing.high, unit);
    byItem.set(key, existing);
  }

  return [...byItem.entries()]
    .filter(([, v]) => v.suppliers.size > 1 && v.high > v.low)
    .map(([itemKey, v]) => ({
      itemKey,
      itemName: v.name,
      suppliers: v.suppliers.size,
      low: round2(v.low),
      high: round2(v.high),
      weightedAverage: round2(v.qty > 0 ? v.spend / v.qty : 0),
      potentialSaving: round2(Math.max(0, v.spend - v.qty * v.low)),
    }))
    .sort((a, b) => b.potentialSaving - a.potentialSaving);
}

/* ------------------------------------------------------------------ */
/* Catalogue import                                                    */
/* ------------------------------------------------------------------ */

/**
 * One row of the client's supply spreadsheet.
 *
 * David's sheet arrived on 18 Sep with four columns and no others: category,
 * description, size, case_qty. It carries **no SKU, no supplier and no price**,
 * so those fields stay empty — a supplier and a price are facts about a
 * purchase, not about an item, and the purchaser side already records them per
 * receipt. Nothing here invents one.
 *
 * `size` is a first-class column rather than something folded into the name,
 * because the sheet repeats a description across sizes — five Pleated Filter
 * Merv 8 rows, three Nitrile Gloves — and each size is separately orderable.
 *
 * `sku` is still the preferred key: with one, re-importing a corrected sheet
 * updates the rows it matches instead of creating a second set. Without one the
 * key is name **plus size**, matched case-insensitively, which is what the
 * catalogue's own unique index enforces.
 */
export type CatalogueImportRow = {
  name: string;
  /** Verbatim from the sheet — `2"x60 Yard`, `21x19x2`. Never parsed. */
  size?: string | null;
  unit?: string | null;
  category?: string | null;
  sku?: string | null;
  defaultSupplier?: string | null;
  /** What it normally costs. Used to pre-fill a purchase, never to price one. */
  unitCost?: number | null;
  sortOrder?: number | null;
};

/**
 * The key two sheet rows must not share.
 *
 * Exported because the catalogue's unique index has to agree with it: a plan
 * that accepts two rows the database will then reject is a failed import
 * halfway through.
 */
export function catalogueImportKey(row: Pick<CatalogueImportRow, "name" | "size" | "sku">): string {
  const sku = (row.sku ?? "").trim().toLowerCase();
  if (sku) return sku;
  return `${(row.name ?? "").trim().toLowerCase()}|${(row.size ?? "").trim().toLowerCase()}`;
}

export type CatalogueImportIssue = { row: number; problem: string };

export type CatalogueImportPlan = {
  rows: CatalogueImportRow[];
  issues: CatalogueImportIssue[];
};

/**
 * Clean a parsed sheet into rows worth writing, and say what was wrong with
 * the rest rather than dropping it silently — a catalogue that quietly loses
 * nine lines of a hundred is worse than one that refuses.
 */
export function planCatalogueImport(
  raw: readonly Partial<CatalogueImportRow>[],
): CatalogueImportPlan {
  const rows: CatalogueImportRow[] = [];
  const issues: CatalogueImportIssue[] = [];
  const seen = new Set<string>();

  raw.forEach((r, i) => {
    const line = i + 1;
    const name = (r.name ?? "").trim();
    if (!name) {
      issues.push({ row: line, problem: "No item name." });
      return;
    }
    const key = catalogueImportKey({ name, size: r.size, sku: r.sku });
    if (seen.has(key)) {
      issues.push({ row: line, problem: `Duplicate of an earlier row (${name}).` });
      return;
    }
    const cost = r.unitCost == null ? null : Number(r.unitCost);
    if (cost != null && (!Number.isFinite(cost) || cost < 0)) {
      issues.push({ row: line, problem: `Unit cost "${r.unitCost}" is not a price.` });
      return;
    }
    seen.add(key);
    rows.push({
      name,
      // Verbatim. "12 case" and "12 Case" both survive as typed: David's sheet
      // is the record of what he orders, and tidying his capitalisation into
      // invented structure would be a change nobody asked for.
      size: (r.size ?? "").trim() || null,
      unit: (r.unit ?? "").trim() || "each",
      category: (r.category ?? "").trim() || null,
      sku: (r.sku ?? "").trim() || null,
      defaultSupplier: (r.defaultSupplier ?? "").trim() || null,
      unitCost: cost,
      sortOrder: r.sortOrder == null ? null : Number(r.sortOrder),
    });
  });

  return { rows, issues };
}

/**
 * David's sheet has four columns; the catalogue has different ones. This is the
 * single place that says how one becomes the other.
 *
 *   category    -> category   (the request form's sections are these)
 *   description -> name
 *   size        -> size       (verbatim)
 *   case_qty    -> unit       (verbatim)
 *
 * `case_qty` becomes `unit` because it IS the unit you order in: nobody orders
 * one strip of duct tape, they order a 24 Case. Where the sheet leaves it blank
 * the catalogue's own default, "each", stands in — a NOT NULL column has to say
 * something, and "each" is the honest default rather than a guess at the pack.
 *
 * Category whitespace is collapsed, and only category: the sheet types
 * "General  / Cleaning Supplies" with a double space, and a card heading in the
 * order form would render the gap. Nothing else is touched.
 */
export type SupplySheetRow = {
  category?: string | null;
  description?: string | null;
  size?: string | null;
  case_qty?: string | null;
};

export function catalogueRowFromSheet(row: SupplySheetRow): Partial<CatalogueImportRow> {
  return {
    name: (row.description ?? "").trim(),
    size: (row.size ?? "").trim() || null,
    unit: (row.case_qty ?? "").trim() || "each",
    category: (row.category ?? "").replace(/\s+/g, " ").trim() || null,
    // Stated, not forgotten: the sheet has none of these three.
    sku: null,
    defaultSupplier: null,
    unitCost: null,
  };
}

/* ------------------------------------------------- purchase history (6 Nov) */

/**
 * David, 6 Nov: "I have tabs by each order — the order number, the supplier
 * and the total, then a breakdown of what was bought on that order. Then a
 * tab of how many rolls of duct tape we bought throughout the entire year,
 * the company on a whole and each location individually." These two shapes
 * are that spreadsheet, from the purchases the app already records.
 */
export type PurchaseOrder = {
  key: string;
  purchased_on: string;
  supplier: string;
  location: string;
  total: number;
  lines: SupplyPurchase[];
};

/** Purchases grouped into orders: one supplier, one day, one office. Newest first. */
export function purchaseOrders(rows: readonly SupplyPurchase[]): PurchaseOrder[] {
  const acc = new Map<string, PurchaseOrder>();
  for (const p of rows) {
    const location = p.location_name?.trim() || "—";
    const key = `${p.purchased_on}|${p.supplier_name.trim().toLowerCase()}|${p.location_id ?? location}`;
    const o = acc.get(key) ?? {
      key,
      purchased_on: p.purchased_on,
      supplier: p.supplier_name.trim() || "—",
      location,
      total: 0,
      lines: [],
    };
    o.total += Number(p.total_cost) || 0;
    o.lines.push(p);
    acc.set(key, o);
  }
  return [...acc.values()]
    .map((o) => ({ ...o, total: round2(o.total) }))
    .sort((a, b) =>
      a.purchased_on < b.purchased_on ? 1 : a.purchased_on > b.purchased_on ? -1 : 0,
    );
}

export type ItemHistory = {
  key: string;
  label: string;
  quantity: number;
  total: number;
  purchases: number;
  /** Per office: the same three figures. */
  byLocation: { location: string; quantity: number; total: number; purchases: number }[];
};

/** Each item's year (or window) in one row, with the split by office. Biggest spend first. */
export function itemHistory(rows: readonly SupplyPurchase[]): ItemHistory[] {
  const acc = new Map<
    string,
    ItemHistory & { locs: Map<string, ItemHistory["byLocation"][number]> }
  >();
  for (const p of rows) {
    const key = p.item_id ?? purchaseItemName(p).toLowerCase();
    const it = acc.get(key) ?? {
      key,
      label: purchaseItemName(p),
      quantity: 0,
      total: 0,
      purchases: 0,
      byLocation: [],
      locs: new Map(),
    };
    const qty = Number(p.quantity) || 0;
    const cost = Number(p.total_cost) || 0;
    it.quantity += qty;
    it.total += cost;
    it.purchases += 1;
    const location = p.location_name?.trim() || "—";
    const l = it.locs.get(location) ?? { location, quantity: 0, total: 0, purchases: 0 };
    l.quantity += qty;
    l.total += cost;
    l.purchases += 1;
    it.locs.set(location, l);
    acc.set(key, it);
  }
  return [...acc.values()]
    .map(({ locs, ...it }) => ({
      ...it,
      quantity: round2(it.quantity),
      total: round2(it.total),
      byLocation: [...locs.values()]
        .map((l) => ({ ...l, quantity: round2(l.quantity), total: round2(l.total) }))
        .sort((a, b) => b.total - a.total),
    }))
    .sort((a, b) => b.total - a.total);
}
