import { describe, expect, it } from "vitest";

import type { SupplyPurchase } from "@/lib/supply-inventory";
import {
  SUPPLY_FEE_PER_DAY,
  dailySuppliesCharge,
  supplyFeeKindFor,
} from "@/lib/supply-fee-schedule";
import { itemHistory, purchaseOrders } from "@/lib/supply-spend";

/*
 * 6 Nov call, David's Falcon-GSR.xlsx "Tabels" sheet: supplies on a regular
 * job bill as a flat fee per day on site by the kind of work, and the job
 * ledger pulls that × the days on site.
 */
describe("the supplies fee schedule", () => {
  it("carries David's figures per day", () => {
    expect(SUPPLY_FEE_PER_DAY).toEqual({
      water: 250,
      extraction: 100,
      equipment: 50,
      mold: 250,
      air_sample: 100,
      gut_job: 500,
      sewage: 500,
      bio: 500,
      board_up: 500,
      encapsulation: 500,
      fire: 300,
    });
  });

  it("reads the kind of work off a loss-type key, whatever its spelling", () => {
    expect(supplyFeeKindFor("water_mitigation")).toBe("water");
    expect(supplyFeeKindFor("Water")).toBe("water");
    expect(supplyFeeKindFor("mold_remediation")).toBe("mold");
    expect(supplyFeeKindFor("fire_smoke")).toBe("fire");
    expect(supplyFeeKindFor("smoke")).toBe("fire");
    expect(supplyFeeKindFor("sewage_backup")).toBe("sewage");
    expect(supplyFeeKindFor("sewer")).toBe("sewage");
    expect(supplyFeeKindFor("biohazard")).toBe("bio");
    expect(supplyFeeKindFor("air_sample")).toBe("air_sample");
    expect(supplyFeeKindFor("board_up")).toBe("board_up");
    expect(supplyFeeKindFor("encapsulation")).toBe("encapsulation");
    expect(supplyFeeKindFor("gut_job")).toBe("gut_job");
    expect(supplyFeeKindFor("water_extraction")).toBe("extraction");
    // No fee on the sheet for these.
    expect(supplyFeeKindFor("storm")).toBeNull();
    expect(supplyFeeKindFor("cleaning")).toBeNull();
    expect(supplyFeeKindFor(null)).toBeNull();
  });

  it("charges the daily fee × the days on site, and says so", () => {
    const c = dailySuppliesCharge("water_mitigation", 5)!;
    expect(c.amount).toBe(1250);
    expect(c.unpriced).toBe(0);
    expect(c.source).toBe("Supplies fee schedule — Water $250/day × 5 days on site");
    expect(dailySuppliesCharge("fire", 1)!.source).toContain("$300/day × 1 day on site");
    // Days not yet known: $0, not null — the kind is still the fee's.
    expect(dailySuppliesCharge("mold", null)!.amount).toBe(0);
    // No fee kind: null, so the ledger falls back to each supply × its charge.
    expect(dailySuppliesCharge("storm", 4)).toBeNull();
  });

  it("takes a catalog override for a kind", () => {
    const c = dailySuppliesCharge("sewage", 2, { ...SUPPLY_FEE_PER_DAY, sewage: 600 })!;
    expect(c.amount).toBe(1200);
    expect(c.perDay).toBe(600);
  });
});

const p = (over: Partial<SupplyPurchase> & { id: string }): SupplyPurchase => ({
  item_id: null,
  item_label: "Duct tape",
  item_name: null,
  supplier_name: "Home Depot",
  quantity: 1,
  unit_price: 5,
  total_cost: 5,
  purchased_on: "2026-03-02",
  note: null,
  location_id: "ny",
  location_name: "NY",
  ...over,
});

describe("purchase history (6 Nov: David's spreadsheet)", () => {
  it("groups purchases into orders: one supplier, one day, one office, newest first", () => {
    const orders = purchaseOrders([
      p({ id: "a", purchased_on: "2026-03-02", total_cost: 5 }),
      p({ id: "b", purchased_on: "2026-03-02", item_label: "Rags", total_cost: 7 }),
      p({ id: "c", purchased_on: "2026-03-09", supplier_name: "Lowe's", total_cost: 20 }),
      p({ id: "d", purchased_on: "2026-03-02", location_id: "nj", location_name: "NJ" }),
    ]);
    expect(
      orders.map((o) => [o.purchased_on, o.supplier, o.location, o.total, o.lines.length]),
    ).toEqual([
      ["2026-03-09", "Lowe's", "NY", 20, 1],
      ["2026-03-02", "Home Depot", "NY", 12, 2],
      ["2026-03-02", "Home Depot", "NJ", 5, 1],
    ]);
  });

  it("totals each item for the window, company-wide and per office", () => {
    const items = itemHistory([
      p({ id: "a", quantity: 3, total_cost: 15 }),
      p({ id: "b", quantity: 2, total_cost: 11, location_id: "nj", location_name: "NJ" }),
      p({ id: "c", item_label: "Rags", quantity: 1, total_cost: 4 }),
    ]);
    expect(items.map((i) => [i.label, i.quantity, i.total, i.purchases])).toEqual([
      ["Duct tape", 5, 26, 2],
      ["Rags", 1, 4, 1],
    ]);
    expect(items[0].byLocation).toEqual([
      { location: "NY", quantity: 3, total: 15, purchases: 1 },
      { location: "NJ", quantity: 2, total: 11, purchases: 1 },
    ]);
  });
});
