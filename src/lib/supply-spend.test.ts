import { describe, expect, it } from "vitest";

import type { SupplyPurchase } from "@/lib/supply-inventory";
import {
  itemPriceSpread,
  planCatalogueImport,
  purchaseItemName,
  spendByItem,
  spendByMonth,
  spendBySupplier,
  spendTotal,
} from "@/lib/supply-spend";

/**
 * "This month we spent $X at supplier Y on item Z."
 *
 * David keeps that answer in a spreadsheet today and wants it for purchasing
 * power: four locations each buying the same dehumidifier filter from a
 * different merchant at a different price is the whole reason for asking.
 *
 * These are the sums he would check by hand, so they are checked here by hand
 * too — every expected figure below is one somebody could add up on paper.
 */

let seq = 0;
const buy = (p: Partial<SupplyPurchase>): SupplyPurchase => {
  const quantity = p.quantity ?? 1;
  const unit_price = p.unit_price ?? 0;
  return {
    id: `p-${++seq}`,
    item_id: null,
    item_label: null,
    item_name: null,
    supplier_name: "Home Depot",
    quantity,
    unit_price,
    total_cost: p.total_cost ?? Math.round(quantity * unit_price * 100) / 100,
    purchased_on: "2026-09-01",
    note: null,
    ...p,
  };
};

describe("purchaseItemName", () => {
  it("prefers the catalog's name", () => {
    expect(purchaseItemName(buy({ item_name: "Nitrile gloves", item_label: "gloves" }))).toBe(
      "Nitrile gloves",
    );
  });

  it("falls back to what was typed when the item is not in the catalog", () => {
    expect(purchaseItemName(buy({ item_label: "Dehumidifier filter" }))).toBe(
      "Dehumidifier filter",
    );
  });

  it("never renders a blank line", () => {
    expect(purchaseItemName(buy({ item_label: "   " }))).toBe("Unnamed item");
  });
});

describe("spendTotal", () => {
  it("adds the stored total, not quantity × unit price", () => {
    // A line may carry delivery or a discount that the multiplication does not
    // explain, which is why total_cost is stored rather than derived.
    const rows = [
      buy({ quantity: 2, unit_price: 10, total_cost: 24.5 }),
      buy({ quantity: 1, unit_price: 5 }),
    ];
    expect(spendTotal(rows)).toBe(29.5);
  });

  it("is zero on an empty period rather than NaN", () => {
    expect(spendTotal([])).toBe(0);
  });
});

describe("spendBySupplier", () => {
  const rows = [
    buy({ supplier_name: "Home Depot", quantity: 2, unit_price: 30 }),
    buy({ supplier_name: "home depot ", quantity: 1, unit_price: 40 }),
    buy({ supplier_name: "Grainger", quantity: 5, unit_price: 10 }),
  ];

  it("puts the supplier worth a phone call at the top", () => {
    const [first, second] = spendBySupplier(rows);
    expect(first.label).toBe("Home Depot");
    expect(first.total).toBe(100);
    expect(second.label).toBe("Grainger");
    expect(second.total).toBe(50);
  });

  it("treats a differently-typed supplier name as the same supplier", () => {
    // Free-text supplier names are typed by whoever has the receipt, so
    // "home depot " and "Home Depot" must not appear as two merchants.
    const groups = spendBySupplier(rows);
    expect(groups).toHaveLength(2);
    expect(groups[0].purchases).toBe(2);
    expect(groups[0].quantity).toBe(3);
  });
});

describe("spendByItem", () => {
  it("groups on the catalog id when there is one", () => {
    const rows = [
      buy({ item_id: "i-1", item_name: "Nitrile gloves", quantity: 1, unit_price: 12 }),
      buy({ item_id: "i-1", item_name: "Nitrile gloves", quantity: 2, unit_price: 12 }),
      buy({ item_id: "i-2", item_name: "N95", quantity: 1, unit_price: 3 }),
    ];
    const groups = spendByItem(rows);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ key: "i-1", label: "Nitrile gloves", total: 36 });
  });

  it("groups free-text purchases by name so they do not each become their own line", () => {
    const rows = [
      buy({ item_label: "Filter", quantity: 1, unit_price: 9 }),
      buy({ item_label: "Filter", quantity: 1, unit_price: 11 }),
    ];
    expect(spendByItem(rows)).toHaveLength(1);
    expect(spendByItem(rows)[0].total).toBe(20);
  });
});

describe("spendByMonth", () => {
  it("reads oldest first, so a trend runs left to right", () => {
    const rows = [
      buy({ purchased_on: "2026-09-04", quantity: 1, unit_price: 10 }),
      buy({ purchased_on: "2026-07-31", quantity: 1, unit_price: 40 }),
      buy({ purchased_on: "2026-09-28", quantity: 1, unit_price: 5 }),
    ];
    const months = spendByMonth(rows);
    expect(months.map((m) => m.key)).toEqual(["2026-07", "2026-09"]);
    expect(months[1].total).toBe(15);
    expect(months[1].purchases).toBe(2);
  });
});

describe("itemPriceSpread — the purchasing-power question", () => {
  const rows = [
    buy({ item_id: "i-1", item_name: "Filter", supplier_name: "A", quantity: 10, unit_price: 5 }),
    buy({ item_id: "i-1", item_name: "Filter", supplier_name: "B", quantity: 10, unit_price: 8 }),
    // Bought a lot, from one merchant only — not a comparison, so it is not shown.
    buy({ item_id: "i-2", item_name: "Gloves", supplier_name: "A", quantity: 50, unit_price: 12 }),
  ];

  it("lists only items bought from more than one supplier", () => {
    const spread = itemPriceSpread(rows);
    expect(spread.map((s) => s.itemName)).toEqual(["Filter"]);
  });

  it("reports the range actually paid", () => {
    const [filter] = itemPriceSpread(rows);
    expect(filter.suppliers).toBe(2);
    expect(filter.low).toBe(5);
    expect(filter.high).toBe(8);
  });

  it("weights the average by quantity, so a big order counts for more", () => {
    // 10 at $5 plus 10 at $8 is $130 over 20 units — $6.50, not the $6.50
    // midpoint by luck: swap the quantities and the answer moves.
    expect(itemPriceSpread(rows)[0].weightedAverage).toBe(6.5);

    const lopsided = [
      buy({ item_id: "i-3", item_name: "Tape", supplier_name: "A", quantity: 1, unit_price: 5 }),
      buy({ item_id: "i-3", item_name: "Tape", supplier_name: "B", quantity: 99, unit_price: 10 }),
    ];
    expect(itemPriceSpread(lopsided)[0].weightedAverage).toBe(9.95);
  });

  it("states the crude saving: every unit at the best price already paid", () => {
    // $130 spent, 20 units, cheapest seen $5 → $30. Deliberately crude: it is
    // an argument for a phone call, not a forecast.
    expect(itemPriceSpread(rows)[0].potentialSaving).toBe(30);
  });

  it("hides an item whose price never moved, even across two suppliers", () => {
    const flat = [
      buy({ item_id: "i-4", item_name: "Bags", supplier_name: "A", quantity: 2, unit_price: 7 }),
      buy({ item_id: "i-4", item_name: "Bags", supplier_name: "B", quantity: 2, unit_price: 7 }),
    ];
    expect(itemPriceSpread(flat)).toEqual([]);
  });

  it("ignores a zero-quantity line rather than dividing by it", () => {
    const zero = [buy({ item_id: "i-5", item_name: "Odd", quantity: 0, unit_price: 5 })];
    expect(itemPriceSpread(zero)).toEqual([]);
  });
});

describe("planCatalogueImport", () => {
  it("keys on sku, so re-importing a corrected sheet updates rather than duplicates", () => {
    const plan = planCatalogueImport([
      { name: "Nitrile gloves", sku: "PPE-1" },
      { name: "Nitrile gloves, box", sku: "ppe-1" },
    ]);
    expect(plan.rows).toHaveLength(1);
    expect(plan.issues[0].problem).toContain("Duplicate");
  });

  it("falls back to a case-insensitive name when the sheet has no sku", () => {
    const plan = planCatalogueImport([{ name: "Tape" }, { name: "tape" }]);
    expect(plan.rows).toHaveLength(1);
    expect(plan.issues).toHaveLength(1);
  });

  it("keeps a repeated name whose size differs — each size is its own row", () => {
    // David's sheet has five "Pleated Filter Merv 8" rows and three sizes of
    // Nitrile Gloves. Deduping on the name alone would silently lose four
    // filters, and nobody would notice until a crew ordered the wrong one.
    const plan = planCatalogueImport([
      { name: "Pleated Filter Merv 8", size: "12x12x1" },
      { name: "Pleated Filter Merv 8", size: "21x19x2" },
      { name: "Pleated Filter Merv 8", size: "21x19x2" },
    ]);
    expect(plan.rows.map((r) => r.size)).toEqual(["12x12x1", "21x19x2"]);
    expect(plan.issues).toHaveLength(1);
  });

  it("says what was wrong with a row instead of dropping it silently", () => {
    // A catalogue that quietly loses nine lines of a hundred is worse than one
    // that refuses — nobody goes looking for items they never saw arrive.
    const plan = planCatalogueImport([
      { name: "  " },
      { name: "Filter", unitCost: -3 },
      { name: "Bags", unitCost: "lots" as unknown as number },
    ]);
    expect(plan.rows).toEqual([]);
    expect(plan.issues.map((i) => i.row)).toEqual([1, 2, 3]);
    expect(plan.issues[0].problem).toBe("No item name.");
  });

  it("defaults a missing unit to each and leaves the rest null", () => {
    const [row] = planCatalogueImport([{ name: "Poly sheeting" }]).rows;
    expect(row).toEqual({
      name: "Poly sheeting",
      size: null,
      unit: "each",
      category: null,
      sku: null,
      defaultSupplier: null,
      unitCost: null,
      sortOrder: null,
    });
  });
});
