import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { assetTagKey, normalizeAssetTag } from "@/lib/equipment-scan";

/*
 * The pre-printed tag register (26 Oct, 20261026120000_equipment_tag_register):
 * its plates must be matched in SQL exactly as the scanner matches them, and
 * be tag-shaped so the scanner prefers them over a manufacturer's label and a
 * typed or Bluetooth-scanned one looks itself up. The import itself is proved
 * in supabase/tests/equipment-tag-register.pglite.mjs.
 */
const SQL = readFileSync("supabase/migrations/20261026120000_equipment_tag_register.sql", "utf8");
const SHEETS = ["NY", "NYU", "NJ", "MD", "MI", "GA", "HTX", "NC", "IL", "IN", "CA", "CAT1", "CAT2"];

describe("pre-printed equipment tags and the scanner", () => {
  it("matches the way the scanner does: the SQL key is assetTagKey of the printed tag", () => {
    // The migration builds the key as 'GSR' || type || number || sheet.
    expect(SQL).toMatch(/'GSR' \|\| t\.code \|\| lpad\(n::text, 5, '0'\) \|\| s\.sheet/);
    expect(SQL).toMatch(/upper\(regexp_replace\(e\.asset_tag, '\[\^A-Za-z0-9\]', '', 'g'\)\)/);
    for (const sheet of SHEETS) {
      const tag = `GSR-AM00034-${sheet}`;
      expect(assetTagKey(tag)).toBe(`GSRAM00034${sheet}`);
    }
  });

  it("every sheet's plate is tag-shaped, so the scanner prefers it and a typed one looks itself up", () => {
    for (const sheet of SHEETS) {
      for (const type of ["AM", "DU", "AS"]) {
        const tag = `GSR-${type}00001-${sheet}`;
        expect(normalizeAssetTag(tag), tag).toBe(tag);
        expect(normalizeAssetTag(tag.toLowerCase().replace(/-/g, " ")), tag).toBe(tag);
      }
    }
    // Still not plates: no separators, a shipping label, a bare word.
    expect(normalizeAssetTag("GSRAM00001NYU")).toBeNull();
    expect(normalizeAssetTag("1Z999AA10123456784")).toBeNull();
    expect(normalizeAssetTag("HELLO")).toBeNull();
  });
});
