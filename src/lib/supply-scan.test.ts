import { describe, expect, it } from "vitest";

import {
  codeTakenBy,
  describeResolution,
  normalizeSupplyCode,
  resolveSupplyCode,
  SUPPLY_NO_MATCH_TITLE,
  supplyItemCode,
  supplyScanOutcome,
} from "@/lib/supply-scan";
import type { SupplyItem } from "@/lib/supplies";

/**
 * Turning a scanned code into a catalogue item.
 *
 * David, 16 Sep, point 21: depletion shipped manual-first with a seam for scan,
 * and the decision came back to add scan as well — both ways must work, through
 * the same mechanism.
 *
 * The rule worth guarding hardest is that this NEVER GUESSES. A resolver that
 * returned the first plausible match would take stock off a shelf nobody
 * touched, and nobody would find out until a count came up short weeks later.
 * Every input below has one stated outcome, and "I could not tell" is one of
 * them.
 */

const item = (over: Partial<SupplyItem> & { id: string; name: string }): SupplyItem =>
  ({
    unit: "each",
    category: null,
    is_active: true,
    sort_order: 100,
    created_by: null,
    created_at: "",
    updated_at: "",
    unit_cost: null,
    ...over,
  }) as unknown as SupplyItem;

const GLOVES = item({ id: "i1", name: "Nitrile Gloves 100 Box", sku: "BIN-12" } as never);
const TAPE = item({ id: "i2", name: "Duct Tape", sku: "BIN-07" } as never);
const NO_CODE = item({ id: "i3", name: "Shop rags" });
const CATALOGUE = [GLOVES, TAPE, NO_CODE];

describe("supplyItemCode", () => {
  it("reads the code an item carries", () => {
    expect(supplyItemCode(GLOVES)).toBe("BIN-12");
  });

  it("is null for an item nobody has labeled yet", () => {
    // Which is most of them: David's sheet had no SKUs at all.
    expect(supplyItemCode(NO_CODE)).toBeNull();
  });

  it("treats a whitespace-only code as no code", () => {
    expect(supplyItemCode(item({ id: "x", name: "x", sku: "   " } as never))).toBeNull();
  });
});

describe("normalizeSupplyCode", () => {
  it("ignores the case the scanner happens to report", () => {
    expect(normalizeSupplyCode("bin-12")).toBe("BIN-12");
  });

  it("ignores whitespace around a read", () => {
    expect(normalizeSupplyCode("  BIN-12 \n")).toBe("BIN-12");
  });

  it("repairs the dash a phone keyboard substitutes", () => {
    // An en dash for a hyphen is the most common manual-entry mistake there is,
    // and it turns a real bin into "not found".
    expect(normalizeSupplyCode("BIN–12")).toBe("BIN-12");
    expect(normalizeSupplyCode("BIN—12")).toBe("BIN-12");
  });

  it("collapses an inner space into the separator", () => {
    expect(normalizeSupplyCode("BIN 12")).toBe("BIN-12");
  });

  it("is empty for nothing at all", () => {
    expect(normalizeSupplyCode("")).toBe("");
    expect(normalizeSupplyCode(null)).toBe("");
    expect(normalizeSupplyCode(undefined)).toBe("");
  });
});

describe("resolveSupplyCode — exact match", () => {
  it("finds the item whose code was scanned", () => {
    const out = resolveSupplyCode("BIN-12", CATALOGUE);
    expect(out.kind).toBe("found");
    if (out.kind === "found") expect(out.item.id).toBe("i1");
  });

  it("matches regardless of the case and spacing of the read", () => {
    for (const raw of ["bin-12", " BIN-12 ", "Bin 12", "bin–12"]) {
      const out = resolveSupplyCode(raw, CATALOGUE);
      expect(out.kind, `failed on ${raw}`).toBe("found");
      if (out.kind === "found") expect(out.item.id).toBe("i1");
    }
  });

  it("matches an item whose stored code is untidy", () => {
    // The code is normalised on BOTH sides, so a code typed into Catalog as
    // " bin-99 " still resolves.
    const untidy = item({ id: "i9", name: "Poly", sku: " bin-99 " } as never);
    const out = resolveSupplyCode("BIN-99", [untidy]);
    expect(out.kind).toBe("found");
  });
});

describe("resolveSupplyCode — unknown code", () => {
  it("says so rather than guessing at the nearest item", () => {
    const out = resolveSupplyCode("BIN-99", CATALOGUE);
    expect(out.kind).toBe("unknown");
    if (out.kind === "unknown") expect(out.code).toBe("BIN-99");
  });

  it("never matches an item that has no code at all", () => {
    // Otherwise every uncoded item would answer to an empty read.
    expect(resolveSupplyCode("", CATALOGUE).kind).toBe("empty");
    expect(resolveSupplyCode("   ", CATALOGUE).kind).toBe("empty");
  });

  it("is unknown against an empty catalog rather than throwing", () => {
    expect(resolveSupplyCode("BIN-12", []).kind).toBe("unknown");
  });

  it("offers the manual picker in its own wording", () => {
    const text = describeResolution(resolveSupplyCode("BIN-99", CATALOGUE));
    expect(text).toContain("BIN-99");
    expect(text).toMatch(/pick it from the list/i);
  });
});

describe("resolveSupplyCode — duplicate code", () => {
  const twins = [
    item({ id: "a", name: "Gloves M", sku: "BIN-12" } as never),
    item({ id: "b", name: "Gloves L", sku: "bin-12" } as never),
  ];

  it("refuses to pick one, because depleting the wrong shelf is silent", () => {
    const out = resolveSupplyCode("BIN-12", twins);
    expect(out.kind).toBe("ambiguous");
    if (out.kind === "ambiguous") expect(out.items.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("names both items so the duplicate can be fixed", () => {
    const text = describeResolution(resolveSupplyCode("BIN-12", twins));
    expect(text).toContain("Gloves M");
    expect(text).toContain("Gloves L");
    expect(text).toMatch(/fix the duplicate/i);
  });
});

describe("codeTakenBy — refusing a duplicate before the database has to", () => {
  it("names the item already holding the code", () => {
    expect(codeTakenBy("BIN-07", CATALOGUE, "i1")?.id).toBe("i2");
  });

  it("lets an item keep its own code", () => {
    // Saving Gloves again without touching its code must not be a conflict.
    expect(codeTakenBy("BIN-12", CATALOGUE, "i1")).toBeNull();
  });

  it("catches a duplicate typed in a different case or spacing", () => {
    expect(codeTakenBy(" bin 07 ", CATALOGUE, "i1")?.id).toBe("i2");
  });

  it("allows a blank code, because most items have none", () => {
    expect(codeTakenBy("", CATALOGUE, "i1")).toBeNull();
    expect(codeTakenBy(null, CATALOGUE, "i1")).toBeNull();
  });
});

describe("supplyScanOutcome — what Scan out does with a read", () => {
  it("pre-fills the mark-down form with the matched item at quantity 1", () => {
    expect(supplyScanOutcome("bin-12", CATALOGUE)).toEqual({ kind: "fill", item: GLOVES, qty: 1 });
  });

  it("refuses a code nothing carries, naming the code, instead of closing silently", () => {
    const out = supplyScanOutcome("BIN-99", CATALOGUE);
    expect(out).toMatchObject({ kind: "reject", code: "BIN-99", title: SUPPLY_NO_MATCH_TITLE });
    expect(out.kind === "reject" && out.message).toContain("BIN-99");
  });

  it("says so plainly when no item in the catalog has a code at all", () => {
    const uncoded = [item({ id: "u1", name: "Gloves" }), item({ id: "u2", name: "Tape" })];
    const out = supplyScanOutcome("BIN-12", uncoded);
    expect(out).toMatchObject({ kind: "reject", code: "BIN-12", title: SUPPLY_NO_MATCH_TITLE });
    expect(out.kind === "reject" && out.message).toMatch(/No item in the catalog has a code yet/);
  });

  it("refuses a duplicated code rather than picking one", () => {
    const twin = item({ id: "i9", name: "Other Gloves", sku: "bin-12" } as never);
    expect(supplyScanOutcome("BIN-12", [GLOVES, twin])).toMatchObject({
      kind: "reject",
      title: "More than one item has this code",
    });
  });
});
