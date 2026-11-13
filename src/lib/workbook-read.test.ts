// @vitest-environment jsdom
//
// The sheet-to-rows half of the equipment import, and since then of the
// price-list import too (the last block). Real registers are messy in
// a small number of recurring ways, and each of those ways gets a fixture
// here: a title above the headers, a merged banner, a cover sheet in front of
// the data, numbers stored as text, dates stored as Excel serials, trailing
// rows that hold formatting and nothing else, columns in a different order.
//
// Nothing in here reads a clock. Serials are absolute days, and the moment a
// date fixture is pinned against `Date.now()` it starts aging with the real
// calendar — which is how main went red on 24 September.
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { detectColumns, parseEquipmentImport } from "./equipment-import";
import { buildXlsx, excelSerial, sheetFromRows } from "./export-table";
import {
  columnIndex,
  excelSerialToText,
  findHeaderRow,
  isDateFormatCode,
  MAX_XLSX_BYTES,
  pickSheet,
  readWorkbook,
  sheetToDelimitedText,
  sheetToImportText,
  type WorkbookSheet,
} from "./workbook-read";
import {
  catalogCodeIndex,
  detectPriceColumns,
  parsePriceListCsv,
  splitCsvLine,
} from "./price-lists";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_PKG = "http://schemas.openxmlformats.org/package/2006/relationships";

function zip(parts: Record<string, string | Uint8Array>): ArrayBuffer {
  const files: Record<string, Uint8Array> = {};
  for (const [name, body] of Object.entries(parts)) {
    files[name] = typeof body === "string" ? strToU8(body) : body;
  }
  return zipSync(files).slice().buffer as ArrayBuffer;
}

/** A workbook from literal worksheet XML, one entry per sheet. */
function workbook(
  sheets: { name: string; xml: string }[],
  extra: { shared?: string[]; styles?: string; date1904?: boolean } = {},
): ArrayBuffer {
  const parts: Record<string, string> = {
    "xl/workbook.xml":
      `<workbook xmlns="${NS}" xmlns:r="${NS_R}">` +
      (extra.date1904 ? '<workbookPr date1904="1"/>' : "") +
      "<sheets>" +
      sheets
        .map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join("") +
      "</sheets></workbook>",
    "xl/_rels/workbook.xml.rels":
      `<Relationships xmlns="${NS_PKG}">` +
      sheets
        .map(
          (_, i) =>
            `<Relationship Id="rId${i + 1}" Type="${NS_R}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
        )
        .join("") +
      "</Relationships>",
  };
  sheets.forEach((s, i) => {
    parts[`xl/worksheets/sheet${i + 1}.xml`] = `<worksheet xmlns="${NS}">${s.xml}</worksheet>`;
  });
  if (extra.shared) {
    parts["xl/sharedStrings.xml"] =
      `<sst xmlns="${NS}">` + extra.shared.map((s) => `<si><t>${s}</t></si>`).join("") + "</sst>";
  }
  if (extra.styles) parts["xl/styles.xml"] = extra.styles;
  return zip(parts);
}

/** `<row>` of inline-string cells, Excel's own A1-style references. */
function row(n: number, cells: (string | null)[]): string {
  const body = cells
    .map((c, i) =>
      c == null
        ? ""
        : `<c r="${String.fromCharCode(65 + i)}${n}" t="inlineStr"><is><t xml:space="preserve">${c}</t></is></c>`,
    )
    .join("");
  return `<row r="${n}">${body}</row>`;
}

function sheetData(rows: string[]): string {
  return `<sheetData>${rows.join("")}</sheetData>`;
}

/** Two cell styles: 0 plain, 1 a yyyy-mm-dd date. */
const STYLES_WITH_DATE =
  `<styleSheet xmlns="${NS}">` +
  '<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/></numFmts>' +
  '<cellXfs count="2">' +
  '<xf numFmtId="0"/>' +
  '<xf numFmtId="164" applyNumberFormat="1"/>' +
  "</cellXfs></styleSheet>";

const isHeader = (cells: string[]) => detectColumns(cells).tag != null;

function sheetsOf(buffer: ArrayBuffer): WorkbookSheet[] {
  const result = readWorkbook(buffer);
  if (!result.ok) throw new Error(result.reason);
  return result.sheets;
}

/* ------------------------------------------------------------------ */

describe("readWorkbook", () => {
  it("reads a plain register sheet into rows of text", () => {
    const sheets = sheetsOf(
      workbook([
        {
          name: "Register",
          xml: sheetData([
            row(1, ["Tag", "Type", "Office", "Serial"]),
            row(2, ["GSR-AM00034-NJ", "Air mover", "NJ", "88213"]),
          ]),
        },
      ]),
    );
    expect(sheets).toHaveLength(1);
    expect(sheets[0]!.name).toBe("Register");
    expect(sheets[0]!.rows).toEqual([
      ["Tag", "Type", "Office", "Serial"],
      ["GSR-AM00034-NJ", "Air mover", "NJ", "88213"],
    ]);
  });

  it("places sparse cells by their column letter, not their order", () => {
    // A row that skips B and D entirely — Excel omits empty cells.
    const xml = sheetData([
      row(1, ["Tag", "Type", "Office", "Serial"]),
      '<row r="2">' +
        '<c r="A2" t="inlineStr"><is><t>GSR-1</t></is></c>' +
        '<c r="C2" t="inlineStr"><is><t>NJ</t></is></c>' +
        "</row>",
    ]);
    expect(sheetsOf(workbook([{ name: "S", xml }]))[0]!.rows[1]).toEqual(["GSR-1", "", "NJ"]);
  });

  it("joins the runs of a rich-text shared string into one value", () => {
    const parts: Record<string, string> = {
      "xl/workbook.xml": `<workbook xmlns="${NS}" xmlns:r="${NS_R}"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": `<Relationships xmlns="${NS_PKG}"><Relationship Id="rId1" Type="${NS_R}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
      "xl/sharedStrings.xml": `<sst xmlns="${NS}"><si><r><t>Air </t></r><r><t>mover</t></r></si></sst>`,
      "xl/worksheets/sheet1.xml": `<worksheet xmlns="${NS}"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>`,
    };
    expect(sheetsOf(zip(parts))[0]!.rows[0]).toEqual(["Air mover"]);
  });

  it("drops trailing rows that carry only formatting", () => {
    const xml = sheetData([
      row(1, ["Tag"]),
      row(2, ["GSR-1"]),
      '<row r="3"><c r="A3" s="0"/></row>',
      '<row r="4"/>',
      '<row r="5"><c r="A5" t="inlineStr"><is><t>   </t></is></c></row>',
    ]);
    expect(sheetsOf(workbook([{ name: "S", xml }]))[0]!.rows).toHaveLength(2);
  });

  it("refuses a file that is not a ZIP, and names the .xls case", () => {
    const result = readWorkbook(
      strToU8("\xd0\xcf\x11\xe0 not a zip").slice().buffer as ArrayBuffer,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(".xls");
  });

  it("refuses a small ZIP whose parts expand past the limit", () => {
    const bytes = zipSync({ "xl/workbook.xml": new Uint8Array(MAX_XLSX_BYTES + 1) });
    expect(bytes.byteLength).toBeLessThan(200_000);
    const result = readWorkbook(bytes.slice().buffer as ArrayBuffer);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("larger than");
  });
});

describe("numbers and dates", () => {
  it("keeps a long integer exact rather than turning it into 1.2e+19", () => {
    const xml = sheetData([
      row(1, ["Tag", "Serial"]),
      '<row r="2"><c r="A2" t="inlineStr"><is><t>GSR-1</t></is></c>' +
        '<c r="B2"><v>12345678901234567890</v></c></row>',
    ]);
    expect(sheetsOf(workbook([{ name: "S", xml }]))[0]!.rows[1]![1]).toBe("12345678901234567890");
  });

  it("reads a number stored as text as the text it is, leading zeros and all", () => {
    const xml = sheetData([row(1, ["Tag", "Serial"]), row(2, ["GSR-1", "000884"])]);
    expect(sheetsOf(workbook([{ name: "S", xml }]))[0]!.rows[1]![1]).toBe("000884");
  });

  it("turns a date-styled serial into a date, and an unstyled one into its number", () => {
    const xml = sheetData([
      row(1, ["Tag", "Notes"]),
      '<row r="2"><c r="A2" t="inlineStr"><is><t>GSR-1</t></is></c>' +
        '<c r="B2" s="1"><v>45931</v></c></row>',
      '<row r="3"><c r="A3" t="inlineStr"><is><t>GSR-2</t></is></c>' +
        '<c r="B3" s="0"><v>45931</v></c></row>',
    ]);
    const rows = sheetsOf(workbook([{ name: "S", xml }], { styles: STYLES_WITH_DATE }))[0]!.rows;
    expect(rows[1]![1]).toBe("2025-10-01");
    expect(rows[2]![1]).toBe("45931");
  });

  it("honors the 1904 date system when the workbook declares it", () => {
    const xml = sheetData([
      row(1, ["Tag", "Notes"]),
      '<row r="2"><c r="A2" t="inlineStr"><is><t>GSR-1</t></is></c>' +
        '<c r="B2" s="1"><v>0</v></c></row>',
    ]);
    const rows = sheetsOf(
      workbook([{ name: "S", xml }], { styles: STYLES_WITH_DATE, date1904: true }),
    )[0]!.rows;
    expect(rows[1]![1]).toBe("1904-01-01");
  });

  it("is the exact inverse of the exporter's excelSerial, in any time zone", () => {
    // A fixed calendar date, never `new Date()` — this assertion must read the
    // same in 2026 as it does in 2031.
    const day = new Date(2026, 8, 24);
    expect(excelSerialToText(excelSerial(day)!)).toBe("2026-09-24");
    expect(excelSerialToText(excelSerial(new Date(2026, 8, 24, 14, 30))!)).toBe("2026-09-24 14:30");
  });

  it("tells a date format from a money one", () => {
    expect(isDateFormatCode("yyyy-mm-dd")).toBe(true);
    expect(isDateFormatCode("d-mmm-yy")).toBe(true);
    expect(isDateFormatCode("#,##0.00_);[Red]\\(#,##0.00\\)")).toBe(false);
    expect(isDateFormatCode('0.0%"m"')).toBe(false);
  });

  it("numbers columns past Z correctly", () => {
    expect(columnIndex("A1")).toBe(0);
    expect(columnIndex("Z9")).toBe(25);
    expect(columnIndex("AA1")).toBe(26);
    expect(columnIndex("BC12")).toBe(54);
  });
});

describe("finding the header and the sheet", () => {
  it("skips a title row, a merged banner and blank rows above the headers", () => {
    // A merged banner writes its value once in the top-left and leaves the
    // rest of the span empty, so it arrives as a one-cell row.
    const xml = sheetData([
      row(1, ["Falcon GSR — Equipment Register"]),
      row(2, [null]),
      row(3, ["Printed 2026-09-30"]),
      row(4, ["Tag", "Type", "Office"]),
      row(5, ["GSR-AM00034-NJ", "Air mover", "NJ"]),
    ]);
    const sheet = sheetsOf(workbook([{ name: "S", xml }]))[0]!;
    expect(findHeaderRow(sheet.rows, isHeader)).toBe(3);
    const { text, headerRow } = sheetToImportText(sheet, isHeader);
    expect(headerRow).toBe(4);
    expect(text.split("\n")[0]).toBe("Tag,Type,Office");
  });

  it("takes the first sheet whose headers it recognizes, past a cover sheet", () => {
    const cover = sheetData([row(1, ["Gold Star Restoration"]), row(2, ["Updated weekly"])]);
    const data = sheetData([row(1, ["Office", "Type", "Tag"]), row(2, ["NJ", "Dehu", "GSR-D1"])]);
    const sheets = sheetsOf(
      workbook([
        { name: "Cover", xml: cover },
        { name: "Register", xml: data },
      ]),
    );
    expect(sheets.map((s) => s.name)).toEqual(["Cover", "Register"]);
    expect(pickSheet(sheets, isHeader)).toBe(1);
  });

  it("falls back to the first sheet when no sheet has a recognisable header", () => {
    const xml = sheetData([row(1, ["Widgets", "Count"]), row(2, ["Dehu", "12"])]);
    const sheets = sheetsOf(workbook([{ name: "Counts", xml }]));
    expect(findHeaderRow(sheets[0]!.rows, isHeader)).toBe(-1);
    expect(pickSheet(sheets, isHeader)).toBe(0);
    // Handed over whole, so the parser gives its own answer rather than ours.
    expect(sheetToImportText(sheets[0]!, isHeader).headerRow).toBe(0);
  });
});

describe("sheetToDelimitedText", () => {
  it("round-trips through the parser's own splitCsvLine", () => {
    const text = sheetToDelimitedText([["a,b", 'say "hi"', "tab\there", " padded "]]);
    expect(splitCsvLine(text)).toEqual(["a,b", 'say "hi"', "tab\there", "padded"]);
  });

  it("flattens a newline inside a cell rather than splitting the unit in two", () => {
    const text = sheetToDelimitedText([["GSR-1", "Needs\nnew filter"]]);
    expect(text.split("\n")).toHaveLength(1);
    expect(splitCsvLine(text)[1]).toBe("Needs new filter");
  });
});

/* ------------------------------------------------------------------ */
/* The whole way through: a workbook to register rows                  */
/* ------------------------------------------------------------------ */

describe("a workbook reaching parseEquipmentImport", () => {
  const types = [
    { key: "air_mover", label: "Air mover" },
    { key: "dehumidifier", label: "Dehumidifier" },
  ];
  const offices = [
    { id: "o-nj", code: "NJ", name: "New Jersey" },
    { id: "o-lw", code: "LW", name: "Lakewood" },
  ];
  const ctx = { types, offices, defaultOfficeId: null, existing: new Map<string, never[]>() };

  it("imports a messy sheet: title rows, a different column order, serials as numbers", () => {
    const xml = sheetData([
      row(1, ["Equipment Register"]),
      row(2, [null]),
      row(3, ["Office", "Serial", "Tag", "Equipment type"]),
      '<row r="4"><c r="A4" t="inlineStr"><is><t>NJ</t></is></c>' +
        '<c r="B4"><v>88213</v></c>' +
        '<c r="C4" t="inlineStr"><is><t>GSR-AM00034-NJ</t></is></c>' +
        '<c r="D4" t="inlineStr"><is><t>Air mover</t></is></c></row>',
      row(5, ["Lakewood", "", "GSR-DH00007-LW", "LGR"]),
      row(6, [null]),
    ]);
    const sheet = sheetsOf(workbook([{ name: "Register", xml }]))[0]!;
    const result = parseEquipmentImport(sheetToImportText(sheet, isHeader).text, ctx);

    expect(result.kind).toBe("rows");
    if (result.kind !== "rows") return;
    expect(result.problems).toEqual([]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({
      tag: "GSR-AM00034-NJ",
      typeKey: "air_mover",
      officeId: "o-nj",
      serial: "88213",
    });
    expect(result.rows[1]).toMatchObject({
      tag: "GSR-DH00007-LW",
      typeKey: "dehumidifier",
      officeId: "o-lw",
    });
  });

  it("survives the round trip the QC test does: export the register, re-import it", () => {
    // Our own exporter writes inline strings and no shared-strings table,
    // which is the opposite of what Excel writes — both paths have to work.
    const units = Array.from({ length: 388 }, (_, i) => [
      `GSR-AM${String(i + 1).padStart(5, "0")}-NJ`,
      "Air mover",
      "NJ",
      100000 + i,
    ]);
    const bytes = buildXlsx([
      sheetFromRows("Equipment", ["Tag", "Type", "Office", "Serial"], units),
    ]);
    const sheet = sheetsOf(bytes.slice().buffer as ArrayBuffer)[0]!;
    const result = parseEquipmentImport(sheetToImportText(sheet, isHeader).text, ctx);

    expect(result.kind).toBe("rows");
    if (result.kind !== "rows") return;
    expect(result.rows).toHaveLength(388);
    expect(result.problems).toEqual([]);
    expect(result.rows[387]).toMatchObject({
      tag: "GSR-AM00388-NJ",
      typeKey: "air_mover",
      officeId: "o-nj",
      serial: "100387",
    });
  });

  it("still refuses a count sheet, in the parser's own words", () => {
    const xml = sheetData([row(1, ["Air mover", "Dehu", "Scrubber"]), row(2, ["12", "4", "3"])]);
    const sheet = sheetsOf(workbook([{ name: "Counts", xml }]))[0]!;
    const result = parseEquipmentImport(sheetToImportText(sheet, isHeader).text, ctx);
    expect(result.kind).toBe("count_sheet");
  });
});

/* ------------------------------------------------------------------ */
/* The same reader, a different importer: a vendor price list          */
/* ------------------------------------------------------------------ */

describe("a workbook reaching parsePriceListCsv", () => {
  const catalog = catalogCodeIndex([
    { id: "i-dehu", code: "DEHU-DAY" },
    { id: "i-tech", code: "LAB-TECH" },
    { id: "i-trv", code: "TRV" },
    { id: "i-ppe", code: "PPE" },
    { id: "i-afd", code: "AFD-DAY" },
  ]);
  const hasPriceHeader = (cells: string[]) => detectPriceColumns(cells) != null;

  /**
   * The ways Excel stores a price. Style 1 is a custom "$" currency format,
   * 2 the built-in currency format 7, 3 the built-in accounting format 44,
   * 4 a locale-tagged currency format. Every one of them stores the bare
   * number in the cell; only the display carries the dollar sign.
   */
  const MONEY_STYLES =
    `<styleSheet xmlns="${NS}">` +
    '<numFmts count="2">' +
    '<numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/>' +
    '<numFmt numFmtId="165" formatCode="[$$-409]#,##0.00"/>' +
    "</numFmts>" +
    '<cellXfs count="5">' +
    '<xf numFmtId="0"/>' +
    '<xf numFmtId="164" applyNumberFormat="1"/>' +
    '<xf numFmtId="7" applyNumberFormat="1"/>' +
    '<xf numFmtId="44" applyNumberFormat="1"/>' +
    '<xf numFmtId="165" applyNumberFormat="1"/>' +
    "</cellXfs></styleSheet>";

  type Cell = { s: number } | { n: string; style: number } | string | null;
  /** A row the way Excel writes it: text in the shared table, numbers styled. */
  function excelRow(r: number, cells: Cell[]): string {
    const body = cells
      .map((c, i) => {
        const ref = `${String.fromCharCode(65 + i)}${r}`;
        if (c == null) return "";
        if (typeof c === "string") return `<c r="${ref}" t="inlineStr"><is><t>${c}</t></is></c>`;
        if ("s" in c) return `<c r="${ref}" t="s"><v>${c.s}</v></c>`;
        return `<c r="${ref}" s="${c.style}"><v>${c.n}</v></c>`;
      })
      .join("");
    return `<row r="${r}">${body}</row>`;
  }

  // The shared-strings table Excel would have written for the sheet below.
  const SHARED = [
    "Item Code", // 0
    "Description", // 1
    "Unit", // 2
    "List Price", // 3
    "Contract Price", // 4
    "DEHU-DAY", // 5
    "LAB-TECH", // 6
    "TRV", // 7
    "$1,234.50", // 8 — a price somebody typed as text
    "PPE", // 9
    "AFD-DAY", // 10
  ];

  function vendorWorkbook(extraRows: string[] = []): ArrayBuffer {
    const cover = sheetData([
      excelRow(1, ["Acme Restoration Supply"]),
      excelRow(2, ["Pricing agreement for Gold Star Restoration"]),
    ]);
    const prices = sheetData([
      excelRow(1, ["Acme Restoration Supply — 2026 price list"]),
      excelRow(2, ["Effective January 1, 2026"]),
      '<row r="3"/>',
      excelRow(4, [{ s: 0 }, { s: 1 }, { s: 2 }, { s: 3 }, { s: 4 }]),
      excelRow(5, [{ s: 5 }, "Dehu, daily", "DA", { n: "95", style: 1 }, { n: "80", style: 1 }]),
      excelRow(6, [
        { s: 6 },
        "Tech, per hour",
        "HR",
        { n: "70", style: 2 },
        { n: "65.5", style: 2 },
      ]),
      excelRow(7, [{ s: 7 }, "Travel", "EA", { n: "1300", style: 3 }, { s: 8 }]),
      // A computed price, with the binary noise Excel stores for 12.30.
      excelRow(8, [
        { s: 9 },
        "PPE kit",
        "EA",
        { n: "15", style: 3 },
        { n: "12.300000000000001", style: 3 },
      ]),
      excelRow(9, [
        { s: 10 },
        "Air scrubber, daily",
        "DA",
        { n: "1500", style: 4 },
        { n: "1234.5", style: 4 },
      ]),
      ...extraRows,
      // Formatting carried down the sheet, and nothing in it.
      '<row r="40"><c r="E40" s="1"/></row>',
      '<row r="41"/>',
    ]);
    return workbook(
      [
        { name: "Cover", xml: cover },
        { name: "Prices", xml: prices },
      ],
      { shared: SHARED, styles: MONEY_STYLES },
    );
  }

  /** What the dialog does: pick the sheet, flatten it, parse from its header row. */
  function importOf(buffer: ArrayBuffer) {
    const sheets = sheetsOf(buffer);
    const pick = pickSheet(sheets, hasPriceHeader);
    const { text, headerRow } = sheetToImportText(sheets[pick]!, hasPriceHeader);
    return {
      sheet: sheets[pick]!.name,
      headerRow,
      ...parsePriceListCsv(text, catalog, { firstLine: headerRow || 1 }),
    };
  }

  it("imports a vendor's Excel file as sent: cover sheet, title rows, currency cells", () => {
    const result = importOf(vendorWorkbook());
    expect(result.sheet).toBe("Prices");
    expect(result.headerRow).toBe(4);
    expect(result.columns).toEqual({ code: "Item Code", price: "Contract Price" });
    expect(result.problems).toEqual([]);
    expect(result.rows.map((r) => [r.code, r.unit_price])).toEqual([
      ["DEHU-DAY", 80],
      ["LAB-TECH", 65.5],
      ["TRV", 1234.5],
      ["PPE", 12.3],
      ["AFD-DAY", 1234.5],
    ]);
  });

  it("reads a currency-formatted cell as its number, not its dollar-sign display", () => {
    // None of these formats is a date, so none of the serial handling applies.
    for (const code of ['"$"#,##0.00', "[$$-409]#,##0.00", '_("$"* #,##0.00_)']) {
      expect(isDateFormatCode(code)).toBe(false);
    }
    const sheet = sheetsOf(vendorWorkbook())[1]!;
    expect(sheet.rows[4]![4]).toBe("80");
    expect(sheet.rows[8]![4]).toBe("1234.5");
  });

  it("reports a bad row by the row number Excel shows", () => {
    const result = importOf(
      vendorWorkbook([excelRow(10, ["NOPE-1", "Not ours", "EA", null, { n: "9", style: 1 }])]),
    );
    expect(result.rows).toHaveLength(5);
    expect(result.problems).toEqual([
      expect.objectContaining({ line: 10, reason: expect.stringContaining("NOPE-1") }),
    ]);
  });

  it("takes a plain two-column sheet with no header at all", () => {
    const xml = sheetData([
      excelRow(1, ["DEHU-DAY", { n: "80", style: 0 }]),
      excelRow(2, ["TRV", " $ 25.00 "]),
    ]);
    const result = importOf(workbook([{ name: "Sheet1", xml }]));
    expect(result.headerRow).toBe(0);
    expect(result.columns).toBeNull();
    expect(result.problems).toEqual([]);
    expect(result.rows.map((r) => r.unit_price)).toEqual([80, 25]);
  });

  it("round-trips the exporter's own money cells, every price to the cent", () => {
    const codes = Array.from({ length: 250 }, (_, i) => `ITEM-${i}`);
    const big = catalogCodeIndex(codes.map((code) => ({ id: `id-${code}`, code })));
    // Prices with awkward binary expansions: 0.1 steps, thirds rounded to cents.
    const prices = codes.map((_, i) => Math.round((i * 1.1 + i / 3) * 100) / 100);
    const bytes = buildXlsx([
      sheetFromRows(
        "Prices",
        ["Code", "Price"],
        codes.map((c, i) => [c, prices[i]!]),
        ["text", "money"],
      ),
    ]);
    const sheet = sheetsOf(bytes.slice().buffer as ArrayBuffer)[0]!;
    const { text, headerRow } = sheetToImportText(sheet, hasPriceHeader);
    const result = parsePriceListCsv(text, big, { firstLine: headerRow || 1 });
    expect(result.problems).toEqual([]);
    expect(result.rows.map((r) => r.unit_price)).toEqual(prices);
  });
});
