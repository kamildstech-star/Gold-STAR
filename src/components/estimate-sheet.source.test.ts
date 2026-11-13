import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Mark: "job calculator he likes better than the current estimate system can
 * we copy that style and add custom line item options".
 *
 * The sheet is a second presentation of the estimate's lines, and three
 * things about it are only visible in the source: that every price on it
 * comes through the one resolver the table already uses, that its quantity
 * boxes are the shared NumberInput, and that the table view it sits beside
 * was not touched to make room for it. There is no DOM testing library in
 * this repo, so the wiring is read off the files — precedent in
 * src/components/qty-takes-a-sum.test.ts.
 */
const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

const EDITOR = read("src/components/estimate-editor.tsx");
const SHEET = read("src/components/estimate-sheet.tsx");
const LIB = read("src/lib/estimate-sheet.ts");

describe("the estimate sheet", () => {
  it("prices every row through resolveCatalogPrice, the table's resolver", () => {
    // The table's insert, as it was before the sheet existed.
    const tableInsert = EDITOR.match(
      /unit_price: resolveCatalogPrice\(it, pricing\.book\)\.unit_price/,
    );
    expect(tableInsert, "the table no longer resolves through the book").not.toBeNull();
    // The sheet's rows, from the same function over the same book.
    const sheetRow = LIB.match(/price: resolveCatalogPrice\(item, args\.book\)/);
    expect(sheetRow).not.toBeNull();
    // And the sheet's insert takes the price off that row, never a second lookup.
    const insert = LIB.match(/kind: "insert",\s*values: \{[\s\S]*?\},?\s*\};/);
    expect(insert![0]).toContain("unit_price: row.price.unit_price");
    // The component hands the sheet the editor's own book, not one of its own.
    const build = SHEET.match(/buildSheet\(\{[\s\S]*?\}\)/);
    expect(build![0]).toContain("book: pricing.book");
    expect(SHEET).not.toContain("fetchDocumentPricing");
    expect(SHEET).not.toContain("resolveCatalogPrice");
  });

  it("gets that book from the editor, which resolves it once for the document", () => {
    const mount = EDITOR.match(/<EstimateSheet[\s\S]*?\/>/);
    expect(mount).not.toBeNull();
    expect(mount![0]).toContain("pricing={pricing}");
    expect(mount![0]).toContain("lines={lines}");
    expect(mount![0]).toContain("scopes={scopes}");
  });

  it("uses the shared NumberInput for every quantity box, never a spinner", () => {
    const boxes = SHEET.match(/<NumberInput[\s\S]*?\/>/g) ?? [];
    const qty = boxes.filter((b) => /quantity/.test(b));
    expect(qty.length, "one box per catalog row and one per custom row").toBe(2);
    for (const box of qty) {
      expect(box).toContain("decimals={quantityDecimals(");
      expect(box).toContain("onCommit=");
    }
    expect(SHEET).not.toContain('type="number"');
  });

  it("is the sheet branch of the editor, and the table is the other branch", () => {
    const branch = EDITOR.match(
      /\{view === "sheet" \? \(\s*<EstimateSheet[\s\S]*?\) : scopes\.length === 0 \?/,
    );
    expect(branch, "the sheet replaces the scope cards, nothing else").not.toBeNull();
    // The Add scope button belongs to the table view only.
    expect(EDITOR).toMatch(/\{view === "table" && scopes\.length > 0 && \(/);
  });

  it("leaves the table view as it was", () => {
    // The nine-column table, its picker insert, and its own custom line.
    const head = EDITOR.match(/<thead[\s\S]*?<\/thead>/);
    expect(head![0].match(/<th[\s>]/g)?.length).toBe(10);
    for (const col of ["Item", "Qty", "UOM", "Cost", "Unit price", "Subtotal", "Tax", "Total"]) {
      expect(head![0]).toContain(`>${col}</th>`);
    }
    expect(EDITOR).toContain("function ScopeCard(");
    expect(EDITOR).toContain('name: "Custom item"');
    const qty = (EDITOR.match(/<CalcInput[\s\S]*?\/>/g) ?? []).filter((b) => /quantity/.test(b));
    expect(qty.length).toBe(1);
  });

  it("is remembered per person in user_view_prefs under its own scope", () => {
    const scope = LIB.match(/ESTIMATE_VIEW_SCOPE = "[^"]*"/);
    expect(scope![0]).toBe('ESTIMATE_VIEW_SCOPE = "estimate_editor_view"');
    const upsert = LIB.match(/from\("user_view_prefs"\)\.upsert\([\s\S]*?\);/);
    expect(upsert![0]).toContain("scope: ESTIMATE_VIEW_SCOPE");
    expect(upsert![0]).toContain('onConflict: "user_id,scope"');
    const hook = EDITOR.match(/useEstimateView\([^)]*\)/);
    expect(hook![0]).toBe("useEstimateView(app.userId, !app.writesDisabled)");
  });

  it("offers the calculator's fees and a custom line, all as ordinary lines", () => {
    expect(SHEET).toContain("FEE_PRESETS.map(");
    expect(SHEET).toContain("Add custom line");
    const values = LIB.match(/export function customLineValues[\s\S]*?return \{[\s\S]*?\};/);
    expect(values![0]).toContain("catalog_item_id: null");
    expect(values![0]).toContain("code: null");
  });

  it("does not reach into the calculator's own model or data", () => {
    // Imports, not text: the comments say out loud that the two stay apart.
    const imports = (src: string) => src.match(/from "[^"]+"/g) ?? [];
    for (const file of [SHEET, LIB]) {
      expect(imports(file).some((i) => /job-calcul/.test(i))).toBe(false);
      expect(file.match(/from\("job_calculations"\)/)).toBeNull();
    }
  });
});
