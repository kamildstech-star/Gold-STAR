import { describe, expect, it } from "vitest";

import {
  ESTIMATE_LINE_PUBLIC_COLUMNS,
  ESTIMATE_LINE_SELECT,
  INVOICE_LINE_PUBLIC_COLUMNS,
  INVOICE_LINE_SELECT,
  lineExtendedCost,
  lineMarginPercent,
  mergeLineCosts,
} from "@/lib/line-costs";

/**
 * estimate_lines and invoice_lines have column-level SELECT grants (migration
 * 20260909100000). Naming an ungranted column — unit_cost, or `*` — fails
 * with "permission denied for table ..." for every user, so the column lists
 * the readers select from are pinned here.
 */
describe("line column lists", () => {
  it("never name the cost column", () => {
    expect(ESTIMATE_LINE_PUBLIC_COLUMNS).not.toContain("unit_cost");
    expect(INVOICE_LINE_PUBLIC_COLUMNS).not.toContain("unit_cost");
    expect(ESTIMATE_LINE_SELECT).not.toMatch(/unit_cost|\*/);
    expect(INVOICE_LINE_SELECT).not.toMatch(/unit_cost|\*/);
  });

  it("keep the PostgREST select strings and the column arrays in step", () => {
    expect(ESTIMATE_LINE_SELECT).toBe(ESTIMATE_LINE_PUBLIC_COLUMNS.join(", "));
    expect(INVOICE_LINE_SELECT).toBe(INVOICE_LINE_PUBLIC_COLUMNS.join(", "));
  });

  it("still carry what the editors and the PDFs draw", () => {
    for (const col of [
      "id",
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
    ]) {
      expect(ESTIMATE_LINE_PUBLIC_COLUMNS).toContain(col);
      expect(INVOICE_LINE_PUBLIC_COLUMNS).toContain(col);
    }
    // The estimate PDF prints short_name; invoice_lines has no such column.
    expect(ESTIMATE_LINE_PUBLIC_COLUMNS).toContain("short_name");
    expect(INVOICE_LINE_PUBLIC_COLUMNS).not.toContain("short_name");
  });
});

describe("mergeLineCosts", () => {
  const rows = [
    { id: "a", quantity: 2 },
    { id: "b", quantity: 1 },
  ];

  it("attaches the cost from the RPC by line id", () => {
    const [a, b] = mergeLineCosts(rows, [{ line_id: "b", unit_cost: 42.5 }]);
    expect(a.unit_cost).toBeNull();
    expect(b.unit_cost).toBe(42.5);
  });

  it("marks every line hidden when the viewer got no cost rows", () => {
    for (const costs of [null, undefined, []]) {
      const out = mergeLineCosts(rows, costs);
      expect(out.map((l) => l.unit_cost)).toEqual([null, null]);
    }
  });

  it("coerces numeric strings the way PostgREST may serialise numeric", () => {
    const [a] = mergeLineCosts(rows, [{ line_id: "a", unit_cost: "12.75" as unknown as number }]);
    expect(a.unit_cost).toBe(12.75);
  });

  it("does not mutate its inputs", () => {
    mergeLineCosts(rows, [{ line_id: "a", unit_cost: 1 }]);
    expect("unit_cost" in rows[0]).toBe(false);
  });
});

describe("hidden cost is an unknown, not a zero", () => {
  it("extended cost is null when the unit cost was withheld", () => {
    expect(lineExtendedCost({ unit_cost: null, quantity: 3 })).toBeNull();
    expect(lineExtendedCost({ unit_cost: 10, quantity: 3 })).toBe(30);
    expect(lineExtendedCost({ unit_cost: 0, quantity: 3 })).toBe(0);
  });

  it("margin is null rather than 100% when the cost is hidden", () => {
    expect(lineMarginPercent(100, null)).toBeNull();
    expect(lineMarginPercent(100, 0)).toBe(100);
    expect(lineMarginPercent(100, 40)).toBe(60);
  });

  it("margin is null when there is no amount to measure against", () => {
    expect(lineMarginPercent(0, 10)).toBeNull();
    expect(lineMarginPercent(-5, 10)).toBeNull();
  });
});
