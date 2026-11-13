// The Equipment page's Export — the half of #272's QC line ("export the
// register to xlsx, re-import it") the page was missing.
//
// The round trip itself is proved on the real code in
// src/lib/equipment-export.test.ts. What this file pins is that the PAGE uses
// that code: the import's columns, the rows on screen, the same type options
// the import dialog is given. No DOM testing library here, so each check
// pulls one fragment out of the source and asserts on that alone — never on
// the whole file, where a comment could answer for the code.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// CRLF on a Windows checkout, LF in an agent worktree.
const PAGE = readFileSync("src/routes/_authenticated/equipment.index.tsx", "utf8").replace(
  /\r\n/g,
  "\n",
);

const EXCEL = /<ExportExcelButton[\s\S]*?\/>/.exec(PAGE)?.[0] ?? "";
const CSV_FN = /const exportCsv = \(\) =>[\s\S]*?\n {4}}\);\n/.exec(PAGE)?.[0] ?? "";
const COLUMNS = /const exportColumns = useMemo\([\s\S]*?\);\n/.exec(PAGE)?.[0] ?? "";
const FILTERED = /const exportFiltered =[\s\S]*?;\n/.exec(PAGE)?.[0] ?? "";
const SELECT = /\.from\("equipment"\)\s*\.select\(\s*"([^"]*)"/.exec(PAGE)?.[1] ?? "";

describe("the Equipment page's export", () => {
  it("found every fragment it is about", () => {
    for (const fragment of [EXCEL, CSV_FN, COLUMNS, FILTERED, SELECT]) {
      expect(fragment).not.toBe("");
    }
  });

  it("writes the import's own columns, from the same type options the import is given", () => {
    expect(COLUMNS).toContain("equipmentExportColumns(");
    expect(COLUMNS).toContain("types: importTypes.options");
    expect(PAGE).toMatch(/<EquipmentImportDialog types=\{importTypes\.options\}/);
  });

  it("offers Excel and CSV, as the other list screens do, both through the export gate", () => {
    expect(EXCEL).toContain("columns: exportColumns");
    expect(CSV_FN).toContain("exportGate.runExport(");
    expect(CSV_FN).toContain('format: "csv"');
    expect(CSV_FN).toMatch(
      /downloadCsvSheet\(\s*exportReport,\s*sheetFromColumns\("Equipment", filtered, exportColumns\)/,
    );
  });

  it("exports the rows on screen, not a second query", () => {
    expect(EXCEL).toContain("rows: filtered");
    expect(CSV_FN).toContain("recordCount: filtered.length");
  });

  it("counts every narrowing the list has as a filter", () => {
    expect(FILTERED).toContain("app.currentLocationId");
    expect(FILTERED).toContain('search.type !== "all"');
    expect(FILTERED).toContain('search.status !== "all"');
    expect(FILTERED).toContain("search.q.trim()");
  });

  it("says on the buttons and in the file name when it is a filtered slice", () => {
    expect(EXCEL).toContain("label={exportLabel(");
    expect(EXCEL).toContain("report={exportReport}");
    const label = /const exportLabel = [^;]+;/.exec(PAGE)?.[0] ?? "";
    expect(label).toContain("(filtered)");
    const report = /const exportReport = [^;]+;/.exec(PAGE)?.[0] ?? "";
    expect(report).toContain('"equipment-register-filtered"');
    expect(report).toContain('"equipment-register"');
  });

  it("reads the two fields the export needs that the list never showed", () => {
    const fields = SELECT.split(",").map((f) => f.trim());
    expect(fields).toContain("notes");
    expect(fields).toContain("equipment_type_detail");
  });
});
