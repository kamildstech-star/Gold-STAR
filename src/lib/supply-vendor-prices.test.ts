import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import {
  expectedOrderTotal,
  priceBook,
  priceLine,
  vendorPriceFor,
  vendorPriceSummary,
} from "./supply-vendor-prices";
import type { SupplyVendor } from "./supply-vendors";

/**
 * David, 22 Sep: "if there's two vendors that sell the same item, one guy
 * charges $9, the other guy charges $10, then we should be able to put it in
 * for each vendor and the system should automatically pick it up... so that
 * we can track spending properly." And: "I want it to be automatic really."
 */

const V = (id: string, name: string): SupplyVendor => ({
  id,
  name,
  email: null,
  phone: null,
  note: null,
});
const vendors = [V("jd", "Jon-Don"), V("hd", "Home Depot"), V("gr", "Grainger")];
const book = priceBook([
  { item_id: "gloves", vendor_id: "jd", unit_price: 9 },
  { item_id: "gloves", vendor_id: "hd", unit_price: 10 },
  { item_id: "tape", vendor_id: "hd", unit_price: 4.5 },
]);
const gloves = { default_vendor_id: "jd" };

describe("a price per vendor, picked up automatically", () => {
  it("prices a line from the item's usual vendor", () => {
    expect(priceLine({ item_id: "gloves", quantity: 2 }, gloves, vendors, book)).toMatchObject({
      unitPrice: 9,
      total: 18,
      vendor: { source: "preset" },
    });
  });

  it("re-prices when the line picks a different vendor", () => {
    expect(
      priceLine({ item_id: "gloves", quantity: 2, vendor_id: "hd" }, gloves, vendors, book),
    ).toMatchObject({ unitPrice: 10, total: 20, vendor: { source: "line" } });
  });

  it("invents nothing when that vendor has no price on file", () => {
    const p = priceLine({ item_id: "gloves", quantity: 2, vendor_id: "gr" }, gloves, vendors, book);
    expect(p.unitPrice).toBeNull();
    expect(p.total).toBeNull();
    // Not Jon-Don's $9, not a zero.
    expect(vendorPriceFor(book, "gloves", "gr")).toBeNull();
  });

  it("invents nothing for a line with no vendor or no catalog item", () => {
    expect(priceLine({ item_id: "tape", quantity: 1 }, {}, vendors, book).total).toBeNull();
    expect(
      priceLine({ item_id: null, quantity: 1, vendor_id: "hd" }, null, vendors, book).total,
    ).toBeNull();
  });

  it("calls a partly priced order partial, never the total", () => {
    const lines = [
      priceLine({ item_id: "gloves", quantity: 2 }, gloves, vendors, book),
      priceLine({ item_id: "tape", quantity: 3, vendor_id: "hd" }, {}, vendors, book),
      priceLine({ item_id: null, quantity: 1 }, null, vendors, book),
    ];
    expect(expectedOrderTotal(lines)).toEqual({ total: 31.5, priced: 2, lines: 3 });
  });
});

describe("one item's prices, folded to its catalog row", () => {
  it("says Add a price when no vendor has one", () => {
    const s = vendorPriceSummary(book, "brush", vendors, "jd");
    expect(s).toMatchObject({ priced: 0, label: "Add a price" });
    expect(s.rows.map((r) => r.price)).toEqual([null, null, null]);
  });

  it("leads with the usual vendor, listed first", () => {
    const s = vendorPriceSummary(book, "gloves", vendors, "hd");
    expect(s.label).toBe("$10.00 at Home Depot · 1 more");
    expect(s.rows.map((r) => [r.vendor.id, r.usual])).toEqual([
      ["hd", true],
      ["jd", false],
      ["gr", false],
    ]);
  });

  it("falls back to the cheapest when the usual vendor has no price", () => {
    expect(vendorPriceSummary(book, "gloves", vendors, "gr").label).toBe(
      "$9.00 at Jon-Don · 1 more",
    );
    expect(vendorPriceSummary(book, "tape", vendors, null).label).toBe("$4.50 at Home Depot");
  });
});

const SQL = readFileSync(
  "supabase/migrations/20260925131000_supply_vendor_prices.sql",
  "utf8",
).replace(/\r\n/g, "\n");
const PAGE = readFileSync("src/routes/_authenticated/supplies.index.tsx", "utf8").replace(
  /\r\n/g,
  "\n",
);

describe("expectation and fact stay apart", () => {
  it("keeps one price per item and vendor, in its own table", () => {
    expect(SQL).toContain("CREATE TABLE IF NOT EXISTS public.supply_item_vendor_prices (");
    expect(SQL).toContain("CONSTRAINT supply_item_vendor_prices_one UNIQUE (item_id, vendor_id)");
    expect(SQL).not.toMatch(/ALTER TABLE public\.supply_purchases/);
  });

  it("shows purchasing prices to approvers and finance, and lets only catalog admins edit", () => {
    const read = SQL.match(/CREATE POLICY "supply_item_vendor_prices_read"[\s\S]*?\);\n/)![0];
    expect(read).toContain("public.can_view_finance((SELECT auth.uid()))");
    const write = SQL.match(/CREATE POLICY "supply_item_vendor_prices_write"[\s\S]*?;\n/)![0];
    expect(write).toContain("USING (public.is_privileged((SELECT auth.uid())))");
  });

  it("records the purchase at the price in the box, the actual", () => {
    const record = PAGE.match(/function RecordPurchase\([\s\S]*?\n\}\n/)![0];
    expect(record).toContain("unitPrice: shownPrice,");
    expect(record).toContain(
      "const shownPrice = !priceTouched && expected ? expected.price : unitPrice;",
    );
  });
});
