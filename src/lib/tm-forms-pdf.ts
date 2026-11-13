/**
 * The T&M sheets as PDFs: Gold Star's own paper, filled in.
 *
 * Mark asked for "these pdfs, fillable". The filled PDF is therefore not a
 * redrawing of the sheet — it is the ORIGINAL sheet (the PDFs Gold Star
 * prints, shipped in public/forms/tm/) with the crew's entries written onto
 * it, so the logo, headings, columns and the crew chief report's bilingual
 * labels are exactly the paper's. Where each entry goes is measured from those
 * files (src/lib/tm-forms-layout.ts).
 *
 * What does not fit the paper is never dropped: a crew longer than the sheet's
 * 36 rows continues on another copy of the sheet; notes longer than the
 * report's lines, and any supply line the printed sheet has no box for (a code
 * an admin added after it was printed), continue on a page of their own.
 *
 * `blankTmFormPdf` is the other half of "fillable": the same sheet with
 * AcroForm text boxes over every blank, for a crew that still wants paper or
 * a foreman who fills it in on a laptop.
 *
 * Both are internal documents — crew names, times, signatures — filed on the
 * job, never sent to a customer from here.
 */
import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFImage,
  type PDFPage,
} from "pdf-lib";

import {
  CREW_STAFF_SLOTS,
  LODGING_OPTIONS,
  rowIsFilled,
  sortByCatalogue,
  type CrewChiefPayload,
  type SignInPayload,
  type SupplyListPayload,
  type TmFormKind,
  type TmPayloadByKind,
} from "@/lib/tm-forms";
import {
  CREW_CHIEF_LAYOUT,
  SIGN_IN_LAYOUT,
  SIGN_IN_ROWS_PER_PAGE,
  SUPPLY_LIST_LAYOUT,
  type FieldSpot,
} from "@/lib/tm-forms-layout";
import { TM_SECTION_LABEL, type TmRateCode } from "@/lib/tm-rate-codes";

/** Ballpoint blue, so the entries read as filled in rather than printed. */
const PEN = rgb(0.05, 0.16, 0.48);
const INK = rgb(0.1, 0.1, 0.12);

/**
 * Helvetica in a PDF is WinAnsi: Latin-1 is there (José, Muñoz, Peña), smart
 * quotes and dashes are not. Normalise those, drop anything else that would
 * make pdf-lib throw — a name must never stop the sheet from printing.
 */
export function winAnsi(s: string): string {
  return (s ?? "")
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/[\r\n\t]+/g, " ")
    .split("")
    .filter((c) => {
      const n = c.charCodeAt(0);
      return (n >= 32 && n <= 126) || (n >= 160 && n <= 255);
    })
    .join("");
}

/** "07:30" → "7:30 AM"; anything else prints as given. */
export function clock12(hhmm: string): string {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) return hhmm;
  const h = Number(m[1]);
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h < 12 ? "AM" : "PM"}`;
}

/** "2026-10-07" → "10/07/2026", the way the office writes a date on paper. */
export function paperDate(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : day;
}

/** Write text at a spot, shrinking it to the width (down to a floor) and then cutting it. */
function put(
  page: PDFPage,
  font: PDFFont,
  text: string,
  spot: FieldSpot,
  size: number,
  opts: { align?: "left" | "center"; color?: ReturnType<typeof rgb>; min?: number } = {},
) {
  let s = winAnsi(text).trim();
  if (!s) return;
  const [x, y, maxW] = spot;
  const min = opts.min ?? Math.min(size, 5);
  let sz = size;
  while (sz > min && font.widthOfTextAtSize(s, sz) > maxW) sz -= 0.25;
  while (s.length > 1 && font.widthOfTextAtSize(s, sz) > maxW) s = s.slice(0, -1);
  const w = font.widthOfTextAtSize(s, sz);
  page.drawText(s, {
    x: opts.align === "center" ? x - w / 2 : x,
    y,
    size: sz,
    font,
    color: opts.color ?? PEN,
  });
}

/** Word-wrap to a width; long words are broken rather than overflowing. */
export function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of (text ?? "").replace(/\r\n/g, "\n").split("\n")) {
    const words = winAnsi(para).split(/\s+/).filter(Boolean);
    if (!words.length) {
      out.push("");
      continue;
    }
    let line = "";
    for (let word of words) {
      while (font.widthOfTextAtSize(word, size) > width) {
        let cut = word.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(word.slice(0, cut), size) > width) cut--;
        if (line) {
          out.push(line);
          line = "";
        }
        out.push(word.slice(0, cut));
        word = word.slice(cut);
      }
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) > width && line) {
        out.push(line);
        line = word;
      } else line = next;
    }
    out.push(line);
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  return out;
}

/** Copies of the template's page into a fresh document, one per printed sheet. */
async function sheets(template: Uint8Array, count: number) {
  const out = await PDFDocument.create();
  const src = await PDFDocument.load(template);
  const pages = await out.copyPages(
    src,
    Array.from({ length: count }, () => 0),
  );
  for (const p of pages) out.addPage(p);
  const font = await out.embedFont(StandardFonts.Helvetica);
  const bold = await out.embedFont(StandardFonts.HelveticaBold);
  return { out, pages, font, bold };
}

/** A plain continuation page in the sheet's own words, for what the paper has no room for. */
function continuation(
  out: PDFDocument,
  font: PDFFont,
  bold: PDFFont,
  title: string,
  subtitle: string,
): { page: PDFPage; y: number } {
  const page = out.addPage([612, 792]);
  page.drawText(winAnsi(title), { x: 54, y: 740, size: 13, font: bold, color: INK });
  page.drawText(winAnsi(subtitle), { x: 54, y: 724, size: 9, font, color: INK });
  page.drawLine({
    start: { x: 54, y: 716 },
    end: { x: 558, y: 716 },
    thickness: 0.8,
    color: INK,
  });
  return { page, y: 700 };
}

function pageNumbers(pages: PDFPage[], font: PDFFont) {
  if (pages.length < 2) return;
  pages.forEach((p, i) =>
    p.drawText(`Page ${i + 1} of ${pages.length}`, { x: 500, y: 28, size: 8, font, color: INK }),
  );
}

async function pngOrNull(out: PDFDocument, dataUrl: string | null): Promise<PDFImage | null> {
  if (!dataUrl?.startsWith("data:image/png;base64,")) return null;
  try {
    const b64 = dataUrl.slice("data:image/png;base64,".length);
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return await out.embedPng(bytes);
  } catch {
    // A damaged signature image prints as a blank box, never as a failed sheet.
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Crew Sign In/Out Sheet                                              */
/* ------------------------------------------------------------------ */

export async function fillSignInPdf(
  payload: SignInPayload,
  day: string,
  template: Uint8Array,
): Promise<Uint8Array> {
  const rows = payload.rows.filter(rowIsFilled);
  const count = Math.max(1, Math.ceil(rows.length / SIGN_IN_ROWS_PER_PAGE));
  const { out, pages, font } = await sheets(template, count);
  const L = SIGN_IN_LAYOUT;
  const col = L.columns;
  const short = new Map<string, string>(LODGING_OPTIONS.map((o) => [o.key, o.short]));

  for (let p = 0; p < pages.length; p++) {
    const page = pages[p]!;
    put(page, font, payload.jobName, L.jobName, 10);
    put(page, font, payload.jobLocation, L.jobLocation, 10);
    put(page, font, paperDate(day), L.date, 10);

    const slice = rows.slice(p * SIGN_IN_ROWS_PER_PAGE, (p + 1) * SIGN_IN_ROWS_PER_PAGE);
    for (let i = 0; i < slice.length; i++) {
      const r = slice[i]!;
      const top = L.rowRules[i]!;
      const bottom = L.rowRules[i + 1]!;
      const base = bottom + Math.max(2.5, (top - bottom - 7) / 2 + 1);
      const cell = (c: number, text: string, center = true) =>
        put(
          page,
          font,
          text,
          center
            ? [(col[c]! + col[c + 1]!) / 2, base, col[c + 1]! - col[c]! - 3]
            : [col[c]! + 2.5, base, col[c + 1]! - col[c]! - 5],
          7.5,
          { align: center ? "center" : "left", min: 4.5 },
        );
      cell(0, r.employee, false);
      cell(1, r.rateCode);
      cell(2, clock12(r.timeIn));
      cell(3, clock12(r.lunchStart));
      cell(4, clock12(r.lunchEnd));
      cell(5, clock12(r.timeOut));
      cell(6, short.get(r.lodging) ?? "");
      const sig = await pngOrNull(out, r.signature);
      // Signed on the paper sheet that was scanned in: that paper is filed beside this PDF.
      if (!sig && r.paperSigned) cell(7, "Signed on paper");
      if (sig) {
        const h = top - bottom - 1.6;
        const w = Math.min(col[8]! - col[7]! - 4, (sig.width / sig.height) * h);
        page.drawImage(sig, { x: col[7]! + 2, y: bottom + 0.8, width: w, height: h });
      }
    }
  }
  pageNumbers(pages, font);
  return out.save();
}

/* ------------------------------------------------------------------ */
/* Daily Crew Chief                                                    */
/* ------------------------------------------------------------------ */

export async function fillCrewChiefPdf(
  payload: CrewChiefPayload,
  day: string,
  template: Uint8Array,
): Promise<Uint8Array> {
  const { out, pages, font, bold } = await sheets(template, 1);
  const page = pages[0]!;
  const L = CREW_CHIEF_LAYOUT;
  put(page, font, payload.jobName, L.jobName, 10);
  put(page, font, payload.jobLocation, L.jobLocation, 10);
  put(page, font, paperDate(day), L.date, 10);
  put(page, font, payload.supervisor, L.supervisor, 10);
  put(page, font, payload.workZone, L.workZone, 10);
  put(page, font, payload.crewChief, L.crewChief, 10);
  put(page, font, payload.crewNumber, L.crewNumber, 10);
  put(page, font, payload.crewSize, L.crewSize, 10);

  // Down the left column, then the right: the order the crew is listed in.
  const rowsPerCol = L.staffRules.length - 1;
  payload.staff.slice(0, CREW_STAFF_SLOTS).forEach((name, i) => {
    const c = Math.floor(i / rowsPerCol);
    const r = i % rowsPerCol;
    const bottom = L.staffRules[r + 1]!;
    put(
      page,
      font,
      name,
      [L.staffColumns[c]! + 4, bottom + 3, L.staffColumns[c + 1]! - L.staffColumns[c]! - 8],
      8.5,
    );
  });

  const lines = wrap(payload.notes, font, 9.5, L.notesWidth);
  const onSheet = lines.slice(0, L.notesBaselines.length);
  onSheet.forEach((line, i) =>
    put(page, font, line, [L.notesLeft, L.notesBaselines[i]! + 1.5, L.notesWidth], 9.5),
  );
  const rest = lines.slice(L.notesBaselines.length);
  if (rest.length) {
    let { page: more, y } = continuation(
      out,
      font,
      bold,
      "Daily Work Notes / Notas de trabajo diarias (continued)",
      `${payload.jobName}  -  ${paperDate(day)}`,
    );
    for (const line of rest) {
      if (y < 60)
        ({ page: more, y } = continuation(
          out,
          font,
          bold,
          "Daily Work Notes (continued)",
          paperDate(day),
        ));
      more.drawText(line, { x: 54, y, size: 10, font, color: PEN });
      y -= 15;
    }
  }
  return out.save();
}

/* ------------------------------------------------------------------ */
/* Daily Supply List                                                   */
/* ------------------------------------------------------------------ */

export async function fillSupplyListPdf(
  payload: SupplyListPayload,
  day: string,
  template: Uint8Array,
  catalogue: readonly TmRateCode[],
): Promise<Uint8Array> {
  const { out, pages, font, bold } = await sheets(template, 1);
  const page = pages[0]!;
  const L = SUPPLY_LIST_LAYOUT;
  put(page, font, payload.jobName, L.jobName, 6.5, { min: 4 });
  put(page, font, payload.jobLocation, L.jobLocation, 6.5, { min: 4 });
  put(page, font, paperDate(day), L.date, 6.5, { min: 4 });
  put(page, font, payload.totalCrew, L.totalCrew, 6.5, { min: 4 });

  const offSheet: { code: string; qty: number }[] = [];
  for (const line of sortByCatalogue(payload.lines, catalogue)) {
    const spot = L.quantity[line.code];
    if (!spot) {
      offSheet.push(line);
      continue;
    }
    put(page, bold, formatQty(line.qty), [spot[0], spot[1], L.quantityWidth], 6.5, {
      align: "center",
      min: 4,
    });
  }

  if (offSheet.length) {
    const byCode = new Map(catalogue.map((c) => [c.code, c]));
    let { page: more, y } = continuation(
      out,
      font,
      bold,
      "Daily Supply List - additional lines",
      `${payload.jobName}  -  ${paperDate(day)}  -  codes added after this sheet was printed`,
    );
    for (const line of offSheet) {
      const c = byCode.get(line.code);
      const section = c ? TM_SECTION_LABEL[c.section] : "";
      more.drawText(winAnsi(c?.section === "general" ? "" : line.code), {
        x: 54,
        y,
        size: 10,
        font: bold,
        color: INK,
      });
      more.drawText(winAnsi(`${c?.label ?? "(unknown code)"}${section ? `  (${section})` : ""}`), {
        x: 100,
        y,
        size: 10,
        font,
        color: INK,
      });
      more.drawText(formatQty(line.qty), { x: 520, y, size: 10, font: bold, color: PEN });
      y -= 16;
      if (y < 60)
        ({ page: more, y } = continuation(
          out,
          font,
          bold,
          "Daily Supply List - additional lines",
          paperDate(day),
        ));
    }
  }
  return out.save();
}

export function formatQty(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

/** The filled sheet, whichever kind. */
export function fillTmFormPdf<K extends TmFormKind>(
  kind: K,
  payload: TmPayloadByKind[K],
  day: string,
  template: Uint8Array,
  catalogue: readonly TmRateCode[],
): Promise<Uint8Array> {
  if (kind === "sign_in") return fillSignInPdf(payload as SignInPayload, day, template);
  if (kind === "crew_chief") return fillCrewChiefPdf(payload as CrewChiefPayload, day, template);
  return fillSupplyListPdf(payload as SupplyListPayload, day, template, catalogue);
}

/* ------------------------------------------------------------------ */
/* Blank, with AcroForm boxes                                          */
/* ------------------------------------------------------------------ */

/**
 * The original sheet with a text box over every blank. Signatures are left
 * for a pen: pdf-lib cannot make a signature field, and a typed name in a
 * signature box is not a signature.
 */
export async function blankTmFormPdf(kind: TmFormKind, template: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(template);
  const page = doc.getPage(0);
  const form = doc.getForm();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const box = (
    name: string,
    x: number,
    y: number,
    w: number,
    h: number,
    size: number,
    multiline = false,
  ) => {
    const f = form.createTextField(name);
    if (multiline) f.enableMultiline();
    // Transparent: the sheet's own underlines and rules must show through.
    f.addToPage(page, {
      x,
      y,
      width: w,
      height: h,
      borderWidth: 0,
      backgroundColor: undefined,
      font,
    });
    f.setFontSize(size);
  };
  const header = (name: string, spot: FieldSpot, h: number, size: number) =>
    box(name, spot[0], spot[1] - 2.5, spot[2], h, size);

  if (kind === "sign_in") {
    const L = SIGN_IN_LAYOUT;
    header("job_name", L.jobName, 12, 10);
    header("job_location", L.jobLocation, 12, 10);
    header("date", L.date, 12, 10);
    const names = [
      "employee",
      "rate_code",
      "time_in",
      "lunch_start",
      "lunch_end",
      "time_out",
      "hotel_per_diem",
    ];
    for (let r = 0; r < SIGN_IN_ROWS_PER_PAGE; r++) {
      const top = L.rowRules[r]!;
      const bottom = L.rowRules[r + 1]!;
      names.forEach((n, c) =>
        box(
          `${n}_${r + 1}`,
          L.columns[c]! + 1,
          bottom + 0.6,
          L.columns[c + 1]! - L.columns[c]! - 2,
          top - bottom - 1.2,
          7,
        ),
      );
    }
  } else if (kind === "crew_chief") {
    const L = CREW_CHIEF_LAYOUT;
    header("job_name", L.jobName, 12, 10);
    header("job_location", L.jobLocation, 12, 10);
    header("date", L.date, 12, 10);
    header("supervisor", L.supervisor, 12, 10);
    header("work_zone", L.workZone, 12, 10);
    header("crew_chief", L.crewChief, 12, 10);
    header("crew_number", L.crewNumber, 12, 10);
    header("crew_size", L.crewSize, 12, 10);
    const rowsPerCol = L.staffRules.length - 1;
    for (let i = 0; i < CREW_STAFF_SLOTS; i++) {
      const c = Math.floor(i / rowsPerCol);
      const r = i % rowsPerCol;
      const top = L.staffRules[r]!;
      const bottom = L.staffRules[r + 1]!;
      box(
        `crew_staff_${i + 1}`,
        L.staffColumns[c]! + 2,
        bottom + 0.6,
        L.staffColumns[c + 1]! - L.staffColumns[c]! - 4,
        top - bottom - 1.2,
        8.5,
      );
    }
    const top = L.notesBaselines[0]! + 14;
    const bottom = L.notesBaselines[L.notesBaselines.length - 1]! - 4;
    box("daily_work_notes", L.notesLeft - 2, bottom, L.notesWidth + 4, top - bottom, 9.5, true);
  } else {
    const L = SUPPLY_LIST_LAYOUT;
    header("job_name", L.jobName, 8, 6);
    header("job_location", L.jobLocation, 8, 6);
    header("date", L.date, 8, 6);
    header("total_crew_amount", L.totalCrew, 8, 6);
    for (const [code, [cx, y]] of Object.entries(L.quantity)) {
      box(`qty_${code}`, cx - L.quantityWidth / 2 + 0.5, y - 1.8, L.quantityWidth - 1, 6.6, 6);
    }
  }
  return doc.save();
}
