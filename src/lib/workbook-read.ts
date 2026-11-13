/**
 * Reading an .xlsx workbook in the browser, back into rows of plain text.
 *
 * Mark, on the Equipment page beside Import register: "need to accept .xslx".
 * He means .xlsx — the register lives in Excel, and until now the dialog told
 * him to open the file and save it as CSV himself. A person holding a 388-row
 * asset register should be able to hand over the file he actually has.
 *
 * This is the mirror image of `export-table.ts`, which already writes a real
 * workbook by hand with `fflate` and says "no SheetJS". The same reasoning
 * applies in reverse, so there is no new dependency here: an .xlsx is a ZIP of
 * XML, fflate unzips it, and `DOMParser` reads it the way `esx.ts` reads a
 * Xactimate archive. SheetJS stopped publishing to npm after 0.18.5, and that
 * last published version still carries two high-severity advisories that CI
 * would fail on; ExcelJS is a 20 MB Node-shaped package. Neither is worth
 * carrying to turn a sheet into strings.
 *
 * Everything comes out as TEXT, deliberately. The caller joins it back into
 * the same delimited text a paste produces and hands it to the parser it
 * already had, so a spreadsheet and a paste converge before any column is
 * named — one set of column rules, one preview, one set of error messages.
 *
 * The messy parts of a real sheet are handled here because they are the same
 * for every importer: a title row above the headers, blank and merged leading
 * rows, several sheets in one workbook, numbers stored as text, dates stored
 * as Excel serials, trailing rows that hold formatting and nothing else.
 *
 * Pure, and bounded: a workbook is untrusted input, so the archive is capped
 * the way `parseEsxBytes` caps an ESX and a sparse cell reference cannot make
 * us allocate a million rows.
 */

import { unzipSync } from "fflate";

/** The whole file, and the whole archive once expanded. */
export const MAX_XLSX_BYTES = 32 * 1024 * 1024;
/** Any single part. The worksheet XML of a big register is the large one. */
export const MAX_XLSX_PART_BYTES = 16 * 1024 * 1024;
const MAX_XLSX_MEMBERS = 1024;

/**
 * A cell reference carries its own row and column, so a sheet with one cell
 * at `A1048576` would otherwise cost a million empty arrays. Past these the
 * cell is dropped: no register is this shape, and a file that is has not been
 * truncated silently — `truncated` says so.
 */
export const MAX_SHEET_ROWS = 100_000;
export const MAX_SHEET_COLUMNS = 512;

const SIZE_REASON = "This spreadsheet is larger than the import can open in the browser.";

class WorkbookSizeError extends Error {}

export type WorkbookSheet = {
  name: string;
  /** Row-major, already right-trimmed of empty cells. Never sparse. */
  rows: string[][];
  /** True when a cell fell outside the row/column caps above. */
  truncated: boolean;
};

export type WorkbookResult = { ok: true; sheets: WorkbookSheet[] } | { ok: false; reason: string };

/* ------------------------------------------------------------------ */
/* The archive                                                         */
/* ------------------------------------------------------------------ */

export function readWorkbook(buffer: ArrayBuffer): WorkbookResult {
  if (buffer.byteLength > MAX_XLSX_BYTES) return { ok: false, reason: SIZE_REASON };

  let files: Record<string, Uint8Array>;
  try {
    let expanded = 0;
    let count = 0;
    files = unzipSync(new Uint8Array(buffer), {
      filter: (member) => {
        expanded += member.originalSize;
        if (
          ++count > MAX_XLSX_MEMBERS ||
          expanded > MAX_XLSX_BYTES ||
          member.originalSize > MAX_XLSX_PART_BYTES
        ) {
          throw new WorkbookSizeError(SIZE_REASON);
        }
        // The pictures, themes and printer settings are never read.
        return /^xl\/(workbook\.xml|styles\.xml|sharedStrings\.xml|_rels\/workbook\.xml\.rels|worksheets\/.+\.xml)$/i.test(
          member.name,
        );
      },
    });
  } catch (error) {
    if (error instanceof WorkbookSizeError) return { ok: false, reason: SIZE_REASON };
    // Not a ZIP at all — most often an .xls, which is a different format.
    return {
      ok: false,
      reason:
        "This file is not a readable .xlsx workbook. An older .xls has to be saved as .xlsx first.",
    };
  }

  const part = (name: string) => {
    const key = Object.keys(files).find((k) => k.toLowerCase() === name.toLowerCase());
    return key ? new TextDecoder().decode(files[key]!) : null;
  };

  const workbookXml = part("xl/workbook.xml");
  if (!workbookXml) {
    return { ok: false, reason: "This file is a ZIP, but not a workbook — no xl/workbook.xml." };
  }
  const workbook = parseXml(workbookXml);
  if (!workbook) return { ok: false, reason: "The workbook in this file could not be read." };

  const shared = sharedStrings(part("xl/sharedStrings.xml"));
  const dateStyles = dateStyleFlags(part("xl/styles.xml"));
  const date1904 = /date1904\s*=\s*"(1|true)"/i.test(workbookXml);
  const targets = relationshipTargets(part("xl/_rels/workbook.xml.rels"));

  const sheets: WorkbookSheet[] = [];
  const entries = [...workbook.getElementsByTagName("sheet")];
  entries.forEach((el, i) => {
    const rid = el.getAttribute("r:id") ?? el.getAttribute("id");
    const target = (rid && targets.get(rid)) || `worksheets/sheet${i + 1}.xml`;
    const xml = part(`xl/${target.replace(/^\/?xl\//, "").replace(/^\//, "")}`);
    if (xml == null) return;
    const doc = parseXml(xml);
    if (!doc) return;
    sheets.push({
      name: el.getAttribute("name") || `Sheet ${i + 1}`,
      ...sheetRows(doc, { shared, dateStyles, date1904 }),
    });
  });

  // A workbook.xml that names no sheet we could resolve: fall back to the
  // worksheet parts in file order rather than claiming the file is unreadable.
  if (sheets.length === 0) {
    const names = Object.keys(files)
      .filter((n) => /^xl\/worksheets\/.+\.xml$/i.test(n))
      .sort();
    names.forEach((n, i) => {
      const doc = parseXml(new TextDecoder().decode(files[n]!));
      if (!doc) return;
      sheets.push({
        name: `Sheet ${i + 1}`,
        ...sheetRows(doc, { shared, dateStyles, date1904 }),
      });
    });
  }

  if (sheets.length === 0) {
    return { ok: false, reason: "This workbook has no readable sheets." };
  }
  return { ok: true, sheets };
}

/** A stray BOM or leading whitespace is enough to make DOMParser refuse. */
function parseXml(text: string): Document | null {
  const start = text.indexOf("<");
  if (start < 0) return null;
  try {
    const doc = new DOMParser().parseFromString(text.slice(start), "application/xml");
    if (!doc.documentElement || doc.getElementsByTagName("parsererror").length) return null;
    return doc;
  } catch {
    return null;
  }
}

/** rId → part path, from xl/_rels/workbook.xml.rels. */
function relationshipTargets(xml: string | null): Map<string, string> {
  const out = new Map<string, string>();
  const doc = xml ? parseXml(xml) : null;
  if (!doc) return out;
  for (const rel of doc.getElementsByTagName("Relationship")) {
    const id = rel.getAttribute("Id");
    const target = rel.getAttribute("Target");
    if (id && target) out.set(id, target);
  }
  return out;
}

/**
 * The shared-strings table. Excel writes most text there; our own exporter
 * writes inline strings instead, so both have to work — "export the register,
 * re-import it" is how this gets tested.
 */
function sharedStrings(xml: string | null): string[] {
  const doc = xml ? parseXml(xml) : null;
  if (!doc) return [];
  // A run-formatted string is several <t> under one <si>; they are one value.
  return [...doc.getElementsByTagName("si")].map((si) =>
    [...si.getElementsByTagName("t")].map((t) => t.textContent ?? "").join(""),
  );
}

/* ------------------------------------------------------------------ */
/* Dates                                                               */
/* ------------------------------------------------------------------ */

/**
 * Excel stores a date as a number and a format. Without the format a delivery
 * date imports as "45931", so styles.xml is read for the one thing that
 * matters: which cell styles are date formats.
 */
const BUILTIN_DATE_FORMATS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51,
  52, 53, 54, 55, 56, 57, 58,
]);

export function isDateFormatCode(code: string): boolean {
  const bare = code
    .replace(/\\./g, "")
    .replace(/"[^"]*"/g, "")
    .replace(/\[[^\]]*\]/g, "");
  return /[ymdhs]/i.test(bare);
}

/** Style index → is it a date format. */
function dateStyleFlags(xml: string | null): boolean[] {
  const doc = xml ? parseXml(xml) : null;
  if (!doc) return [];
  const custom = new Map<number, string>();
  for (const f of doc.getElementsByTagName("numFmt")) {
    const id = Number(f.getAttribute("numFmtId"));
    const code = f.getAttribute("formatCode");
    if (Number.isFinite(id) && code != null) custom.set(id, code);
  }
  const cellXfs = doc.getElementsByTagName("cellXfs")[0];
  if (!cellXfs) return [];
  return [...cellXfs.getElementsByTagName("xf")].map((xf) => {
    const id = Number(xf.getAttribute("numFmtId") ?? 0);
    if (!Number.isFinite(id)) return false;
    const code = custom.get(id);
    return code != null ? isDateFormatCode(code) : BUILTIN_DATE_FORMATS.has(id);
  });
}

/**
 * An Excel serial back to text. The inverse of `excelSerial` in
 * `export-table.ts`: days since 1899-12-30, or since 1904-01-01 in the Mac
 * date system a few old workbooks still use. Built from UTC fields because
 * that is what the exporter put in, so a round trip lands on the same day in
 * every time zone.
 *
 * Note there is no clock here and no default date anywhere in this file. A
 * serial is an absolute day; the moment a conversion like this reaches for
 * `Date.now()` it starts aging with the real calendar.
 */
export function excelSerialToText(serial: number, date1904 = false): string {
  if (!Number.isFinite(serial)) return "";
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const d = new Date(epoch + Math.round(serial * 86_400) * 1000);
  if (!Number.isFinite(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  const day = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  const secs = d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();
  if (secs === 0) return day;
  return `${day} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/* ------------------------------------------------------------------ */
/* One worksheet                                                       */
/* ------------------------------------------------------------------ */

/** `BC` → 54. Column letters are the only reliable position in a sparse row. */
export function columnIndex(ref: string): number {
  const letters = /^([A-Za-z]+)/.exec(ref)?.[1];
  if (!letters) return -1;
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function sheetRows(
  doc: Document,
  ctx: { shared: string[]; dateStyles: boolean[]; date1904: boolean },
): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = [];
  let truncated = false;
  let cursor = 0; // for a <row> with no r= attribute

  for (const rowEl of doc.getElementsByTagName("row")) {
    const declared = Number(rowEl.getAttribute("r"));
    const rowIndex = Number.isFinite(declared) && declared > 0 ? declared - 1 : cursor;
    cursor = rowIndex + 1;
    if (rowIndex >= MAX_SHEET_ROWS) {
      truncated = true;
      continue;
    }
    const cells: string[] = [];
    let col = 0;
    for (const cellEl of rowEl.getElementsByTagName("c")) {
      const ref = cellEl.getAttribute("r");
      const at = ref ? columnIndex(ref) : col;
      const index = at >= 0 ? at : col;
      col = index + 1;
      if (index >= MAX_SHEET_COLUMNS) {
        truncated = true;
        continue;
      }
      const value = cellText(cellEl, ctx);
      if (!value) continue;
      while (cells.length < index) cells.push("");
      cells[index] = value;
    }
    while (rows.length < rowIndex) rows.push([]);
    rows[rowIndex] = cells;
  }

  // Trailing rows that carried only formatting are not rows of anything.
  while (rows.length && !rows[rows.length - 1]!.some((c) => c.trim())) rows.pop();
  return { rows, truncated };
}

function cellText(
  cell: Element,
  ctx: { shared: string[]; dateStyles: boolean[]; date1904: boolean },
): string {
  const type = cell.getAttribute("t");
  const v = cell.getElementsByTagName("v")[0]?.textContent ?? "";

  if (type === "s") {
    const i = Number(v);
    return Number.isInteger(i) ? (ctx.shared[i] ?? "") : "";
  }
  if (type === "inlineStr") {
    const is = cell.getElementsByTagName("is")[0];
    return is ? [...is.getElementsByTagName("t")].map((t) => t.textContent ?? "").join("") : "";
  }
  // "str" is a formula's cached text result; "d" an ISO date (rare, OOXML 2012).
  if (type === "str" || type === "d") return v.trim();
  if (type === "b") return v === "1" ? "TRUE" : "FALSE";
  // #N/A, #REF! and friends. Importing the words would be worse than nothing.
  if (type === "e") return "";

  if (!v.trim()) return "";
  const n = Number(v);
  if (!Number.isFinite(n)) return v.trim();

  const style = Number(cell.getAttribute("s") ?? 0);
  if (Number.isFinite(style) && ctx.dateStyles[style]) {
    return excelSerialToText(n, ctx.date1904);
  }
  return numberText(v, n);
}

/**
 * A number as the sheet meant it. An integer keeps its exact digits — an asset
 * number or a serial longer than 15 digits must not come back as 1.23e+19 —
 * and anything else goes through `Number` so a stored `80.00` reads as 80.
 */
function numberText(raw: string, n: number): string {
  const text = raw.trim();
  return /^-?\d+$/.test(text) ? text : String(n);
}

/* ------------------------------------------------------------------ */
/* Sheet → the text the paste box would have held                      */
/* ------------------------------------------------------------------ */

/**
 * Where the headers actually are. Real sheets open with a title, a logo row,
 * a merged banner or just blank rows — a merged cell writes its value once in
 * the top-left and leaves the rest empty, so those rows arrive here as short
 * or empty ones. The caller supplies the test, which is the importer's OWN
 * column matching: there is no second set of header rules in this file.
 *
 * Returns -1 when nothing in the first `lookahead` rows looks like a header,
 * so the caller can hand the sheet over whole and let the parser give its
 * usual "No Tag column found" answer rather than inventing a different one.
 */
export function findHeaderRow(
  rows: readonly (readonly string[])[],
  isHeader: (cells: string[]) => boolean,
  lookahead = 25,
): number {
  const limit = Math.min(rows.length, lookahead);
  for (let i = 0; i < limit; i++) {
    const cells = [...(rows[i] ?? [])];
    if (cells.some((c) => c.trim()) && isHeader(cells)) return i;
  }
  return -1;
}

/**
 * Which sheet to import. The first one whose headers we recognise — a
 * workbook often opens on a cover sheet or a count tab — and failing that the
 * first sheet, which the dialog then names out loud so nobody is guessing.
 */
export function pickSheet(
  sheets: readonly WorkbookSheet[],
  isHeader: (cells: string[]) => boolean,
): number {
  const found = sheets.findIndex((s) => findHeaderRow(s.rows, isHeader) >= 0);
  return found >= 0 ? found : 0;
}

/**
 * The sheet as delimited text, in the shape a paste from Excel produces, so
 * the existing parser is the only thing that ever reads a column.
 *
 * Quoted the way `splitCsvLine` unquotes. A newline inside a cell becomes a
 * space: the parser is line-oriented, and a wrapped note is worth keeping on
 * one line more than it is worth splitting a unit across two rows.
 */
export function sheetToDelimitedText(rows: readonly (readonly string[])[]): string {
  return rows.map((r) => r.map(csvField).join(",")).join("\n");
}

function csvField(value: string): string {
  const s = (value ?? "").replace(/[\r\n]+/g, " ");
  return /["\t,]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * The whole conversion: a sheet in, the import text out, plus the sheet row
 * the headers were on so the dialog can say where it started reading.
 */
export function sheetToImportText(
  sheet: WorkbookSheet,
  isHeader: (cells: string[]) => boolean,
): { text: string; headerRow: number } {
  const at = findHeaderRow(sheet.rows, isHeader);
  const rows = at > 0 ? sheet.rows.slice(at) : sheet.rows;
  return { text: sheetToDelimitedText(rows), headerRow: at >= 0 ? at + 1 : 0 };
}
