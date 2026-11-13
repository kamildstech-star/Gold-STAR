import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  assetTagKey,
  assetTagPattern,
  cameraLookupTag,
  matchAssetTag,
  normalizeAssetTag,
} from "@/lib/equipment-scan";
import { parseEquipmentImport, registerTagIndex } from "@/lib/equipment-import";
import { codeTakenBy, resolveSupplyCode } from "@/lib/supply-scan";

/*
 * 22 Oct: GSR-00037-NJ scanned must find GSR00037NJ in the register, and the
 * other way round. One rule (assetTagKey) wherever a tag is compared; tags
 * are stored and shown as they are.
 */
const tag = (t: { asset_tag: string }) => t.asset_tag;
const reg = (...tags: string[]) => tags.map((asset_tag, i) => ({ id: `u${i}`, asset_tag }));

describe("the matching rule", () => {
  it("dashed scan finds an undashed register tag", () => {
    const m = matchAssetTag("GSR-00037-NJ", reg("GSR00037NJ"), tag);
    expect(m).toMatchObject({ kind: "match", item: { asset_tag: "GSR00037NJ" }, exact: false });
  });

  it("undashed scan finds a dashed register tag", () => {
    const m = matchAssetTag("GSR00037NJ", reg("GSR-00037-NJ"), tag);
    expect(m).toMatchObject({ kind: "match", item: { asset_tag: "GSR-00037-NJ" } });
  });

  it("ignores case, spaces, underscores and phone-keyboard dashes", () => {
    for (const raw of [
      "gsr-00037-nj",
      "GSR 00037 NJ",
      "gsr_00037_nj",
      "GSR–00037—NJ",
      " GSR00037nj ",
    ]) {
      expect(matchAssetTag(raw, reg("GSR-00037-NJ"), tag).kind, raw).toBe("match");
    }
    expect(assetTagKey("GSR-00037-NJ")).toBe(assetTagKey("gsr 00037 nj"));
  });

  it("does not match a different tag", () => {
    expect(matchAssetTag("GSR-00038-NJ", reg("GSR-00037-NJ"), tag).kind).toBe("none");
    expect(matchAssetTag("", reg("GSR-00037-NJ"), tag).kind).toBe("none");
  });

  it("prefers the exact tag when two register tags collide", () => {
    const both = reg("GSR-001", "GSR001");
    expect(matchAssetTag("GSR-001", both, tag)).toMatchObject({
      kind: "match",
      item: { asset_tag: "GSR-001" },
      exact: true,
    });
    expect(matchAssetTag("gsr001", both, tag)).toMatchObject({
      kind: "match",
      item: { asset_tag: "GSR001" },
      exact: true,
    });
  });

  it("asks which one on a tie with no exact match", () => {
    const m = matchAssetTag("GSR 001", reg("GSR-0-01", "GSR001"), tag);
    // "GSR 001" cleans to GSR-001: neither GSR-0-01 nor GSR001 is written that way.
    expect(m.kind).toBe("ambiguous");
    expect(m.kind === "ambiguous" && m.items.map((i) => i.asset_tag).sort()).toEqual([
      "GSR-0-01",
      "GSR001",
    ]);
  });

  it("keeps the raw-scan plausibility check as it was", () => {
    expect(normalizeAssetTag("GSR-00037-NJ")).toBe("GSR-00037-NJ");
    expect(normalizeAssetTag("GSR00037NJ")).toBeNull(); // not plate-shaped…
    expect(cameraLookupTag("GSR00037NJ")).toEqual({ tag: "GSR00037NJ", strict: false }); // …but still looked up
    expect(cameraLookupTag("x")).toBeNull();
  });
});

describe("the register query matches every spelling of the key", () => {
  // Postgres ~* (PostgREST imatch); a JS RegExp with "i" reads it the same way.
  const re = (raw: string) => new RegExp(assetTagPattern(assetTagKey(raw)), "i");

  it("finds dashed and undashed, any case", () => {
    expect(re("GSR-00037-NJ").test("GSR00037NJ")).toBe(true);
    expect(re("GSR00037NJ").test("GSR-00037-NJ")).toBe(true);
    expect(re("gsr00037nj").test("GSR 00037 NJ")).toBe(true);
  });

  it("does not find a longer or different tag", () => {
    expect(re("GSR-0003-NJ").test("GSR-00037-NJ")).toBe(false);
    expect(re("GSR-00037-NJ").test("XGSR-00037-NJ")).toBe(false);
    expect(re("GSR-00037-NJ").test("GSR-00037-NJ2")).toBe(false);
  });

  it("is what the lookup sends", () => {
    const src = readFileSync("src/lib/equipment-scan.ts", "utf8");
    expect(src).toMatch(/\.filter\("asset_tag", "imatch", assetTagPattern\(key\)\)/);
    expect(src).not.toMatch(/\.ilike\("asset_tag", tag\)/);
  });
});

describe("the register import uses the same rule", () => {
  const types = [{ key: "air_mover", label: "Air Mover" }];
  const offices = [{ id: "nj", code: "NJ", name: "Lakewood" }];
  const ctx = (units: { id: string; asset_tag: string }[]) => ({
    types,
    offices,
    defaultOfficeId: "nj",
    existing: registerTagIndex(units),
  });

  it("updates GSR00037NJ when the sheet says GSR-00037-NJ, instead of adding a duplicate", () => {
    const r = parseEquipmentImport(
      "Tag,Type\nGSR-00037-NJ,Air mover",
      ctx([{ id: "eq-1", asset_tag: "GSR00037NJ" }]),
    );
    expect(r.kind === "rows" && r.rows[0]!.existingId).toBe("eq-1");
    // Stored as the sheet wrote it — matching, not a rewrite.
    expect(r.kind === "rows" && r.rows[0]!.tag).toBe("GSR-00037-NJ");
  });

  it("matches the exact one when the register holds both spellings", () => {
    const r = parseEquipmentImport(
      "Tag,Type\nGSR-001,Air mover",
      ctx([
        { id: "a", asset_tag: "GSR-001" },
        { id: "b", asset_tag: "GSR001" },
      ]),
    );
    expect(r.kind === "rows" && r.rows[0]!.existingId).toBe("a");
  });

  it("refuses to guess on a tie, and says which tags", () => {
    const r = parseEquipmentImport(
      "Tag,Type\nGSR 0 01,Air mover",
      ctx([
        { id: "a", asset_tag: "GSR-001" },
        { id: "b", asset_tag: "GSR001" },
      ]),
    );
    expect(r.kind === "rows" && r.rows).toEqual([]);
    expect(r.kind === "rows" && r.problems[0]!.reason).toMatch(/GSR-001, GSR001.*which one/);
  });

  it("treats GSR-00037-NJ and GSR00037NJ in one sheet as the same unit", () => {
    const r = parseEquipmentImport(
      "Tag,Type\nGSR-00037-NJ,Air mover\nGSR00037NJ,Air mover",
      ctx([]),
    );
    expect(r.kind === "rows" && r.rows.map((x) => x.tag)).toEqual(["GSR00037NJ"]);
    expect(r.kind === "rows" && r.problems[0]!.reason).toMatch(
      /appears again on line 3 as GSR00037NJ/,
    );
  });
});

describe("supplies scan-out uses the same rule", () => {
  const item = (id: string, code: string) => ({ id, name: id, sku: code }) as never;

  it("BIN12 finds BIN-12 and back", () => {
    expect(resolveSupplyCode("BIN12", [item("a", "BIN-12")])).toMatchObject({ kind: "found" });
    expect(resolveSupplyCode("bin-12", [item("a", "BIN12")])).toMatchObject({ kind: "found" });
  });

  it("refuses a code that would collide under the rule", () => {
    expect(codeTakenBy("BIN12", [item("a", "BIN-12")], "b")).toMatchObject({ id: "a" });
  });
});
