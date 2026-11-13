import { strToU8, zipSync } from "fflate";

/**
 * One exporter for every report and list screen.
 *
 * The client runs a report, downloads it, and then sorts and filters it in
 * Excel — so the file has to be a real workbook, not a CSV that Excel opens
 * with every zip code stripped of its leading zero and every job number turned
 * into a float. This writes a minimal Office Open XML package by hand with
 * `fflate` (already a dependency for ESX files); no SheetJS.
 *
 * What the workbook gets:
 *   - inline strings, so no shared-strings table has to be assembled;
 *   - numbers as numeric cells (money, percent and plain number styles);
 *   - dates as Excel serials with a date style, so they sort as dates;
 *   - a bold, frozen header row with an AutoFilter already on it;
 *   - column widths sized from the content.
 *
 * Everything that touches `document` is in `saveFile`; the builders are pure
 * and are what the tests exercise.
 */

export type ExportValue = string | number | boolean | Date | null | undefined;

export type ExportCellType = "text" | "number" | "money" | "percent" | "date" | "datetime";

export type ExportColumn<T> = {
  key: string;
  label: string;
  get: (row: T) => ExportValue;
  /**
   * Cell typing. Inferred from the value when omitted: numbers become numeric
   * cells, `Date` objects become date cells, everything else is text. Set
   * `date`/`datetime` to have ISO strings converted to real Excel dates, and
   * `money`/`percent` to get the matching number format.
   */
  type?: ExportCellType;
};

export type ExportSheet = {
  name: string;
  headers: string[];
  types: (ExportCellType | undefined)[];
  rows: ExportValue[][];
  /**
   * A totals row printed ABOVE the header (David, 21 Oct: "totals on top"),
   * in bold, frozen with the header so it stays in view. Kept out of the
   * AutoFilter range so sorting never moves it into the data.
   */
  totals?: ExportValue[] | null;
};

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const CSV_MIME = "text/csv;charset=utf-8";

/* ------------------------------------------------------------------ */
/* Sheet assembly                                                      */
/* ------------------------------------------------------------------ */

export function sheetFromColumns<T>(
  name: string,
  rows: readonly T[],
  columns: readonly ExportColumn<T>[],
): ExportSheet {
  return {
    name,
    headers: columns.map((c) => c.label),
    types: columns.map((c) => c.type),
    rows: rows.map((r) => columns.map((c) => c.get(r))),
  };
}

/** For callers that already hold header strings and value rows (the data table). */
export function sheetFromRows(
  name: string,
  headers: string[],
  rows: ExportValue[][],
  types?: (ExportCellType | undefined)[],
): ExportSheet {
  return { name, headers, types: types ?? headers.map(() => undefined), rows };
}

/** `<report>-<yyyy-mm-dd>.<ext>` — the one filename pattern every screen uses. */
export function exportFilename(report: string, ext: "xlsx" | "csv", on = new Date()): string {
  const stem = report
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${stem || "export"}-${localDateStamp(on)}.${ext}`;
}

function localDateStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ------------------------------------------------------------------ */
/* CSV                                                                 */
/* ------------------------------------------------------------------ */

export function buildCsv(sheet: ExportSheet): string {
  const esc = (v: ExportValue) => {
    const s = csvText(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [
    ...(sheet.totals ? [sheet.totals.map(esc).join(",")] : []),
    sheet.headers.map(esc).join(","),
    ...sheet.rows.map((r) => r.map(esc).join(",")),
  ].join("\n");
}

function csvText(v: ExportValue): string {
  if (v == null) return "";
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString() : "";
  return String(v);
}

/* ------------------------------------------------------------------ */
/* XLSX                                                                */
/* ------------------------------------------------------------------ */

/** Cell style indexes into `cellXfs` in styles.xml. Order matters. */
const STYLE = {
  text: 0,
  header: 1,
  number: 2,
  money: 3,
  percent: 4,
  date: 5,
  datetime: 6,
  totalMoney: 7,
  totalNumber: 8,
} as const;

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const REL_OFFICE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** Builds the .xlsx bytes. One worksheet per sheet, in order. */
export function buildXlsx(sheets: readonly ExportSheet[]): Uint8Array {
  if (sheets.length === 0) throw new Error("A workbook needs at least one sheet.");
  const names = uniqueSheetNames(sheets.map((s) => s.name));

  const files: Record<string, Uint8Array> = {};
  files["[Content_Types].xml"] = strToU8(contentTypesXml(sheets.length));
  files["_rels/.rels"] = strToU8(rootRelsXml());
  files["xl/workbook.xml"] = strToU8(workbookXml(sheets, names));
  files["xl/_rels/workbook.xml.rels"] = strToU8(workbookRelsXml(sheets.length));
  files["xl/styles.xml"] = strToU8(stylesXml());
  sheets.forEach((s, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(worksheetXml(s));
  });
  return zipSync(files, { level: 6 });
}

function contentTypesXml(sheetCount: number): string {
  const overrides = [
    override(
      "/xl/workbook.xml",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
    ),
    override(
      "/xl/styles.xml",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml",
    ),
    ...Array.from({ length: sheetCount }, (_, i) =>
      override(
        `/xl/worksheets/sheet${i + 1}.xml`,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml",
      ),
    ),
  ].join("");
  return (
    XML_HEAD +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    overrides +
    "</Types>"
  );
}

function override(part: string, type: string): string {
  return `<Override PartName="${part}" ContentType="${type}"/>`;
}

function rootRelsXml(): string {
  return (
    XML_HEAD +
    `<Relationships xmlns="${NS_PKG_REL}">` +
    `<Relationship Id="rId1" Type="${REL_OFFICE}/officeDocument" Target="xl/workbook.xml"/>` +
    "</Relationships>"
  );
}

function workbookXml(sheets: readonly ExportSheet[], names: string[]): string {
  const sheetTags = sheets
    .map((_, i) => `<sheet name="${escapeXml(names[i]!)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join("");
  // Excel keeps the AutoFilter range in a hidden defined name per sheet.
  const filterNames = sheets
    .map((s, i) => {
      const ref = filterRange(s);
      if (!ref) return "";
      return (
        `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">` +
        `'${escapeXml(names[i]!.replace(/'/g, "''"))}'!${absoluteRef(ref)}</definedName>`
      );
    })
    .join("");
  return (
    XML_HEAD +
    `<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
    `<sheets>${sheetTags}</sheets>` +
    (filterNames ? `<definedNames>${filterNames}</definedNames>` : "") +
    "</workbook>"
  );
}

function workbookRelsXml(sheetCount: number): string {
  const rels = Array.from(
    { length: sheetCount },
    (_, i) =>
      `<Relationship Id="rId${i + 1}" Type="${REL_OFFICE}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
  ).join("");
  return (
    XML_HEAD +
    `<Relationships xmlns="${NS_PKG_REL}">` +
    rels +
    `<Relationship Id="rId${sheetCount + 1}" Type="${REL_OFFICE}/styles" Target="styles.xml"/>` +
    "</Relationships>"
  );
}

/**
 * Style table. `cellXfs` order is the `STYLE` map above. Custom number
 * formats start at id 164 by convention; 0 (General) and 14 (short date) are
 * built in.
 */
function stylesXml(): string {
  return (
    XML_HEAD +
    `<styleSheet xmlns="${NS_MAIN}">` +
    '<numFmts count="4">' +
    '<numFmt numFmtId="164" formatCode="#,##0.00"/>' +
    '<numFmt numFmtId="165" formatCode="0.0%"/>' +
    // MM/DD/YYYY, US order, as every date the app prints (T1 / TM4).
    '<numFmt numFmtId="166" formatCode="mm/dd/yyyy"/>' +
    '<numFmt numFmtId="167" formatCode="mm/dd/yyyy h:mm AM/PM"/>' +
    "</numFmts>" +
    '<fonts count="2">' +
    '<font><sz val="11"/><name val="Calibri"/></font>' +
    '<font><b/><sz val="11"/><name val="Calibri"/></font>' +
    "</fonts>" +
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="9">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>' +
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
    "</cellXfs>" +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    "</styleSheet>"
  );
}

function worksheetXml(sheet: ExportSheet): string {
  const widths = columnWidths(sheet);
  const cols = widths
    .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`)
    .join("");

  // With a totals row on top, the header is row 2 and the data starts at 3.
  const top = sheet.totals ? 1 : 0;
  const totalsRow = sheet.totals
    ? `<row r="1">` +
      sheet.totals
        .map((v, c) => {
          const ref = cellRef(c, 1);
          if (v == null || v === "") return "";
          if (typeof v === "number" && Number.isFinite(v)) {
            return numberCell(
              ref,
              v,
              sheet.types[c] === "money" ? STYLE.totalMoney : STYLE.totalNumber,
            );
          }
          return textCell(ref, csvText(v), STYLE.header);
        })
        .join("") +
      "</row>"
    : "";
  const headerRow =
    `<row r="${1 + top}">` +
    sheet.headers.map((h, c) => textCell(cellRef(c, 1 + top), h, STYLE.header)).join("") +
    "</row>";

  const bodyRows = sheet.rows
    .map((row, r) => {
      const n = r + 2 + top;
      const cells = row
        .map((v, c) => cellXml(cellRef(c, n), v, sheet.types[c]))
        .filter((s) => s !== "")
        .join("");
      return `<row r="${n}">${cells}</row>`;
    })
    .join("");

  const filter = filterRange(sheet);
  return (
    XML_HEAD +
    `<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
    `<dimension ref="${filter ? filter.replace(/^A\d+/, "A1") : "A1"}"/>` +
    '<sheetViews><sheetView workbookViewId="0">' +
    `<pane ySplit="${1 + top}" topLeftCell="A${2 + top}" activePane="bottomLeft" state="frozen"/>` +
    "</sheetView></sheetViews>" +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    (cols ? `<cols>${cols}</cols>` : "") +
    `<sheetData>${totalsRow}${headerRow}${bodyRows}</sheetData>` +
    (filter ? `<autoFilter ref="${filter}"/>` : "") +
    "</worksheet>"
  );
}

/** A1:H20 covering header plus rows; null when there is nothing to filter. */
function filterRange(sheet: ExportSheet): string | null {
  if (sheet.headers.length === 0) return null;
  const top = sheet.totals ? 1 : 0;
  const last = cellRef(sheet.headers.length - 1, sheet.rows.length + 1 + top);
  return `A${1 + top}:${last}`;
}

function absoluteRef(range: string): string {
  return range.replace(/([A-Z]+)(\d+)/g, "$$$1$$$2");
}

/**
 * One cell. Empty values produce no cell at all — an empty inline string
 * would still count as "text" to a sort or a COUNTA.
 */
function cellXml(ref: string, v: ExportValue, type: ExportCellType | undefined): string {
  if (v == null || v === "") return "";

  if (v instanceof Date) {
    const serial = excelSerial(v);
    if (serial == null) return "";
    return numberCell(ref, serial, type === "datetime" ? STYLE.datetime : STYLE.date);
  }

  if (typeof v === "boolean") {
    return `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`;
  }

  if (typeof v === "number") {
    if (!Number.isFinite(v)) return "";
    const style =
      type === "money"
        ? STYLE.money
        : type === "percent"
          ? STYLE.percent
          : type === "date"
            ? STYLE.date
            : type === "datetime"
              ? STYLE.datetime
              : STYLE.number;
    return numberCell(ref, v, style);
  }

  // Strings. A date-typed column converts parseable ISO text to a real date.
  if (type === "date" || type === "datetime") {
    const serial = excelSerial(parseIsoDate(v, type === "date"));
    if (serial != null)
      return numberCell(ref, serial, type === "date" ? STYLE.date : STYLE.datetime);
  }
  if (type === "number" || type === "money" || type === "percent") {
    const n = Number(String(v).replace(/[,$%\s]/g, ""));
    if (v.trim() !== "" && Number.isFinite(n)) {
      return numberCell(
        ref,
        type === "percent" && /%$/.test(v.trim()) ? n / 100 : n,
        type === "money" ? STYLE.money : type === "percent" ? STYLE.percent : STYLE.number,
      );
    }
  }
  return textCell(ref, v, STYLE.text);
}

function numberCell(ref: string, n: number, style: number): string {
  return `<c r="${ref}" s="${style}"><v>${numberText(n)}</v></c>`;
}

function textCell(ref: string, s: string, style: number): string {
  return (
    `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ""}>` +
    `<is><t xml:space="preserve">${escapeXml(s)}</t></is></c>`
  );
}

function numberText(n: number): string {
  // Avoid "1e+21" style output for large ids while staying exact for money.
  return Math.abs(n) >= 1e21 ? n.toLocaleString("en-US", { useGrouping: false }) : String(n);
}

/**
 * Days since 1899-12-30 (Excel's epoch once its 1900 leap-year bug is
 * accounted for). Uses the local calendar fields so a date reads the same in
 * the sheet as it did on screen, whatever zone the browser is in.
 */
export function excelSerial(d: Date | null): number | null {
  if (!d || !Number.isFinite(d.getTime())) return null;
  const utc = Date.UTC(
    d.getFullYear(),
    d.getMonth(),
    d.getDate(),
    d.getHours(),
    d.getMinutes(),
    d.getSeconds(),
    d.getMilliseconds(),
  );
  return (utc - Date.UTC(1899, 11, 30)) / 86_400_000;
}

/**
 * A bare `YYYY-MM-DD` is a calendar date and must not slide a day in a
 * western time zone, so it is anchored to local midnight (same rule as
 * `fmtDate` in table-prefs). Anything else goes through `Date`.
 */
export function parseIsoDate(s: string, dateOnly: boolean): Date | null {
  const t = s.trim();
  if (!t) return null;
  const bare = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (bare) {
    return new Date(Number(bare[1]), Number(bare[2]) - 1, Number(bare[3]));
  }
  const d = new Date(t);
  if (!Number.isFinite(d.getTime())) return null;
  if (dateOnly) return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return d;
}

/** Column width in characters, from the longest thing in the column. */
function columnWidths(sheet: ExportSheet): number[] {
  return sheet.headers.map((h, c) => {
    let max = h.length;
    for (const row of sheet.rows) {
      const len = displayLength(row[c], sheet.types[c]);
      if (len > max) max = len;
    }
    return Math.min(60, Math.max(8, max + 2));
  });
}

function displayLength(v: ExportValue, type: ExportCellType | undefined): number {
  if (v == null) return 0;
  if (v instanceof Date) return type === "datetime" ? 16 : 10;
  if (typeof v === "number") return numberText(v).length + (type === "money" ? 3 : 0);
  if (typeof v === "string" && (type === "date" || type === "datetime")) {
    return type === "datetime" ? 16 : 10;
  }
  const s = String(v);
  // Only the first line decides the width; long notes wrap in Excel anyway.
  const nl = s.indexOf("\n");
  return nl === -1 ? s.length : nl;
}

export function cellRef(colIndex: number, rowNumber: number): string {
  let n = colIndex + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return `${s}${rowNumber}`;
}

/** Excel sheet names: max 31 chars, none of `[]:*?/\`, not empty. */
export function sanitizeSheetName(name: string): string {
  const cleaned = name
    .replace(/[[\]:*?/\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 31);
  return cleaned || "Sheet";
}

function uniqueSheetNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((raw) => {
    let name = sanitizeSheetName(raw);
    const key = name.toLowerCase();
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    if (n > 0) name = `${name.slice(0, 31 - String(n + 1).length - 1)} ${n + 1}`;
    return name;
  });
}

/** XML 1.0 forbids most control characters outright; they are dropped, not escaped. */
export function escapeXml(s: string): string {
  return (
    s
      // eslint-disable-next-line no-control-regex -- stripping them is the whole point
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;")
  );
}

/* ------------------------------------------------------------------ */
/* Browser download                                                    */
/* ------------------------------------------------------------------ */

export function saveFile(filename: string, data: Uint8Array | string, mime: string): void {
  const part: BlobPart = typeof data === "string" ? data : (data.slice().buffer as ArrayBuffer);
  const blob = new Blob([part], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Build and download `<report>-<yyyy-mm-dd>.xlsx` from one or more sheets. */
export function downloadXlsx(report: string, sheets: ExportSheet | readonly ExportSheet[]): void {
  const list = Array.isArray(sheets) ? (sheets as ExportSheet[]) : [sheets as ExportSheet];
  saveFile(exportFilename(report, "xlsx"), buildXlsx(list), XLSX_MIME);
}

/** Same data, CSV — kept so existing callers can switch over one at a time. */
export function downloadCsvSheet(report: string, sheet: ExportSheet): void {
  saveFile(exportFilename(report, "csv"), buildCsv(sheet), CSV_MIME);
}
