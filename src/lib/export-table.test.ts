import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

import {
  buildCsv,
  buildXlsx,
  cellRef,
  excelSerial,
  exportFilename,
  parseIsoDate,
  sanitizeSheetName,
  sheetFromColumns,
  sheetFromRows,
  type ExportColumn,
} from "@/lib/export-table";

type Row = {
  job: string;
  company: string;
  billed: number | null;
  rate: number;
  signedOn: string;
  createdAt: Date;
  open: boolean;
  zip: string;
};

const columns: ExportColumn<Row>[] = [
  { key: "job", label: "Job", get: (r) => r.job },
  { key: "company", label: "Company", get: (r) => r.company },
  { key: "billed", label: "Billed", get: (r) => r.billed, type: "money" },
  { key: "rate", label: "Conversion", get: (r) => r.rate, type: "percent" },
  { key: "signedOn", label: "Signed", get: (r) => r.signedOn, type: "date" },
  { key: "createdAt", label: "Created", get: (r) => r.createdAt, type: "datetime" },
  { key: "open", label: "Open", get: (r) => r.open },
  { key: "zip", label: "Zip", get: (r) => r.zip },
];

const rows: Row[] = [
  {
    job: "J-1001",
    company: "Acme & Co <Restoration>",
    billed: 1234.5,
    rate: 0.25,
    signedOn: "2000-01-01",
    createdAt: new Date(2026, 8, 3, 14, 30),
    open: true,
    zip: "01234",
  },
  {
    job: "J-1002",
    company: 'Quote "Me" Inc',
    billed: null,
    rate: 0,
    signedOn: "",
    createdAt: new Date(2026, 0, 15, 9, 0),
    open: false,
    zip: "90210",
  },
];

function unzipWorkbook(bytes: Uint8Array): Record<string, string> {
  const files = unzipSync(bytes);
  return Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strFromU8(v)]));
}

describe("the xlsx writer", () => {
  const sheet = sheetFromColumns("Jobs", rows, columns);
  const parts = unzipWorkbook(buildXlsx([sheet]));

  it("zips every part an Office Open XML workbook needs", () => {
    expect(Object.keys(parts).sort()).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/workbook.xml",
      "xl/worksheets/sheet1.xml",
    ]);
    expect(parts["[Content_Types].xml"]).toContain('PartName="/xl/worksheets/sheet1.xml"');
    expect(parts["_rels/.rels"]).toContain('Target="xl/workbook.xml"');
    expect(parts["xl/_rels/workbook.xml.rels"]).toContain('Target="worksheets/sheet1.xml"');
    expect(parts["xl/_rels/workbook.xml.rels"]).toContain('Target="styles.xml"');
    expect(parts["xl/workbook.xml"]).toContain('<sheet name="Jobs" sheetId="1" r:id="rId1"/>');
  });

  it("writes text as escaped inline strings", () => {
    const xml = parts["xl/worksheets/sheet1.xml"]!;
    expect(xml).toContain(
      '<c r="B2" t="inlineStr"><is><t xml:space="preserve">Acme &amp; Co &lt;Restoration&gt;</t></is></c>',
    );
    expect(xml).toContain("Quote &quot;Me&quot; Inc");
    // No shared-strings table is needed or produced.
    expect(parts["xl/sharedStrings.xml"]).toBeUndefined();
  });

  it("keeps a leading-zero zip as text, not a number", () => {
    const xml = parts["xl/worksheets/sheet1.xml"]!;
    expect(xml).toContain('<c r="H2" t="inlineStr"><is><t xml:space="preserve">01234</t></is></c>');
  });

  it("writes numbers as numeric cells with the money and percent styles", () => {
    const xml = parts["xl/worksheets/sheet1.xml"]!;
    expect(xml).toContain('<c r="C2" s="3"><v>1234.5</v></c>');
    expect(xml).toContain('<c r="D2" s="4"><v>0.25</v></c>');
    expect(xml).toContain('<c r="D3" s="4"><v>0</v></c>');
  });

  it("omits empty cells entirely", () => {
    const xml = parts["xl/worksheets/sheet1.xml"]!;
    expect(xml).not.toContain('r="C3"');
    expect(xml).not.toContain('r="E3"');
  });

  it("converts dates to Excel serials with a date style", () => {
    const xml = parts["xl/worksheets/sheet1.xml"]!;
    // 2000-01-01 is serial 36526 in Excel's 1900 system.
    expect(xml).toContain('<c r="E2" s="5"><v>36526</v></c>');
    // 2026-09-03 14:30 local -> serial 46268.604166...
    const m = /<c r="F2" s="6"><v>([\d.]+)<\/v><\/c>/.exec(xml);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeCloseTo(46268 + 14.5 / 24, 6);
  });

  it("writes booleans as boolean cells", () => {
    const xml = parts["xl/worksheets/sheet1.xml"]!;
    expect(xml).toContain('<c r="G2" t="b"><v>1</v></c>');
    expect(xml).toContain('<c r="G3" t="b"><v>0</v></c>');
  });

  it("bolds and freezes the header row and puts an AutoFilter on the table", () => {
    const xml = parts["xl/worksheets/sheet1.xml"]!;
    expect(xml).toContain(
      '<c r="A1" t="inlineStr" s="1"><is><t xml:space="preserve">Job</t></is></c>',
    );
    expect(xml).toContain(
      '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>',
    );
    expect(xml).toContain('<autoFilter ref="A1:H3"/>');
    expect(parts["xl/workbook.xml"]).toContain("'Jobs'!$A$1:$H$3");
    // Style 1 is the bold font in styles.xml.
    expect(parts["xl/styles.xml"]).toContain(
      '<font><b/><sz val="11"/><name val="Calibri"/></font>',
    );
  });

  it("sizes columns from their content", () => {
    const xml = parts["xl/worksheets/sheet1.xml"]!;
    // "Acme & Co <Restoration>" is 23 characters -> width 25.
    expect(xml).toContain('<col min="2" max="2" width="25" customWidth="1"/>');
    // Nothing narrower than 8.
    expect(xml).toContain('<col min="1" max="1" width="8" customWidth="1"/>');
  });

  it("emits one row per record plus the header", () => {
    const xml = parts["xl/worksheets/sheet1.xml"]!;
    expect(xml.match(/<row r="\d+">/g)).toHaveLength(rows.length + 1);
  });

  it("supports several sheets and de-duplicates their names", () => {
    const two = buildXlsx([
      sheetFromRows("Spend", ["A"], [[1]]),
      sheetFromRows("Spend", ["B"], [[2]]),
      sheetFromRows("Q1/Q2 [draft]: really long sheet name over limit", ["C"], [[3]]),
    ]);
    const p = unzipWorkbook(two);
    expect(p["xl/workbook.xml"]).toContain('<sheet name="Spend" sheetId="1"');
    expect(p["xl/workbook.xml"]).toContain('<sheet name="Spend 2" sheetId="2"');
    // Illegal characters become spaces, runs collapse, and the name is cut at 31.
    expect(p["xl/workbook.xml"]).toContain('<sheet name="Q1 Q2 draft really long sheet n"');
    expect(p["xl/worksheets/sheet3.xml"]).toContain('<c r="A2" s="2"><v>3</v></c>');
  });

  it("strips control characters XML cannot carry", () => {
    const p = unzipWorkbook(
      buildXlsx([
        sheetFromRows("S", ["Note"], [["bad" + String.fromCharCode(7) + "char kept\ttab\nline"]]),
      ]),
    );
    expect(p["xl/worksheets/sheet1.xml"]).toContain("badchar kept\ttab\nline");
  });

  it("refuses an empty workbook", () => {
    expect(() => buildXlsx([])).toThrow();
  });
});

describe("the csv path", () => {
  it("quotes only what needs quoting and serialises dates as ISO", () => {
    const sheet = sheetFromColumns("Jobs", rows, columns);
    const csv = buildCsv(sheet);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("Job,Company,Billed,Conversion,Signed,Created,Open,Zip");
    expect(lines[1]).toContain("J-1001,Acme & Co <Restoration>,1234.5,0.25,2000-01-01,");
    expect(lines[1]).toContain(new Date(2026, 8, 3, 14, 30).toISOString());
    expect(lines[2]).toContain('"Quote ""Me"" Inc"');
    expect(lines[2]).toMatch(/,,0,,/); // null billed and blank signed stay empty
  });
});

describe("helpers", () => {
  it("names files <report>-<yyyy-mm-dd>.<ext>", () => {
    const on = new Date(2026, 8, 3);
    expect(exportFilename("Rep profitability", "xlsx", on)).toBe(
      "rep-profitability-2026-09-03.xlsx",
    );
    expect(exportFilename("  weekly / sales  ", "csv", on)).toBe("weekly-sales-2026-09-03.csv");
    expect(exportFilename("", "xlsx", on)).toBe("export-2026-09-03.xlsx");
  });

  it("computes cell references past column Z", () => {
    expect(cellRef(0, 1)).toBe("A1");
    expect(cellRef(25, 2)).toBe("Z2");
    expect(cellRef(26, 3)).toBe("AA3");
    expect(cellRef(27 * 26 + 1, 4)).toBe("AAB4");
  });

  it("anchors bare dates to local midnight so they do not slide a day", () => {
    const d = parseIsoDate("2026-09-03", true)!;
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([2026, 8, 3, 0]);
    expect(parseIsoDate("not a date", true)).toBeNull();
    expect(excelSerial(new Date(1899, 11, 31))).toBe(1);
    expect(excelSerial(null)).toBeNull();
  });

  it("sanitizes sheet names to what Excel accepts", () => {
    expect(sanitizeSheetName("a/b:c*d?e[f]g\\h")).toBe("a b c d e f g h");
    expect(sanitizeSheetName("   ")).toBe("Sheet");
    expect(sanitizeSheetName("x".repeat(40))).toHaveLength(31);
  });
});
