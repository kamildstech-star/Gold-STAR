import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("idb-keyval", () => ({ get: vi.fn(), set: vi.fn() }));

import {
  importPatch,
  mapEquipmentType,
  mapOffice,
  parseEquipmentImport,
  registerTagIndex,
} from "./equipment-import";

/**
 * David, 24 Sep, after a scan said "this piece of equipment is not in the
 * database": "We're going to have to upload that spreadsheet that I sent
 * you... or if this is a section where we could upload it."
 */

const types = [
  { key: "air_mover", label: "Air mover" },
  { key: "dehumidifier", label: "Dehumidifier" },
  { key: "air_scrubber", label: "Air scrubber" },
  { key: "hepa", label: "HEPA" },
  { key: "other", label: "Other" },
];
const offices = [
  { id: "nj", code: "NJ", name: "Lakewood" },
  { id: "ny", code: "NY", name: "Brooklyn" },
];
const ctx = (existing: [string, string][] = []) => ({
  types,
  offices,
  defaultOfficeId: null,
  // [tag, id] pairs, indexed the way the dialog indexes the register.
  existing: registerTagIndex(existing.map(([asset_tag, id]) => ({ id, asset_tag }))),
});

describe("a unit list, one row per tag", () => {
  it("finds columns by header in any order, and cleans tags", () => {
    const r = parseEquipmentImport(
      "Office,Asset Tag,Equipment Type,Serial\nNJ,gsr am00034 nj,Air Mover,88213\nBrooklyn,GSR-DH00101-NY,dehu,",
      ctx(),
    );
    expect(r.kind).toBe("rows");
    if (r.kind !== "rows") return;
    expect(r.rows.map((x) => [x.tag, x.typeKey, x.officeId, x.serial])).toEqual([
      ["GSR-AM00034-NJ", "air_mover", "nj", "88213"],
      ["GSR-DH00101-NY", "dehumidifier", "ny", null],
    ]);
    expect(r.problems).toEqual([]);
  });

  it("reads a paste from the spreadsheet (tabs)", () => {
    const r = parseEquipmentImport("Tag\tType\tOffice\nGSR-SC00007-NJ\tScrubber XL\tNJ", ctx());
    expect(r.kind === "rows" && r.rows[0]!.typeKey).toBe("air_scrubber");
  });

  it("updates an existing tag instead of adding a duplicate", () => {
    const r = parseEquipmentImport(
      "Tag,Type,Office\nGSR-AM00034-NJ,Air mover,NJ",
      ctx([["gsr-am00034-nj", "eq-1"]]),
    );
    expect(r.kind === "rows" && r.rows[0]!.existingId).toBe("eq-1");
  });

  it("uses the later line when a tag repeats, and says so", () => {
    const r = parseEquipmentImport("Tag,Type,Office\nA-1-NJ,Dehu,NJ\nA-1-NJ,Air mover,NJ", ctx());
    if (r.kind !== "rows") throw new Error("rows");
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.typeKey).toBe("air_mover");
    expect(r.problems[0]!.reason).toMatch(/appears again on line 3/);
  });

  it("refuses rows it cannot place, without dropping the rest", () => {
    const r = parseEquipmentImport(
      "Tag,Type,Office\n,Dehu,NJ\nB-2-NJ,Dehu,Texas\nC-3-NJ,Dehu,",
      ctx(),
    );
    if (r.kind !== "rows") throw new Error("rows");
    expect(r.rows).toHaveLength(0);
    expect(r.problems.map((p) => p.reason)).toEqual([
      "No tag.",
      'Office "Texas" is not one of yours.',
      "No office — choose a default office above.",
    ]);
    const withDefault = parseEquipmentImport("Tag,Type,Office\nC-3-NJ,Dehu,", {
      ...ctx(),
      defaultOfficeId: "ny",
    });
    expect(withDefault.kind === "rows" && withDefault.rows[0]!.officeId).toBe("ny");
  });
});

describe("types and offices", () => {
  it("maps David's names and lands the rest honestly as Other", () => {
    expect(mapEquipmentType("LGR", types)).toEqual({ key: "dehumidifier", detail: null });
    expect(mapEquipmentType("XXL", types)).toEqual({ key: "hepa", detail: null });
    expect(mapEquipmentType("Air Movers", types)).toEqual({ key: "air_mover", detail: null });
    expect(mapEquipmentType("Ozone machine", types)).toEqual({
      key: "other",
      detail: "Ozone machine",
    });
  });

  it("matches an office by code or name", () => {
    expect(mapOffice("nj", offices)?.id).toBe("nj");
    expect(mapOffice("brooklyn", offices)?.id).toBe("ny");
    expect(mapOffice("TX", offices)).toBeNull();
  });
});

describe("the count layout", () => {
  it("is recognized and refused, not imported as nonsense", () => {
    const r = parseEquipmentImport(
      "Job,Dehumidifier,Air mover,Scrubber\n1309 Ridge,2,6,1\n12 Oak,1,4,0",
      ctx(),
    );
    expect(r.kind).toBe("count_sheet");
  });

  it("a sheet with no tag column says what it needs", () => {
    expect(parseEquipmentImport("Name,Price\nx,1", ctx()).kind).toBe("no_header");
  });
});

describe("what a row writes", () => {
  it("never blanks a field the sheet left empty", () => {
    const patch = importPatch({
      line: 2,
      tag: "A-1-NJ",
      typeKey: "dehumidifier",
      typeDetail: null,
      officeId: "nj",
      serial: null,
      make: "Dri-Eaz",
      model: null,
      notes: null,
      existingId: "eq-1",
    });
    expect(patch).toEqual({ equipment_type: "dehumidifier", location_id: "nj", make: "Dri-Eaz" });
  });
});

describe("the dialog", () => {
  const DIALOG = readFileSync("src/components/equipment-import-dialog.tsx", "utf8");
  const PAGE = readFileSync("src/routes/_authenticated/equipment.index.tsx", "utf8");
  it("previews before it writes, and states the expected columns", () => {
    expect(DIALOG).toContain("<b>Tag</b>, <b>Type</b> and <b>Office</b>");
    expect(DIALOG).toMatch(/onClick=\{\(\) => void commit\(\)\}/);
    expect(DIALOG).toContain('.eq("id", r.existingId!)');
  });
  it("sits on the equipment page", () => {
    expect(PAGE).toContain(
      "<EquipmentImportDialog types={importTypes.options} onImported={load} />",
    );
  });
});
