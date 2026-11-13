// Mark, next to Import register on the Equipment page: "need to accept .xslx".
//
// There is no DOM testing library here, so the dialog's wiring is asserted on
// its source. Each check pulls out the one fragment it is about — asserting on
// the whole file means a comment can satisfy or break the assertion, and this
// file is full of comments about .xlsx.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// CRLF on a Windows checkout, LF in an agent worktree. A pattern that ends at
// a line break otherwise passes where it was written and fails on main.
const DIALOG = readFileSync("src/components/equipment-import-dialog.tsx", "utf8").replace(
  /\r\n/g,
  "\n",
);

/** The file picker's accept list, exactly as the input declares it. */
const ACCEPT = /accept="([^"]*)"/.exec(DIALOG)?.[1] ?? "";

describe("the equipment import file picker", () => {
  it("accepts .xlsx as well as the CSV it always took", () => {
    expect(ACCEPT).toContain(".xlsx");
    expect(ACCEPT).toContain("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(ACCEPT).toContain(".csv");
    expect(ACCEPT).toContain("text/csv");
  });

  it("no longer tells the user to go convert the file themselves", () => {
    expect(DIALOG).not.toContain("save it as CSV");
    expect(DIALOG).not.toContain("paste the rows here, or save it");
  });

  it("says what it takes, in the help text under the box", () => {
    const help = /Takes \.xlsx and \.csv\.[^<]*/.exec(DIALOG)?.[0] ?? "";
    expect(help).toContain(".xlsx");
    expect(help).toContain(".csv");
  });
});

describe("one import path", () => {
  /** The whole body of chooseFile, which is where a second path would grow. */
  const CHOOSE = /async function chooseFile\([\s\S]*?\n {2}}\n/.exec(DIALOG)?.[0] ?? "";

  it("turns a workbook into the same text a paste produces", () => {
    expect(CHOOSE).toContain("sheetToImportText");
    expect(CHOOSE).toContain("setText(");
  });

  it("lazy-loads the workbook reader, so only an .xlsx pays for it", () => {
    expect(CHOOSE).toMatch(/await import\("@\/lib\/workbook-read"\)/);
    // Static imports of that module would put it in the page's own chunk.
    expect(DIALOG).not.toMatch(/^import .*from "@\/lib\/workbook-read";$/m);
  });

  it("reads a non-xlsx file as text, the way it always did", () => {
    expect(CHOOSE).toMatch(/\.xlsx\$\/i\.test\(file\.name\)/);
    expect(CHOOSE).toContain("await file.text()");
  });

  it("keeps parseEquipmentImport as the only parser either path reaches", () => {
    expect(DIALOG.match(/parseEquipmentImport\(/g)).toHaveLength(1);
  });

  it("asks the importer's own column matching which row is the header", () => {
    const predicate = /const hasTagHeader = [^;]+;/.exec(DIALOG)?.[0] ?? "";
    expect(predicate).toContain("detectColumns");
  });
});

describe("the preview still governs", () => {
  it("imports the parsed rows, not the raw file", () => {
    const commit = /async function commit\(\)[\s\S]*?\n {2}}\n/.exec(DIALOG)?.[0] ?? "";
    expect(commit).toContain("rows");
    expect(commit).not.toContain("workbook");
  });

  it("names the sheet it read, and the row the headers were on", () => {
    const note = /Reading <b>\{showingSheet\.name\}<\/b>[\s\S]*?headerRow\}/.exec(DIALOG)?.[0];
    expect(note).toBeTruthy();
  });
});
