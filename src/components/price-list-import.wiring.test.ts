// The price-list import takes the vendor's .xlsx itself, the way the
// equipment import does since #272, and through the same one parser.
//
// There is no DOM testing library here, so the dialog's wiring is asserted on
// its source. Each check pulls out the one fragment it is about — asserting on
// the whole file means a comment can satisfy or break the assertion. The
// dialog lives in the route file; this test lives here so the router never
// mistakes it for a route.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// CRLF on a Windows checkout, LF in an agent worktree. A pattern that ends at
// a line break otherwise passes where it was written and fails on main.
const PAGE = readFileSync("src/routes/_authenticated/admin.price-lists.tsx", "utf8").replace(
  /\r\n/g,
  "\n",
);

/** Just the import dialog, so nothing elsewhere on the page can answer for it. */
const DIALOG = /function ImportPricesDialog\([\s\S]*?\n}\n/.exec(PAGE)?.[0] ?? "";

/** The file picker's accept list, exactly as the input declares it. */
const ACCEPT = /accept="([^"]*)"/.exec(DIALOG)?.[1] ?? "";

/** The whole body of chooseFile, which is where a second path would grow. */
const CHOOSE = /async function chooseFile\([\s\S]*?\n {2}}\n/.exec(DIALOG)?.[0] ?? "";

describe("the price-list import file picker", () => {
  it("found the dialog it is about", () => {
    expect(DIALOG).toContain("Import prices");
    expect(CHOOSE).not.toBe("");
  });

  it("accepts .xlsx as well as the CSV it always took", () => {
    expect(ACCEPT).toContain(".xlsx");
    expect(ACCEPT).toContain("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(ACCEPT).toContain(".csv");
    expect(ACCEPT).toContain("text/csv");
  });

  it("says in its help text that it takes both", () => {
    const help = /Choose the vendor's \.xlsx or \.csv file[^<]*/.exec(DIALOG)?.[0] ?? "";
    expect(help).toContain(".xlsx");
    expect(help).toContain(".csv");
    expect(DIALOG).not.toContain("choose a .csv file");
  });
});

describe("one import path", () => {
  it("turns a workbook into the same text a paste produces", () => {
    expect(CHOOSE).toContain("sheetToImportText");
    expect(CHOOSE).toContain("setText(");
  });

  it("lazy-loads the workbook reader, so the page never carries it", () => {
    expect(CHOOSE).toMatch(/await import\("@\/lib\/workbook-read"\)/);
    expect(PAGE).not.toMatch(/^import .*from "@\/lib\/workbook-read";$/m);
  });

  it("reads a non-xlsx file as text, the way it always did", () => {
    expect(CHOOSE).toMatch(/\.xlsx\$\/i\.test\(file\.name\)/);
    expect(CHOOSE).toContain("await file.text()");
  });

  it("keeps parsePriceListCsv as the only parser either path reaches", () => {
    expect(PAGE.match(/parsePriceListCsv\(/g)).toHaveLength(1);
  });

  it("asks the price import's own column matching which row is the header", () => {
    const predicate = /const hasPriceHeader = [^;]+;/.exec(PAGE)?.[0] ?? "";
    expect(predicate).toContain("detectPriceColumns");
  });

  it("numbers problems by sheet row while the text is still the sheet's", () => {
    const parse = /parsePriceListCsv\([^)]*\)/.exec(DIALOG)?.[0] ?? "";
    expect(parse).toContain("firstLine");
  });
});

describe("the preview still governs", () => {
  it("writes the parsed rows, not the raw file", () => {
    const apply = /async function apply\(\)[\s\S]*?\n {2}}\n/.exec(DIALOG)?.[0] ?? "";
    expect(apply).toContain("result.rows");
    expect(apply).not.toContain("workbook");
  });

  it("names the sheet it read, the header row, and the columns it took", () => {
    expect(/Reading <b>\{showingSheet\.name\}<\/b>/.test(DIALOG)).toBe(true);
    expect(/headers found on row \$\{showingSheet\.headerRow\}/.test(DIALOG)).toBe(true);
    expect(/prices from\{" "\}\s*<b>\{result\.columns\.price\}<\/b>/.test(DIALOG)).toBe(true);
  });
});
