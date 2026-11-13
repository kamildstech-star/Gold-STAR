/**
 * The Scope-of-Work report David asked for on 12 Oct, as a PDF.
 *
 * Deliberately plain, one page for most jobs:
 *
 *   GOLD STAR RESTORATION
 *   SCOPE OF WORK                                   <date>
 *   Job <number> · <name>
 *   <address>
 *   ───────────────────────────────────────────────
 *   LIVING ROOM                 (one section per room that has scope)
 *   - demo drywall
 *   - flood cuts
 *   KITCHEN
 *   - remove cabinets
 *   ...
 *   footer: Gold Star Restoration · Scope of work · page n of m
 *
 * The rooms and lines come from `buildScopeOfWork`, so the PDF, the on-screen
 * card and the copied text can never disagree.
 */
import { drawBrandMark } from "@/lib/brand-logo";
import { GOLD, INK, MARGIN, MUTED, NAVY, CONTENT_W, Sheet, shortDate } from "@/lib/pdf-kit";
import type { RoomScope } from "@/lib/scope-of-work";

export type ScopeOfWorkJob = {
  job_number: string | null;
  job_name: string | null;
  customer_name: string | null;
  address: string | null;
};

export async function buildScopeOfWorkPdf(input: {
  job: ScopeOfWorkJob;
  scope: readonly RoomScope[];
  preparedAt?: Date;
}): Promise<{ bytes: Uint8Array; filename: string; title: string }> {
  const { job, scope } = input;
  const preparedAt = input.preparedAt ?? new Date();
  const sheet = await Sheet.create("internal");

  await drawBrandMark(sheet, MARGIN, 110, 28, () => {
    sheet.text("GOLD STAR RESTORATION", MARGIN, sheet.y - 12, { size: 9, bold: true, color: GOLD });
    sheet.y -= 40;
  });
  sheet.text("SCOPE OF WORK", MARGIN, sheet.y, { size: 22, bold: true, color: NAVY });
  sheet.text(shortDate(preparedAt.toISOString()), MARGIN, sheet.y + 2, {
    size: 9,
    color: MUTED,
    align: "right",
    width: CONTENT_W,
  });
  const jobLine = [
    job.job_number ? `Job ${job.job_number}` : null,
    job.job_name || job.customer_name,
  ]
    .filter(Boolean)
    .join(" - ");
  if (jobLine) {
    sheet.y -= 14;
    sheet.text(jobLine, MARGIN, sheet.y, { size: 10, color: INK });
  }
  if (job.address) {
    sheet.y -= 12;
    sheet.text(job.address, MARGIN, sheet.y, { size: 9, color: MUTED });
  }
  sheet.y -= 10;
  sheet.rule(NAVY, 1);

  if (scope.length === 0) {
    sheet.gap(8);
    sheet.para("No scope has been written on the job's rooms yet.", { size: 10, color: MUTED });
  }
  for (const room of scope) {
    sheet.sectionLabel(room.label);
    for (const item of room.items) {
      sheet.para(`-  ${item.text}`, { size: 10, leading: 14, x: MARGIN + 6, width: CONTENT_W - 6 });
    }
    sheet.gap(4);
  }

  sheet.stampFooters(["Gold Star Restoration", "Scope of work"]);

  const stem = (job.job_number || job.job_name || "job")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
  return {
    bytes: await sheet.save(),
    filename: `scope-of-work-${stem || "job"}.pdf`,
    title: `Scope of work - ${job.job_number ?? job.job_name ?? "job"}`,
  };
}
