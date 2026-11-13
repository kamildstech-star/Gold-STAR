import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { SETTINGS_PAGES, SETTINGS_SECTION_LAYOUT } from "./admin-settings";

/**
 * David, 22 Sep, hunting for it: "Where is this in the backend?... if we could
 * have that items catalog here, that'll be great." — here being Settings →
 * Rates & catalogs.
 */
const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const ROUTE = read("src/routes/_authenticated/admin.supply-catalog.tsx");
const SUPPLIES = read("src/routes/_authenticated/supplies.index.tsx");
const ADMIN = read("src/components/supply-catalog-admin.tsx");

describe("the supply catalog has two doorways onto one screen", () => {
  it("is listed under Rates & catalogs, right after price lists", () => {
    const rates = SETTINGS_PAGES.filter((p) => p.area === "rates").map((p) => p.path);
    expect(rates).toContain("/admin/supply-catalog");
    expect(rates.indexOf("/admin/supply-catalog")).toBe(rates.indexOf("/admin/price-lists") + 1);
    const page = SETTINGS_PAGES.find((p) => p.path === "/admin/supply-catalog")!;
    expect(page.keywords).toEqual(expect.arrayContaining(["items catalog", "purchasing"]));
    // Since the 28 Sep regroup the rail shows it under Operations, first:
    // supplies and purchasing lead David's "operational stuff".
    expect(SETTINGS_SECTION_LAYOUT.operations[0]).toBe("/admin/supply-catalog");
  });

  it("renders the same component in Settings and on the Supplies Catalog tab", () => {
    expect(ROUTE).toMatch(/component: SupplyCatalogAdmin,/);
    const tab = SUPPLIES.match(/<TabsContent value="catalog"[\s\S]*?<\/TabsContent>/)![0];
    expect(tab).toContain("<SupplyCatalogAdmin />");
    // The old in-page editor is gone, so there is nothing to drift.
    expect(SUPPLIES).not.toMatch(/function CatalogEditor\(/);
  });

  it("edits items in place: name, size, unit and category", () => {
    for (const field of ["name", "size", "unit", "category"]) {
      expect(ADMIN).toContain(`onCommit={(next) => saveField(it, { ${field}: next })}`);
    }
  });

  it("saves a size through the shared update", () => {
    const update = read("src/lib/running-cost.ts").match(
      /export async function updateSupplyItem[\s\S]*?\n\}/,
    )![0];
    expect(update).toContain('clean.size = (patch.size ?? "").trim() || null;');
  });
});
