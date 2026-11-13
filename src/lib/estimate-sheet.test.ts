/**
 * The estimate sheet — David's calculator layout over the estimate's own lines.
 *
 * Mark: "job calculator he likes better than the current estimate system can
 * we copy that style and add custom line item options".
 *
 * What is pinned here: the catalogue plus the lines already on the estimate
 * become rows with quantities; a quantity typed into a row is exactly one
 * insert, update or delete on `estimate_lines`; a custom line round-trips
 * through the sheet's custom section; and the sheet's running total is the
 * number the table's Totals card reads back from the database.
 */
import { describe, expect, it } from "vitest";

import {
  FEE_PRESETS,
  OTHER_SECTION_ID,
  buildSheet,
  customLineValues,
  filterSheet,
  parseEstimateView,
  quantityDecimals,
  quantityWrite,
  rowUnitPrice,
  sheetTotals,
} from "@/lib/estimate-sheet";
import {
  discountAmount,
  lineTax,
  scopeSubtotal,
  type CatalogHeader,
  type CatalogItemPublic,
  type EstimateLine,
} from "@/lib/estimates";
import { EMPTY_PRICE_BOOK, resolveCatalogPrice, type PriceBook } from "@/lib/price-lists";

const headers: CatalogHeader[] = [
  { id: "h-equip", code: "EQ", name: "Equipment", sort_order: 1, is_active: true },
  { id: "h-labor", code: "LB", name: "Labor", sort_order: 0, is_active: true },
  { id: "h-old", code: "OLD", name: "Retired", sort_order: 2, is_active: false },
];

function item(o: Partial<CatalogItemPublic> & { id: string; name: string }): CatalogItemPublic {
  return {
    header_id: "h-equip",
    code: o.id.toUpperCase(),
    description: null,
    uom: "DAY",
    default_unit_price: 100,
    taxable: true,
    is_active: true,
    sort_order: 0,
    ...o,
  };
}

const dehu = item({ id: "dehu", name: "Dehumidifier", default_unit_price: 225 });
const scrubber = item({ id: "scrub", name: "Scrubber XXL with filter", default_unit_price: 300 });
const truck = item({
  id: "truck",
  name: "Truck mount",
  uom: "HR",
  default_unit_price: 220,
  sort_order: 5,
});
const labor = item({ id: "labor", name: "Technician", header_id: "h-labor", uom: "HR" });
const orphan = item({ id: "orphan", name: "Loose item", header_id: null, uom: "EA" });
const inOldHeader = item({ id: "old-item", name: "Under a retired header", header_id: "h-old" });
const retired = item({ id: "retired", name: "Retired rate", is_active: false });
const items = [dehu, scrubber, truck, labor, orphan, inOldHeader, retired];

function line(o: Partial<EstimateLine> & { id: string }): EstimateLine {
  const quantity = o.quantity ?? 1;
  const unit_price = o.unit_price ?? 0;
  return {
    estimate_id: "est-1",
    scope_id: "scope-1",
    catalog_item_id: null,
    position: 0,
    code: null,
    name: "Line",
    description: null,
    uom: "EA",
    unit_cost: 0,
    taxable: true,
    is_discount: false,
    note: null,
    subtotal: Math.round(quantity * unit_price * 100) / 100,
    ...o,
    quantity,
    unit_price,
  };
}

const ctx = { estimateId: "est-1", scopeId: "scope-1", position: 3 };

describe("laying the catalog out as a sheet", () => {
  it("groups active items under active headers in sort order, orphans last", () => {
    const sheet = buildSheet({ headers, items, lines: [], book: EMPTY_PRICE_BOOK });
    expect(sheet.sections.map((s) => s.name)).toEqual(["Labor", "Equipment", "Other items"]);
    expect(sheet.sections[1]!.rows.map((r) => r.item.id)).toEqual(["dehu", "scrub", "truck"]);
    // An item under a retired header is still offered, in the catch-all.
    const other = sheet.sections.find((s) => s.id === OTHER_SECTION_ID)!;
    expect(other.rows.map((r) => r.item.id)).toEqual(["orphan", "old-item"]);
    // A retired rate is not.
    expect(sheet.sections.flatMap((s) => s.rows).some((r) => r.item.id === "retired")).toBe(false);
  });

  it("binds each row to the line carrying its catalog item, 0 otherwise", () => {
    const existing = line({ id: "l1", catalog_item_id: "dehu", quantity: 3, unit_price: 225 });
    const sheet = buildSheet({ headers, items, lines: [existing], book: EMPTY_PRICE_BOOK });
    const rows = sheet.sections.flatMap((s) => s.rows);
    expect(rows.find((r) => r.item.id === "dehu")!.quantity).toBe(3);
    expect(rows.find((r) => r.item.id === "dehu")!.line?.id).toBe("l1");
    expect(rows.find((r) => r.item.id === "scrub")!.quantity).toBe(0);
    expect(rows.find((r) => r.item.id === "scrub")!.line).toBeNull();
    expect(sheet.custom).toEqual([]);
  });

  it("lists what it cannot bind as custom: ad hoc, retired, and a second copy", () => {
    const adHoc = line({ id: "c1", name: "Subcontractor", position: 0 });
    const first = line({ id: "l1", catalog_item_id: "dehu", quantity: 2, position: 1 });
    const second = line({ id: "l2", catalog_item_id: "dehu", quantity: 5, position: 2 });
    const onRetired = line({ id: "l3", catalog_item_id: "retired", position: 3 });
    const discount = line({ id: "d1", is_discount: true, unit_price: -50, position: 4 });
    const sheet = buildSheet({
      headers,
      items,
      lines: [second, onRetired, adHoc, first, discount],
      book: EMPTY_PRICE_BOOK,
    });
    const dehuRow = sheet.sections.flatMap((s) => s.rows).find((r) => r.item.id === "dehu")!;
    // First in position order wins the box.
    expect(dehuRow.line?.id).toBe("l1");
    expect(sheet.custom.map((l) => l.id)).toEqual(["c1", "l2", "l3"]);
    // A discount is a deduction, not a row on the sheet.
    expect(sheet.custom.some((l) => l.is_discount)).toBe(false);
  });

  it("prices an unbound row through the document's price book, and a bound row from its line", () => {
    const book: PriceBook = new Map([
      ["dehu", { unit_price: 180, source: "account", price_list_id: "pl", assignment_id: "as" }],
    ]);
    const stored = line({ id: "l1", catalog_item_id: "scrub", quantity: 1, unit_price: 275 });
    const sheet = buildSheet({ headers, items, lines: [stored], book });
    const rows = sheet.sections.flatMap((s) => s.rows);
    const dehuRow = rows.find((r) => r.item.id === "dehu")!;
    // The same function, the same book, the same answer as the picker.
    expect(dehuRow.price).toEqual(resolveCatalogPrice(dehu, book));
    expect(rowUnitPrice(dehuRow)).toBe(180);
    // A line already written keeps the price it was written with.
    expect(rowUnitPrice(rows.find((r) => r.item.id === "scrub")!)).toBe(275);
    // No agreement: the catalogue default.
    expect(rowUnitPrice(rows.find((r) => r.item.id === "truck")!)).toBe(220);
  });

  it("filters by name, code or description without losing custom lines", () => {
    const custom = line({ id: "c1", name: "Garbage" });
    const sheet = buildSheet({ headers, items, lines: [custom], book: EMPTY_PRICE_BOOK });
    const hit = filterSheet(sheet, "scrub");
    expect(hit.sections.map((s) => s.name)).toEqual(["Equipment"]);
    expect(hit.sections[0]!.rows.map((r) => r.item.id)).toEqual(["scrub"]);
    expect(hit.custom).toEqual([]);
    expect(filterSheet(sheet, "garb").custom.map((l) => l.id)).toEqual(["c1"]);
    expect(filterSheet(sheet, "   ")).toBe(sheet);
  });
});

describe("a quantity typed into a row", () => {
  const sheetFor = (lines: EstimateLine[], book: PriceBook = EMPTY_PRICE_BOOK) =>
    buildSheet({ headers, items, lines, book }).sections.flatMap((s) => s.rows);

  it("creates the line, priced through the book, when the row has none", () => {
    const book: PriceBook = new Map([
      ["dehu", { unit_price: 180, source: "state", price_list_id: "pl", assignment_id: "as" }],
    ]);
    const row = sheetFor([], book).find((r) => r.item.id === "dehu")!;
    const write = quantityWrite(row, 3, ctx);
    expect(write).toEqual({
      kind: "insert",
      values: {
        estimate_id: "est-1",
        scope_id: "scope-1",
        catalog_item_id: "dehu",
        code: "DEHU",
        name: "Dehumidifier",
        description: null,
        uom: "DAY",
        quantity: 3,
        unit_price: 180,
        taxable: true,
        position: 3,
      },
    });
    // No unit_cost in the insert: the server fills it from the catalogue.
    expect(write.kind === "insert" && "unit_cost" in write.values).toBe(false);
  });

  it("updates only the quantity when the row already has a line", () => {
    const row = sheetFor([line({ id: "l1", catalog_item_id: "dehu", quantity: 3 })]).find(
      (r) => r.item.id === "dehu",
    )!;
    expect(quantityWrite(row, 4.5, ctx)).toEqual({
      kind: "update",
      lineId: "l1",
      patch: { quantity: 4.5 },
    });
  });

  it("removes the line when the box is cleared or zeroed", () => {
    const row = sheetFor([line({ id: "l1", catalog_item_id: "dehu", quantity: 3 })]).find(
      (r) => r.item.id === "dehu",
    )!;
    expect(quantityWrite(row, 0, ctx)).toEqual({ kind: "remove", lineId: "l1" });
    expect(quantityWrite(row, null, ctx)).toEqual({ kind: "remove", lineId: "l1" });
    expect(quantityWrite(row, -2, ctx)).toEqual({ kind: "remove", lineId: "l1" });
  });

  it("does nothing for an unchanged number, or a zero on a row with no line", () => {
    const bound = sheetFor([line({ id: "l1", catalog_item_id: "dehu", quantity: 3 })]).find(
      (r) => r.item.id === "dehu",
    )!;
    expect(quantityWrite(bound, 3, ctx)).toEqual({ kind: "none" });
    const unbound = sheetFor([]).find((r) => r.item.id === "dehu")!;
    expect(quantityWrite(unbound, 0, ctx)).toEqual({ kind: "none" });
    expect(quantityWrite(unbound, null, ctx)).toEqual({ kind: "none" });
  });

  it("rounds to the two decimals the column stores", () => {
    const row = sheetFor([]).find((r) => r.item.id === "truck")!;
    const write = quantityWrite(row, 10 / 3, ctx);
    expect(write.kind === "insert" && write.values.quantity).toBe(3.33);
  });

  it("takes a fraction for measured units and a whole number for counts", () => {
    expect(quantityDecimals("HR")).toBe(2);
    expect(quantityDecimals("SF")).toBe(2);
    expect(quantityDecimals("DAY")).toBe(2);
    expect(quantityDecimals("EA")).toBe(0);
    expect(quantityDecimals("ls")).toBe(0);
    expect(quantityDecimals(null)).toBe(2);
  });
});

describe("custom lines and fees", () => {
  it("writes the same ad hoc row the table's Custom line button writes", () => {
    expect(customLineValues(ctx)).toEqual({
      estimate_id: "est-1",
      scope_id: "scope-1",
      catalog_item_id: null,
      code: null,
      name: "Custom item",
      description: null,
      uom: "EA",
      quantity: 1,
      unit_cost: 0,
      unit_price: 0,
      taxable: true,
      position: 3,
    });
  });

  it("offers the calculator's two fees as lump-sum presets", () => {
    expect(FEE_PRESETS.map((f) => f.name)).toEqual(["Garbage", "Miscellaneous"]);
    const garbage = customLineValues({ ...ctx, ...FEE_PRESETS[0] });
    expect(garbage.name).toBe("Garbage");
    expect(garbage.uom).toBe("LS");
    expect(garbage.catalog_item_id).toBeNull();
  });

  it("round-trips: a custom line written by the sheet comes back in its custom section", () => {
    const values = customLineValues({ ...ctx, name: "Garbage", uom: "LS" });
    const saved = line({ id: "c1", ...values, unit_price: 150, subtotal: 150 });
    const sheet = buildSheet({ headers, items, lines: [saved], book: EMPTY_PRICE_BOOK });
    expect(sheet.custom.map((l) => l.id)).toEqual(["c1"]);
    // And it never steals a catalogue row.
    expect(sheet.sections.flatMap((s) => s.rows).every((r) => r.line === null)).toBe(true);
  });
});

describe("the running total", () => {
  const rate = 0.06625;
  const lines = [
    line({ id: "l1", catalog_item_id: "dehu", quantity: 3, unit_price: 225 }),
    line({ id: "l2", catalog_item_id: "truck", quantity: 2.5, unit_price: 220 }),
    line({ id: "l3", name: "Permit", quantity: 1, unit_price: 80, taxable: false }),
    line({ id: "d1", name: "Discount", is_discount: true, quantity: 1, unit_price: -100 }),
  ];

  it("reads the same subtotal and discounts the table's Totals card reads", () => {
    const totals = sheetTotals(lines, rate);
    expect(totals.subtotal).toBe(scopeSubtotal(lines));
    expect(totals.subtotal).toBe(1305);
    expect(totals.discounts.map((d) => [d.line.id, d.amount])).toEqual([
      ["d1", discountAmount(lines[3]!)],
    ]);
  });

  it("computes tax and total the way recalc_estimate_totals does", () => {
    const totals = sheetTotals(lines, rate);
    // ROUND(SUM(subtotal) FILTER (WHERE taxable) * rate, 2): the discount is
    // taxable, so it pulls the base down; the permit is exempt and stays out.
    const taxableBase = 675 + 550 - 100;
    expect(totals.tax).toBe(Math.round(taxableBase * rate * 100) / 100);
    expect(totals.tax).toBe(74.53);
    // ROUND(SUM(subtotal), 2) + tax, over every line including the discount.
    expect(totals.total).toBeCloseTo(1279.53, 2);
    // Per-line tax, as the table prints it, adds up to the same figure here.
    const perLine = lines.reduce((s, l) => s + lineTax(l, rate), 0);
    expect(Math.abs(perLine - totals.tax)).toBeLessThan(0.02);
  });

  it("is zero for an empty estimate", () => {
    expect(sheetTotals([], rate)).toEqual({ subtotal: 0, discounts: [], tax: 0, total: 0 });
  });
});

describe("the remembered view", () => {
  it("is the table unless the row says sheet", () => {
    expect(parseEstimateView("sheet")).toBe("sheet");
    expect(parseEstimateView("table")).toBe("table");
    expect(parseEstimateView(null)).toBe("table");
    expect(parseEstimateView("kanban")).toBe("table");
  });
});
