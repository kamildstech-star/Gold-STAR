/**
 * Every T&M sheet on a job, filled in, as ONE PDF for the carrier.
 *
 * David, 15 Oct: a large T&M job is days away and the insurance company wants
 * the field paper as backup — every sign-in sheet, crew chief report and
 * supply list, on Gold Star's own sheets with the crew's signatures, for the
 * whole job or for a date range. One button at the top of the Field Form tab.
 *
 * Nothing new draws a sheet. Each day is filled by the same renderer that
 * files the single sheet (`fillTmFormPdf`, the original paper with the
 * entries and signatures written on), and the pages are put together by the
 * folder merger (`mergeFolderPdf`) that already combines a Documents folder.
 * Which sheets and in what order is decided in tm-forms-bundle-plan.ts; this
 * fills them and puts a plain divider in front of each kind so the carrier
 * can find the supply lists without paging through forty sign-in sheets.
 *
 * Sheets are re-filled from what is stored rather than read back from the
 * filed PDFs: a sheet can be saved without ever being filed, and a sign-in
 * sheet signed on a second phone after it was filed would otherwise go out
 * missing that signature.
 *
 *
 * pdf-lib comes in through tm-forms-pdf; load this module with
 * `await import(...)` from a component, as document-folder-pdf.ts asks.
 */
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

import { mergeFolderPdf, type FolderPdfItem } from "@/lib/document-folder-pdf";
import { TM_FORM_META, type TmFormKind, type TmPayloadByKind } from "@/lib/tm-forms";
import type { TmBundleGroup, TmBundleRange } from "@/lib/tm-forms-bundle-plan";
import { fillTmFormPdf, paperDate, winAnsi } from "@/lib/tm-forms-pdf";
import type { TmRateCode } from "@/lib/tm-rate-codes";

/** "10/01/2026 - 10/14/2026", or the one day, for a divider and the cover. */
export function spanText(days: readonly string[]): string {
  if (!days.length) return "";
  const first = paperDate(days[0]!);
  const last = paperDate(days[days.length - 1]!);
  return first === last ? first : `${first} - ${last}`;
}

const INK = rgb(0.1, 0.1, 0.12);
const MUTED = rgb(0.38, 0.4, 0.45);

/** A plain US Letter page with a heading and lines under it: the cover and each divider. */
async function plainPage(title: string, lines: readonly string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  page.drawText(winAnsi(title), { x: 54, y: 700, size: 20, font: bold, color: INK });
  page.drawLine({ start: { x: 54, y: 688 }, end: { x: 558, y: 688 }, thickness: 1, color: INK });
  let y = 664;
  for (const line of lines) {
    if (y < 60) break;
    page.drawText(winAnsi(line).slice(0, 100), { x: 54, y, size: 11, font, color: MUTED });
    y -= 18;
  }
  return doc.save();
}

export type TmBundleInput = {
  jobName: string;
  jobNumber: string | null;
  range: TmBundleRange;
  groups: readonly TmBundleGroup[];
  /** The stored sheet for that day, or null when it has gone (deleted since the list loaded). */
  load: <K extends TmFormKind>(kind: K, day: string) => Promise<TmPayloadByKind[K] | null>;
  template: (kind: TmFormKind) => Promise<Uint8Array>;
  catalogue: readonly TmRateCode[];
  /** Called after each sheet, for a progress line on a long job. */
  onProgress?: (done: number, total: number) => void;
};

export type TmBundleResult = {
  bytes: Uint8Array;
  pages: number;
  sheets: number;
  /** Sheets that could not be filled, named on the PDF's last page too. */
  skipped: { name: string; reason: string }[];
};

/**
 * Build the PDF. Sheets are filled one at a time: a sign-in sheet carries a
 * signature image per row, and a month of them at once is more memory than a
 * phone in the field should be asked for.
 */
export async function buildTmFormsBundle(input: TmBundleInput): Promise<TmBundleResult> {
  const total = input.groups.reduce((n, g) => n + g.days.length, 0);
  const allDays = input.groups.flatMap((g) => g.days).sort();
  const items: FolderPdfItem[] = [];
  const failed: { name: string; reason: string }[] = [];

  items.push({
    name: "Cover",
    kind: "pdf",
    bytes: await plainPage("T&M field forms", [
      input.jobName,
      input.jobNumber ? `Job ${input.jobNumber}` : "",
      `Dates: ${spanText(allDays) || "none"}`,
      "",
      ...input.groups.map(
        (g) => `${g.title}: ${g.days.length} ${g.days.length === 1 ? "day" : "days"}`,
      ),
    ]),
  });

  const templates = new Map<TmFormKind, Uint8Array>();
  let done = 0;
  for (const group of input.groups) {
    items.push({
      name: group.title,
      kind: "pdf",
      bytes: await plainPage(group.title, [
        input.jobName,
        `${group.days.length} ${group.days.length === 1 ? "sheet" : "sheets"} - ${spanText(group.days)}`,
      ]),
    });
    if (!templates.has(group.kind)) templates.set(group.kind, await input.template(group.kind));
    const template = templates.get(group.kind)!;
    for (const day of group.days) {
      const name = `${TM_FORM_META[group.kind].paperTitle} - ${paperDate(day)}`;
      try {
        const payload = await input.load(group.kind, day);
        if (!payload) {
          failed.push({ name, reason: "no longer on the job" });
        } else {
          items.push({
            name,
            kind: "pdf",
            bytes: await fillTmFormPdf(group.kind, payload, day, template, input.catalogue),
          });
        }
      } catch (e) {
        failed.push({ name, reason: e instanceof Error ? e.message : "could not be filled" });
      }
      done += 1;
      input.onProgress?.(done, total);
    }
  }

  const merged = await mergeFolderPdf({
    title: `T&M field forms${input.jobNumber ? ` - ${input.jobNumber}` : ""}`,
    // A sheet that could not be filled is named on the closing "Not included"
    // page with its reason, rather than vanishing from the carrier's copy.
    items: [
      ...items,
      ...failed.map((f) => ({
        name: f.name,
        kind: "other" as const,
        bytes: new Uint8Array(),
        skipReason: f.reason,
      })),
    ],
  });
  return {
    bytes: merged.bytes,
    pages: merged.pages,
    sheets: merged.included.length - 1 - input.groups.length,
    skipped: merged.skipped,
  };
}
