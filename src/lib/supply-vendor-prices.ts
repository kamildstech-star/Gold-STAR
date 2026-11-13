/**
 * What each vendor charges for an item, and what an order line should cost.
 *
 * David, 22 Sep: "if there's two vendors that sell the same item, one guy
 * charges $9, the other guy charges $10, then we should be able to put it in
 * for each vendor and the system should automatically pick it up... so that
 * we can track spending properly." And: "I want it to be automatic really."
 *
 * TWO MEANINGS, KEPT APART. A price here is the expectation — what the line
 * should cost from the vendor it is going to. What was actually paid is a
 * `supply_purchases` row, and Spending reads only those. Nothing in this file
 * writes a purchase, and a purchase recorded at a different price leaves the
 * price list alone: the gap between the two is the thing worth seeing.
 *
 * No price on file is `null`, all the way to the screen — never a zero and
 * never a guess borrowed from another vendor, because an invented price is
 * exactly what would make the spending comparison lie.
 */

import { supabase } from "@/integrations/supabase/client";
import { isMissingSchema } from "@/lib/schema-fallback";
import {
  presetVendor,
  resolveLineVendor,
  type ResolvedVendor,
  type SupplyVendor,
} from "@/lib/supply-vendors";
import { roundMoney } from "@/lib/money";

export type VendorPrice = { item_id: string; vendor_id: string; unit_price: number };

/** item_id → vendor_id → unit price. */
export type PriceBook = Map<string, Map<string, number>>;

export function priceBook(rows: readonly VendorPrice[]): PriceBook {
  const book: PriceBook = new Map();
  for (const r of rows) {
    const price = Number(r.unit_price);
    if (!Number.isFinite(price)) continue;
    const byVendor = book.get(r.item_id) ?? new Map<string, number>();
    byVendor.set(r.vendor_id, price);
    book.set(r.item_id, byVendor);
  }
  return book;
}

/** The vendor's price for the item, or null when none is on file. */
export function vendorPriceFor(
  book: PriceBook,
  itemId: string | null | undefined,
  vendorId: string | null | undefined,
): number | null {
  if (!itemId || !vendorId) return null;
  return book.get(itemId)?.get(vendorId) ?? null;
}

export type LinePricing = {
  vendor: ResolvedVendor;
  /** Null: no vendor, a free-text line, or no price from that vendor. */
  unitPrice: number | null;
  total: number | null;
};

/** Dollars to the cent (named before money.ts existed). */
const cents = roundMoney;

/**
 * An order line priced from its vendor — the line's own choice, else the
 * item's preset — and nothing else.
 */
export function priceLine(
  line: { item_id: string | null; quantity: number | string; vendor_id?: string | null },
  item: object | null | undefined,
  vendors: readonly SupplyVendor[],
  book: PriceBook,
): LinePricing {
  const vendor = resolveLineVendor(line, item, vendors);
  const unitPrice = vendorPriceFor(book, line.item_id, vendor?.vendor.id);
  const qty = Number(line.quantity);
  return {
    vendor,
    unitPrice,
    total: unitPrice == null || !Number.isFinite(qty) ? null : cents(unitPrice * qty),
  };
}

/**
 * The order's expected total, and whether it is the whole order. A partial sum
 * is shown as one ("$42.00 for 3 of 4 lines"), never as the total.
 */
export function expectedOrderTotal(prices: readonly LinePricing[]): {
  total: number;
  priced: number;
  lines: number;
} {
  const priced = prices.filter((p) => p.total != null);
  return {
    total: cents(priced.reduce((s, p) => s + (p.total ?? 0), 0)),
    priced: priced.length,
    lines: prices.length,
  };
}

export async function listVendorPrices(): Promise<VendorPrice[]> {
  const { data, error } = await supabase
    .from("supply_item_vendor_prices" as never)
    .select("item_id, vendor_id, unit_price");
  if (error) {
    // Not migrated yet, or not allowed to see purchasing money: no prices,
    // which every screen already handles as "no price on file".
    if (isMissingSchema(error)) return [];
    throw error;
  }
  return (data ?? []) as unknown as VendorPrice[];
}

/** Set a vendor's price for an item; `null` removes it. */
export async function setVendorPrice(input: {
  itemId: string;
  vendorId: string;
  unitPrice: number | null;
  userId: string | null;
}): Promise<void> {
  const table = supabase.from("supply_item_vendor_prices" as never);
  if (input.unitPrice == null) {
    const { error } = await table
      .delete()
      .eq("item_id", input.itemId)
      .eq("vendor_id", input.vendorId);
    if (error) throw error;
    return;
  }
  if (!Number.isFinite(input.unitPrice) || input.unitPrice < 0) {
    throw new Error("A price cannot be negative.");
  }
  const { error } = await table.upsert(
    {
      item_id: input.itemId,
      vendor_id: input.vendorId,
      unit_price: cents(input.unitPrice),
      updated_by: input.userId,
      updated_at: new Date().toISOString(),
    } as never,
    { onConflict: "item_id,vendor_id" },
  );
  if (error) throw error;
}

export type VendorPriceRow = {
  vendor: SupplyVendor;
  price: number | null;
  usual: boolean;
};

export type VendorPriceSummary = {
  /** Every vendor, the item's usual one first, then in list order. */
  rows: VendorPriceRow[];
  /** How many vendors have a price on file for this item. */
  priced: number;
  /** The one-line label for the item's Prices button. */
  label: string;
};

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });

/**
 * One item's prices, folded to a label that fits on its catalog row.
 *
 * Mark, 13 Oct: "if he wants to put his price for a vendor on an item he wants
 * to have a way to input that." The label leads with the usual vendor's price
 * when there is one — that is the price an order picks up unless the line
 * chooses differently — else the lowest price on file. No price at all says
 * "Add a price", so the row reads as a place to type one rather than as
 * nothing.
 */
export function vendorPriceSummary(
  book: PriceBook,
  itemId: string,
  vendors: readonly SupplyVendor[],
  usualVendorId: string | null,
): VendorPriceSummary {
  const rows = vendors
    .map((vendor) => ({
      vendor,
      price: vendorPriceFor(book, itemId, vendor.id),
      usual: vendor.id === usualVendorId,
    }))
    .sort((a, b) => Number(b.usual) - Number(a.usual));
  const withPrice = rows.filter((r) => r.price != null);
  if (withPrice.length === 0) return { rows, priced: 0, label: "Add a price" };
  const lead =
    withPrice.find((r) => r.usual) ??
    withPrice.reduce((lo, r) => (r.price! < lo.price! ? r : lo), withPrice[0]);
  const more = withPrice.length - 1;
  return {
    rows,
    priced: withPrice.length,
    label: `${money(lead.price!)} at ${lead.vendor.name}${more > 0 ? ` · ${more} more` : ""}`,
  };
}

/* ------------------------------------------------------------------ */
/* The vendor-column grid (David, 13 Oct)                              */
/* ------------------------------------------------------------------ */

/** One cell of the grid: this item's price at this vendor. */
export type VendorGridCell = {
  vendorId: string;
  price: number | null;
  /** The item's preferred (usual) vendor — `supply_items.default_vendor_id`. */
  preferred: boolean;
  /** The lowest price on the row, when more than one vendor has one. */
  cheapest: boolean;
};

export type VendorGridRow = {
  itemId: string;
  label: string;
  preferredVendorId: string | null;
  cells: VendorGridCell[];
};

/**
 * David, 13 Oct: vendor pricing as a spreadsheet — one row per item, one
 * column per vendor, a price in each cell he types in, and one preferred
 * vendor per item.
 *
 * "Preferred" IS the item's usual vendor (`default_vendor_id`, set through
 * `setItemVendor`), not a second flag on the price row: every reader — the
 * order form's "usually X", `priceLine`, the vendor email — already follows
 * that one column, so a separate flag could only disagree with it.
 */
export function vendorPriceGrid(
  items: readonly (object & { id: string; name: string; size?: string | null })[],
  vendors: readonly SupplyVendor[],
  book: PriceBook,
): VendorGridRow[] {
  return items.map((item) => {
    const preferredVendorId = presetVendor(item, vendors)?.vendor.id ?? null;
    const prices = vendors.map((v) => vendorPriceFor(book, item.id, v.id));
    const known = prices.filter((p): p is number => p != null);
    const low = known.length > 1 ? Math.min(...known) : null;
    return {
      itemId: item.id,
      label: item.size?.trim() ? `${item.name} (${item.size.trim()})` : item.name,
      preferredVendorId,
      cells: vendors.map((v, i) => ({
        vendorId: v.id,
        price: prices[i] ?? null,
        preferred: v.id === preferredVendorId,
        cheapest: low != null && prices[i] === low,
      })),
    };
  });
}

/* ------------------------------------------------------------------ */
/* An order, broken down by vendor (David, 13 Oct)                     */
/* ------------------------------------------------------------------ */

export type VendorGroupLine<L> = { line: L; pricing: LinePricing };

export type VendorGroup<L> = {
  /** Null: lines with no vendor yet — they need one picked before ordering. */
  vendor: SupplyVendor | null;
  lines: VendorGroupLine<L>[];
  /** Expected subtotal for this vendor, from the prices known. */
  expected: ReturnType<typeof expectedOrderTotal>;
};

/**
 * Which lines of an order go to which vendor — the line's own vendor, else
 * the item's preferred one, exactly as the order detail prices them. Vendors
 * by name, "no vendor" last.
 *
 * READ-ONLY on purpose: vendor orders stay internal and manual (David, 13 Oct
 * — nothing is emailed to a vendor). This only shows who to call.
 */
export function groupLinesByVendor<
  L extends { item_id: string | null; quantity: number | string; vendor_id?: string | null },
>(
  lines: readonly L[],
  itemById: ReadonlyMap<string, object>,
  vendors: readonly SupplyVendor[],
  book: PriceBook,
): VendorGroup<L>[] {
  const byVendor = new Map<string, VendorGroup<L>>();
  for (const line of lines) {
    const item = line.item_id ? (itemById.get(line.item_id) ?? null) : null;
    const pricing = priceLine(line, item, vendors, book);
    const vendor = pricing.vendor?.vendor ?? null;
    const key = vendor?.id ?? "";
    const group = byVendor.get(key) ?? { vendor, lines: [], expected: expectedOrderTotal([]) };
    group.lines.push({ line, pricing });
    byVendor.set(key, group);
  }
  const groups = [...byVendor.values()].map((g) => ({
    ...g,
    expected: expectedOrderTotal(g.lines.map((l) => l.pricing)),
  }));
  return groups.sort((a, b) => {
    if (!a.vendor) return 1;
    if (!b.vendor) return -1;
    return a.vendor.name.localeCompare(b.vendor.name);
  });
}

/** "Jon-Don: 3 items · Home Depot: 1 item · No vendor: 1 item", for a queue row. */
export function vendorBreakdownText(groups: readonly VendorGroup<unknown>[]): string {
  return groups
    .map(
      (g) =>
        `${g.vendor?.name ?? "No vendor"}: ${g.lines.length} item${g.lines.length === 1 ? "" : "s"}`,
    )
    .join(" · ");
}
