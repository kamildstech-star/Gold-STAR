import { describe, expect, it } from "vitest";

import {
  EMPTY_DRAFT,
  UNITS_BY_CATEGORY,
  applyEdit,
  draftToChanges,
  duplicateFromError,
  nameKey,
  pruneEdit,
  statusOf,
  validateDraft,
  type CatalogItem,
} from "@/lib/catalog";

const item = (over: Partial<CatalogItem> & Pick<CatalogItem, "code" | "name">): CatalogItem => ({
  category: "consumable",
  unit: "piece",
  unit_review: null,
  active: true,
  archived_at: null,
  sort_order: 10,
  updated_at: "2026-10-29T00:00:00Z",
  ...over,
});

const ITEMS: CatalogItem[] = [
  item({ code: "GL", name: "General Labor", category: "labor", unit: "hr" }),
  item({ code: "SL", name: "Skilled Labor", category: "labor", unit: "hr" }),
  item({ code: "100", name: "Anti-microbial agent", unit_review: "Carried over" }),
  item({ code: "126", name: "Encapsulant - per gal", unit: null, unit_review: "per gallon" }),
  item({ code: "PNT", name: "Painter", category: "labor", unit: "hr", archived_at: "2026-10-01" }),
];

describe("names", () => {
  it("compares names with case and spacing ignored", () => {
    expect(nameKey("  General   LABOR ")).toBe(nameKey("general labor"));
  });

  it("refuses a rename onto another item's name, naming that item", () => {
    const p = validateDraft(ITEMS, { edits: { SL: { name: "general  labor" } }, creates: [] });
    expect(p.get("SL")).toEqual([
      { field: "name", message: '"general  labor" already exists.', clashCode: "GL" },
    ]);
  });

  it("refuses a name swap in one save — the server renames one at a time", () => {
    const swap = validateDraft(ITEMS, {
      edits: { GL: { name: "Skilled Labor" }, SL: { name: "General Labor" } },
      creates: [],
    });
    expect(swap.get("GL")?.[0]?.clashCode).toBe("SL");
  });

  it("a name freed by a rename in the same save is still taken until saved", () => {
    const p = validateDraft(ITEMS, {
      edits: { GL: { name: "Laborer" } },
      creates: [{ tempId: "n", category: "labor", code: "GL2", name: "General Labor", unit: "hr" }],
    });
    expect(p.get("n")?.[0]?.clashCode).toBe("GL");
  });

  it("refuses a new item whose name an archived item already has", () => {
    const p = validateDraft(ITEMS, {
      edits: {},
      creates: [{ tempId: "n1", category: "labor", code: "PT", name: "painter", unit: "hr" }],
    });
    expect(p.get("n1")?.[0]).toMatchObject({ field: "name", clashCode: "PNT" });
  });

  it("refuses a blank name", () => {
    const p = validateDraft(ITEMS, { edits: { GL: { name: "   " } }, creates: [] });
    expect(p.get("GL")?.[0]?.message).toBe("Give the item a name.");
  });
});

describe("units", () => {
  it("lists only the units each category allows", () => {
    expect(UNITS_BY_CATEGORY.labor).toEqual(["hr", "day"]);
    expect(UNITS_BY_CATEGORY.consumable).not.toContain("hr");
  });

  it("does not block a save over a flagged item the save does not touch", () => {
    const p = validateDraft(ITEMS, { edits: { GL: { active: false } }, creates: [] });
    expect(p.size).toBe(0);
  });

  it("asks for a unit when an item without one is edited", () => {
    const p = validateDraft(ITEMS, { edits: { "126": { name: "Encapsulant" } }, creates: [] });
    expect(p.get("126")).toEqual([
      { field: "unit", message: "Choose a unit — this item has none yet." },
    ]);
  });

  it("a new item needs a unit that fits", () => {
    const p = validateDraft(ITEMS, {
      edits: {},
      creates: [
        { tempId: "n1", category: "consumable", code: "157", name: "Corner guard", unit: null },
      ],
    });
    expect(p.get("n1")).toEqual([{ field: "unit", message: "Choose a unit." }]);
  });

  it("choosing a unit confirms it; confirming keeps it", () => {
    expect(applyEdit(ITEMS[2]!, { unit: "box" })).toMatchObject({ unit: "box", unit_review: null });
    expect(applyEdit(ITEMS[2]!, { confirmUnit: true })).toMatchObject({
      unit: "piece",
      unit_review: null,
    });
  });
});

describe("codes", () => {
  it("refuses a code already in the catalog or used by the old book elsewhere", () => {
    const tm = new Map([["300", "equipment"]]);
    const p = validateDraft(
      ITEMS,
      {
        edits: {},
        creates: [
          { tempId: "a", category: "labor", code: "gl", name: "New A", unit: "hr" },
          { tempId: "b", category: "consumable", code: "300", name: "New B", unit: "piece" },
          { tempId: "c", category: "consumable", code: "no spaces!", name: "New C", unit: "piece" },
        ],
      },
      tm,
    );
    expect(p.get("a")?.[0]?.message).toBe("GL is already in the catalog.");
    expect(p.get("b")?.[0]?.message).toMatch(/already a T&M rate code under equipment/);
    expect(p.get("c")?.[0]?.message).toMatch(/letters, digits and dashes/);
  });
});

describe("the save", () => {
  it("sends only real changes, creates first, then updates by code", () => {
    const changes = draftToChanges(ITEMS, {
      edits: {
        SL: { name: "Skilled Labor" }, // unchanged → dropped
        GL: { name: " General Labour ", active: false },
        "100": { confirmUnit: true },
        PNT: { archived: false },
      },
      creates: [{ tempId: "n", category: "ppe", code: " 213 ", name: " Ear plugs ", unit: "box" }],
    });
    expect(changes).toEqual([
      { op: "create", code: "213", name: "Ear plugs", category: "ppe", unit: "box" },
      { op: "update", code: "100", unit: "piece" },
      { op: "update", code: "GL", name: "General Labour", active: false },
      { op: "update", code: "PNT", archived: false },
    ]);
  });

  it("an edit undone by hand leaves nothing pending", () => {
    expect(pruneEdit(ITEMS[0]!, { name: "General Labor", active: true })).toBeUndefined();
    expect(draftToChanges(ITEMS, EMPTY_DRAFT)).toEqual([]);
  });

  it("reads status, archive first", () => {
    expect(statusOf(ITEMS[4]!)).toBe("archived");
    expect(statusOf({ active: false, archived_at: null })).toBe("inactive");
    expect(statusOf(applyEdit(ITEMS[0]!, { archived: true }))).toBe("archived");
  });

  it("reads the other item from a refused save", () => {
    expect(duplicateFromError({ details: "catalog_duplicate_name:GL" })).toBe("GL");
    expect(duplicateFromError({ message: "nope" })).toBeNull();
  });
});
