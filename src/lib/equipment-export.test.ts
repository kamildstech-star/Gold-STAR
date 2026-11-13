// @vitest-environment jsdom
//
// "Export the register, re-import it, 388 units land unchanged." That sentence
// is the QC test for the Equipment page's export, and this file is it, run
// end to end on the real code: register rows → the page's export columns →
// buildXlsx (and buildCsv) → workbook-read → parseEquipmentImport → the patch
// Import register would write. Every unit has to come back as an UPDATE of
// itself that writes exactly the values it already holds.
//
// No clock anywhere: nothing exported here is a date, and nothing reads one.
import { describe, expect, it } from "vitest";

import { equipmentExportColumns, exportTypeCell, type ExportableUnit } from "./equipment-export";
import {
  detectColumns,
  registerTagIndex,
  IMPORT_COLUMN_LABEL,
  importPatch,
  parseEquipmentImport,
  type ImportColumn,
} from "./equipment-import";
import { buildCsv, buildXlsx, sheetFromColumns } from "./export-table";
import { readWorkbook, sheetToImportText } from "./workbook-read";

/* ------------------------------------------------------------------ */
/* A register shaped like the real one                                 */
/* ------------------------------------------------------------------ */

const types = [
  { key: "air_mover", label: "Air mover" },
  { key: "dehumidifier", label: "Dehumidifier" },
  { key: "air_scrubber", label: "Air scrubber" },
  { key: "hepa", label: "HEPA (XXL)" },
  { key: "heater", label: "Heater" },
  { key: "moisture_meter", label: "Moisture meter" },
  { key: "other", label: "Other" },
];
const offices = [
  { id: "o-nj", code: "NJ", name: "New Jersey" },
  { id: "o-lw", code: "LW", name: "Lakewood" },
  { id: "o-fl", code: "FL", name: "Florida" },
];
const columns = equipmentExportColumns({ types, offices });

type Unit = ExportableUnit & { id: string };

/** 388 units, cycling through every awkward thing a real register holds. */
function register(): Unit[] {
  const typeKeys = ["air_mover", "dehumidifier", "air_scrubber", "hepa", "heater", "other"];
  const prefix: Record<string, string> = {
    air_mover: "AM",
    dehumidifier: "DH",
    air_scrubber: "AS",
    hepa: "HP",
    heater: "HT",
    other: "OT",
  };
  return Array.from({ length: 388 }, (_, i) => {
    const type = typeKeys[i % typeKeys.length]!;
    const office = offices[i % offices.length]!;
    return {
      id: `unit-${i}`,
      asset_tag: `GSR-${prefix[type]}${String(i + 1).padStart(5, "0")}-${office.code}`,
      equipment_type: type,
      equipment_type_detail:
        type === "other" ? ["Hydro mat", "Injectidry", "Floor drying system"][i % 3]! : null,
      location_id: office.id,
      // Leading zeros, a 20-digit serial, and no serial at all.
      serial_number:
        i % 7 === 0
          ? null
          : i % 11 === 0
            ? `0${100000 + i}`
            : i % 13 === 0
              ? "12345678901234567890"
              : String(880000 + i),
      make: i % 5 === 0 ? null : ["Dri-Eaz", "Phoenix", "Abatement Technologies"][i % 3]!,
      model: i % 4 === 0 ? null : ["LGR 7000XLi", "AirMax", "Sahara Pro X3, 120V"][i % 3]!,
      // Commas, quotes, and a note far longer than the old 200-character cap.
      notes:
        i % 9 === 0
          ? null
          : i % 10 === 0
            ? `Long history: ${"returned from job, cleaned, filter changed; ".repeat(10)}`.trim()
            : i % 6 === 0
              ? 'Says "do not use" on the side, ignore it'
              : `Bay ${i % 12}, shelf ${i % 4}`,
    };
  });
}

/** The tags already on the register, keyed the way the import dialog keys them. */
function existingOf(units: readonly Unit[]) {
  return registerTagIndex(units);
}

/** What Import register would write for a unit whose sheet row matched it exactly. */
function expectedPatch(u: Unit): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    equipment_type: u.equipment_type,
    location_id: u.location_id,
  };
  if (u.equipment_type === "other" && u.equipment_type_detail) {
    patch.equipment_type_detail = u.equipment_type_detail;
  }
  if (u.serial_number) patch.serial_number = u.serial_number;
  if (u.make) patch.make = u.make;
  if (u.model) patch.model = u.model;
  if (u.notes) patch.notes = u.notes;
  return patch;
}

function reimport(text: string, units: readonly Unit[]) {
  return parseEquipmentImport(text, {
    types,
    offices,
    defaultOfficeId: null,
    existing: existingOf(units),
  });
}

/** The full round trip, asserted: every unit back as an update of itself, unchanged. */
function expectUnchanged(result: ReturnType<typeof reimport>, units: readonly Unit[]) {
  expect(result.kind).toBe("rows");
  if (result.kind !== "rows") return;
  expect(result.problems).toEqual([]);
  expect(result.rows).toHaveLength(units.length);
  // Nothing added: every row found its own unit.
  expect(result.rows.filter((r) => !r.existingId)).toEqual([]);
  result.rows.forEach((row, i) => {
    const unit = units[i]!;
    expect(row.existingId).toBe(unit.id);
    expect(importPatch(row)).toEqual(expectedPatch(unit));
  });
}

function xlsxText(units: readonly Unit[]): string {
  const bytes = buildXlsx([sheetFromColumns("Equipment", units, columns)]);
  const read = readWorkbook(bytes.slice().buffer as ArrayBuffer);
  if (!read.ok) throw new Error(read.reason);
  return sheetToImportText(read.sheets[0]!, (cells) => detectColumns(cells).tag != null).text;
}

/* ------------------------------------------------------------------ */

describe("the export's columns are the import's columns", () => {
  it("writes exactly the import's headers, in the order its dialog names them", () => {
    expect(columns.map((c) => c.label)).toEqual([
      "Tag",
      "Type",
      "Office",
      "Serial",
      "Make",
      "Model",
      "Notes",
    ]);
    expect(columns.map((c) => c.label)).toEqual(
      (["tag", "type", "office", "serial", "make", "model", "notes"] as ImportColumn[]).map(
        (c) => IMPORT_COLUMN_LABEL[c],
      ),
    );
  });

  it("is read back by the import's own header matching, every column found", () => {
    const found = detectColumns(columns.map((c) => c.label));
    expect(Object.keys(found).sort()).toEqual(
      ["make", "model", "notes", "office", "serial", "tag", "type"].sort(),
    );
  });

  it("writes every cell as text, so a serial keeps its leading zeros", () => {
    expect(columns.every((c) => c.type === "text")).toBe(true);
  });
});

describe("export the register, re-import it", () => {
  const units = register();

  it("as .xlsx: 388 units land unchanged, each an update of itself", () => {
    expectUnchanged(reimport(xlsxText(units), units), units);
  });

  it("as CSV: the same 388 units, the same way", () => {
    const csv = buildCsv(sheetFromColumns("Equipment", units, columns));
    expectUnchanged(reimport(csv, units), units);
  });

  it("keeps a long note whole rather than cutting it at 200 characters", () => {
    const long = units.find((u) => (u.notes ?? "").length > 400)!;
    const result = reimport(xlsxText([long]), [long]);
    expect(result.kind === "rows" && result.rows[0]!.notes).toBe(long.notes);
  });

  it("finds a hand-typed tag on the register even though the import cleans it", () => {
    // Typed into Add equipment as-is; the import reads it back as GSR-AM00001-NJ.
    const typed: Unit = { ...units[0]!, asset_tag: "gsr am00001_nj" };
    const result = reimport(xlsxText([typed]), [typed]);
    expect(result.kind === "rows" && result.rows[0]!.existingId).toBe(typed.id);
  });

  it("exports what is on screen: a filtered slice round-trips just the same", () => {
    const lakewoodDehus = units.filter(
      (u) => u.location_id === "o-lw" && u.equipment_type === "dehumidifier",
    );
    expect(lakewoodDehus.length).toBeGreaterThan(0);
    expectUnchanged(reimport(xlsxText(lakewoodDehus), units), lakewoodDehus);
  });
});

describe("the cells that need care", () => {
  const base: ExportableUnit = {
    asset_tag: "GSR-OT00001-NJ",
    equipment_type: "other",
    equipment_type_detail: "Hydro mat",
    location_id: "o-nj",
    serial_number: null,
    make: null,
    model: null,
    notes: null,
  };

  it("writes an Other unit's own words as its type, which the import files as Other", () => {
    expect(exportTypeCell(base, types)).toBe("Hydro mat");
  });

  it("writes Other when the unit's words would be read as a different type", () => {
    // "fan" is an air mover to the import; exporting it would change the type.
    expect(exportTypeCell({ ...base, equipment_type_detail: "fan" }, types)).toBe("Other");
  });

  it("puts a multi-line note on one line, which is how either import reads it", () => {
    const unit = { ...base, notes: "Line one\r\nLine two\n\tindented" };
    const notes = columns.find((c) => c.key === "notes")!;
    expect(notes.get(unit)).toBe("Line one Line two indented");
  });

  it("names the office by its code, falling back to the name", () => {
    const office = columns.find((c) => c.key === "office")!;
    expect(office.get(base)).toBe("NJ");
    const noCode = equipmentExportColumns({
      types,
      offices: [{ id: "o-nj", code: "", name: "New Jersey" }],
    }).find((c) => c.key === "office")!;
    expect(noCode.get(base)).toBe("New Jersey");
  });
});
