import { describe, expect, it } from "vitest";

import {
  CATALOG_ITEM_PUBLIC_COLUMNS,
  CATALOG_ITEM_SELECT,
  mergeCatalogCosts,
  type CatalogItemPublic,
} from "@/lib/estimates";

/**
 * estimate_catalog_items has column-level SELECT grants (migration
 * 20260909090000). Naming an ungranted column — default_cost, or `*` — fails
 * with "permission denied for table estimate_catalog_items" for every user,
 * so the column list the readers select from is pinned here.
 */
describe("catalog column list", () => {
  it("never names the cost column", () => {
    expect(CATALOG_ITEM_PUBLIC_COLUMNS).not.toContain("default_cost");
    expect(CATALOG_ITEM_SELECT).not.toMatch(/default_cost|\*/);
  });

  it("keeps the PostgREST select string and the column array in step", () => {
    expect(CATALOG_ITEM_SELECT).toBe(CATALOG_ITEM_PUBLIC_COLUMNS.join(", "));
  });

  it("still carries what the Job Calculator needs for a rep", () => {
    for (const col of ["id", "code", "name", "uom", "default_unit_price", "taxable"]) {
      expect(CATALOG_ITEM_PUBLIC_COLUMNS).toContain(col);
    }
  });
});

const row = (id: string): CatalogItemPublic => ({
  id,
  header_id: null,
  code: id.toUpperCase(),
  name: `Item ${id}`,
  description: null,
  uom: "EA",
  default_unit_price: 100,
  taxable: true,
  is_active: true,
  sort_order: 0,
});

describe("mergeCatalogCosts", () => {
  it("attaches the cost from the RPC by id", () => {
    const [a, b] = mergeCatalogCosts([row("a"), row("b")], [{ id: "b", default_cost: 42.5 }]);
    expect(a.default_cost).toBeNull();
    expect(b.default_cost).toBe(42.5);
  });

  it("marks every item hidden when the viewer got no cost rows", () => {
    for (const costs of [null, undefined, []]) {
      const out = mergeCatalogCosts([row("a")], costs);
      expect(out[0].default_cost).toBeNull();
    }
  });

  it("coerces numeric strings the way PostgREST may serialise numeric", () => {
    const [a] = mergeCatalogCosts(
      [row("a")],
      [{ id: "a", default_cost: "12.75" as unknown as number }],
    );
    expect(a.default_cost).toBe(12.75);
  });

  it("does not mutate its inputs", () => {
    const items = [row("a")];
    mergeCatalogCosts(items, [{ id: "a", default_cost: 1 }]);
    expect("default_cost" in items[0]).toBe(false);
  });
});
