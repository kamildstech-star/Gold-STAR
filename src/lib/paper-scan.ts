/**
 * Paper T&M sheets scanned straight onto the job (12 Nov).
 *
 * "When we upload the sign-in paper sheet it should ask: we found these
 * people with no check-out or lunch time — enter them, or default 5 PM — and
 * on that basis we calculate the T&M bill." And: "the date inside the paper
 * should be in the file name, and the report should be on that date", "they
 * cannot upload a duplicate sheet again and again", "after uploading don't
 * put it in Pictures, put it in Documents as a PDF".
 *
 * So a scan is: the photo's SHA-256 checked against every sheet on the job,
 * the paper read, the missing times asked for, the rows saved onto the sign-in
 * sheet OF THE PAPER'S DATE (rows signed on paper count as signed — the T&M
 * bill bills them), and the photo filed in Documents as a PDF named with that
 * date. This file is the pure half; the dialog is paper-scan-upload.tsx.
 */
import { laterThan, type ScannedRow } from "@/lib/sign-in-scan";
import { signInHours } from "@/lib/tm-bill";
import {
  TM_FORM_META,
  keepQuantities,
  type SupplyLine,
  type SupplyListPayload,
  type TmFormKind,
} from "@/lib/tm-forms";

/** The two sheets that have a paper scan. */
export type PaperScanKind = Extract<TmFormKind, "sign_in" | "supply_list">;

/** "11/09/2026" from "2026-11-09". */
export function usPaperDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : iso;
}

/** What the scan is called on the job's Documents: the paper's own date in it. */
export function paperScanDocName(kind: PaperScanKind, date: string): string {
  return `${TM_FORM_META[kind].paperTitle} (paper scan) - ${usPaperDate(date)}`;
}

/** The PDF's file name: crew-sign-in-sheet-paper-2609221-2026-11-09.pdf. */
export function paperScanFilename(
  kind: PaperScanKind,
  date: string,
  jobNumber?: string | null,
): string {
  const job = (jobNumber ?? "").replace(/[^A-Za-z0-9-]+/g, "");
  return `${TM_FORM_META[kind].fileStem}-paper${job ? `-${job}` : ""}-${date}.pdf`;
}

/** The default time out when the paper has none: 5 PM, as the office asked. */
export const DEFAULT_TIME_OUT = "17:00";

export type MissingTimes = {
  /** Rows with a time in but no time out: they bill nothing until one is given. */
  noOut: number[];
  /** Rows with neither lunch box written: billed with no lunch break unless one is given. */
  noLunch: number[];
  /** Rows with no time in at all. */
  noIn: number[];
};

/** Which of the kept rows are missing a time, by index. */
export function missingTimes(rows: readonly ScannedRow[]): MissingTimes {
  const out: MissingTimes = { noOut: [], noLunch: [], noIn: [] };
  rows.forEach((r, i) => {
    if (!r.timeIn) out.noIn.push(i);
    if (r.timeIn && !r.timeOut) out.noOut.push(i);
    if (r.timeIn && !r.lunchStart && !r.lunchEnd) out.noLunch.push(i);
  });
  return out;
}

/**
 * The defaults put into the boxes the paper left empty: a time out for anyone
 * who came in and has none, and — only when a lunch is given — that lunch for
 * anyone with neither lunch box written. What the paper says is never changed.
 */
export function fillMissingTimes<R extends ScannedRow>(
  rows: readonly R[],
  defaults: { timeOut: string; lunchStart: string; lunchEnd: string },
): R[] {
  const lunch = defaults.lunchStart && defaults.lunchEnd && defaults.lunchEnd > defaults.lunchStart;
  return rows.map((r) => {
    if (!r.timeIn) return r;
    const next = { ...r };
    if (lunch && !next.lunchStart && !next.lunchEnd) {
      next.lunchStart = defaults.lunchStart;
      next.lunchEnd = defaults.lunchEnd;
    }
    if (!next.timeOut && defaults.timeOut) {
      next.timeOut = laterThan(next.lunchEnd || next.timeIn, defaults.timeOut);
    }
    return next;
  });
}

/** Worked hours on the rows, as the T&M bill counts them (out − in − lunch). */
export function scannedHours(rows: readonly ScannedRow[]): number {
  const total = rows.reduce((sum, r) => sum + signInHours(r).hours, 0);
  return Math.round(total * 100) / 100;
}

/* ------------------------------------------------------------------ */
/* Supply list                                                         */
/* ------------------------------------------------------------------ */

/**
 * The paper's quantities onto the day's supply list. A code the sheet
 * already has keeps its quantity (someone typed it on purpose); the paper
 * fills the rest. Total crew is filled only when the sheet has none.
 */
export function applySupplyScan(
  sheet: SupplyListPayload,
  lines: readonly SupplyLine[],
  totalCrew: string,
): { sheet: SupplyListPayload; added: number } {
  const have = new Set(sheet.lines.map((l) => l.code));
  const extra = keepQuantities(lines).filter((l) => !have.has(l.code));
  return {
    sheet: {
      ...sheet,
      totalCrew: sheet.totalCrew || totalCrew,
      lines: keepQuantities([...sheet.lines, ...extra]),
    },
    added: extra.length,
  };
}
