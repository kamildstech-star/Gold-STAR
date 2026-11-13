import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { catalogueImportKey, catalogueRowFromSheet } from "@/lib/supply-spend";

/**
 * David's real supply catalogue, and the migration that loads it.
 *
 * Meeting point 18: the order form was rebuilt so its sections are the
 * catalogue's own categories, and it has been showing six example rows since,
 * waiting for his spreadsheet. The sheet arrived on 18 Sep — 84 items across
 * six categories, with no SKU, no supplier and no price column anywhere in it.
 *
 * Three things have to agree or the load is wrong in a way nobody would notice
 * until a crew ordered the wrong filter: the sheet in docs/, the mapping rules
 * in `catalogueRowFromSheet`, and the INSERT the migration actually runs. This
 * checks all three against each other rather than trusting any one of them.
 *
 * Source-level, per the house rules: there is no database here, and the
 * migration is a file like any other.
 */

const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

const CSV = read("docs/gsr-supplies-import.csv").trim();
const MIGRATION = read("supabase/migrations/20260918130000_supply_catalogue_david_sheet.sql");

/** A CSV line, honouring the doubled quotes David's sizes are full of. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

const SHEET = CSV.split("\n")
  .slice(1)
  .map((line) => {
    const [category, description, size, case_qty] = splitCsvLine(line);
    return { category, description, size, case_qty };
  });

/** The row's four SQL literals as the migration writes them. */
const sqlLiteral = (v: string | null | undefined) =>
  v == null || v === "" ? "NULL" : `'${v.replace(/'/g, "''")}'`;

describe("David's sheet", () => {
  it("is the 84 items across six categories he sent", () => {
    expect(SHEET).toHaveLength(84);
    const counts: Record<string, number> = {};
    for (const r of SHEET) counts[r.category] = (counts[r.category] ?? 0) + 1;
    expect(counts).toEqual({
      Adhesive: 8,
      Chemicals: 23,
      Plastic: 9,
      Filters: 17,
      // Two spaces, exactly as his sheet types it.
      "General  / Cleaning Supplies": 12,
      "Gloves / PPE": 15,
    });
  });

  it("repeats a description across sizes, which is why size is its own column", () => {
    const byName: Record<string, number> = {};
    for (const r of SHEET) {
      const k = r.description.trim().toLowerCase();
      byName[k] = (byName[k] ?? 0) + 1;
    }
    expect(byName["pleated filter merv 8"]).toBe(5);
    expect(byName["carbon filter (activated carbon)"]).toBe(4);
    expect(byName["nitrile gloves 100 box"]).toBe(3);
  });

  it("is unique on name plus size, which is what the catalog's index enforces", () => {
    // If this ever stops holding, the migration's INSERT silently drops rows
    // through ON CONFLICT DO NOTHING and the catalogue is quietly short.
    const keys = SHEET.map((r) =>
      catalogueImportKey({ name: r.description, size: r.size, sku: null }),
    );
    expect(new Set(keys).size).toBe(84);
  });
});

describe("catalogueRowFromSheet — the mapping, in one place", () => {
  it("makes the case quantity the ordering unit", () => {
    // Nobody orders one strip of duct tape; they order a 24 Case.
    const row = catalogueRowFromSheet({
      category: "Adhesive",
      description: "Duct Tape",
      size: '2"x60 Yard',
      case_qty: "24 Case",
    });
    expect(row).toMatchObject({
      name: "Duct Tape",
      size: '2"x60 Yard',
      unit: "24 Case",
      category: "Adhesive",
    });
  });

  it("keeps size and case quantity exactly as typed, capitalization and all", () => {
    // David's sheet has both "12 Case" and "12 case". Tidying them would be
    // inventing structure he did not ask for, so both survive as written.
    expect(
      catalogueRowFromSheet({
        description: "Pleated Filter Merv 8",
        size: "21x19x2",
        case_qty: "6 case",
      }).unit,
    ).toBe("6 case");
    expect(
      catalogueRowFromSheet({ description: "Terry Cloth Rags", case_qty: "25/50 LBS" }).unit,
    ).toBe("25/50 LBS");
    expect(
      catalogueRowFromSheet({ description: "Dry Spongaes", size: '1 1/2" x 3" x 6"' }).size,
    ).toBe('1 1/2" x 3" x 6"');
  });

  it("falls back to `each` where the sheet leaves the pack blank", () => {
    // A NOT NULL column has to say something, and "each" is the catalogue's own
    // default rather than a guess at what the case holds.
    expect(catalogueRowFromSheet({ description: "Peroxide 3%" }).unit).toBe("each");
    expect(catalogueRowFromSheet({ description: "Peroxide 3%" }).size).toBeNull();
  });

  it("collapses whitespace in the category and nowhere else", () => {
    // It is a card heading in the order form; the double gap in his
    // "General  / Cleaning Supplies" renders.
    expect(catalogueRowFromSheet({ category: "General  / Cleaning Supplies" }).category).toBe(
      "General / Cleaning Supplies",
    );
    expect(catalogueRowFromSheet({ description: "Yellow Tape  Serrated For Ram Board" }).name).toBe(
      "Yellow Tape  Serrated For Ram Board",
    );
  });

  it("leaves SKU, supplier and price empty, because the sheet has no such columns", () => {
    // Deliberate, not missing. A supplier and a price are facts about a
    // purchase; the purchaser side records both per receipt.
    const row = catalogueRowFromSheet({ description: "9D9", size: "1 Gallon", case_qty: "4 Case" });
    expect(row.sku).toBeNull();
    expect(row.defaultSupplier).toBeNull();
    expect(row.unitCost).toBeNull();
  });
});

describe("the migration loads exactly what the sheet says", () => {
  it("inserts a row for every one of the 84 items, mapped the same way", () => {
    for (const sheetRow of SHEET) {
      const row = catalogueRowFromSheet(sheetRow);
      const tuple = `(${sqlLiteral(row.name)}, ${sqlLiteral(row.size)}, ${sqlLiteral(row.unit)}, ${sqlLiteral(row.category)},`;
      expect(
        MIGRATION,
        `missing from the migration: ${row.name} / ${row.size ?? "no size"}`,
      ).toContain(tuple);
    }
  });

  it("inserts into the four columns the mapping fills, and sort_order", () => {
    expect(MIGRATION).toContain(
      "INSERT INTO public.supply_items (name, size, unit, category, sort_order)",
    );
  });

  it("writes no SKU, supplier or price for any item", () => {
    // The strongest form of "we did not invent one": the columns are not in
    // the INSERT at all.
    const insert = MIGRATION.slice(MIGRATION.indexOf("INSERT INTO public.supply_items"));
    expect(insert).not.toContain("sku");
    expect(insert).not.toContain("default_supplier");
    expect(insert).not.toContain("unit_cost");
  });

  it("clears the six example rows that were seeded for testing", () => {
    expect(MIGRATION).toContain("DELETE FROM public.supply_items WHERE sku LIKE 'EXAMPLE-%'");
  });

  it("carries an item's name onto anything that referenced it before deleting it", () => {
    // Both referring tables CHECK that a line names something and both foreign
    // keys are ON DELETE SET NULL, so deleting the item first would fail the
    // check — and a test request would lose what was asked for either way.
    expect(MIGRATION).toContain("UPDATE public.supply_request_lines l");
    expect(MIGRATION).toContain("UPDATE public.supply_purchases p");
    const deleteAt = MIGRATION.indexOf("DELETE FROM public.supply_items");
    expect(MIGRATION.indexOf("UPDATE public.supply_request_lines l")).toBeLessThan(deleteAt);
    expect(MIGRATION.indexOf("UPDATE public.supply_purchases p")).toBeLessThan(deleteAt);
  });

  it("makes a name unique PER SIZE, so five Merv 8 filters all fit", () => {
    // The old index was unique on lower(name) alone and would have rejected
    // four of the five.
    expect(MIGRATION).toContain("DROP INDEX IF EXISTS public.supply_items_name_key");
    expect(MIGRATION).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS supply_items_name_size_key\s+ON public\.supply_items \(lower\(name\), lower\(coalesce\(size, ''\)\)\)/,
    );
  });

  it("can be run twice without doubling the catalog", () => {
    expect(MIGRATION).toContain("ON CONFLICT DO NOTHING");
    expect(MIGRATION).toContain("ADD COLUMN IF NOT EXISTS size text");
  });
});
