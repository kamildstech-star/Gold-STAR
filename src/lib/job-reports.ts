/**
 * Job report client library.
 *
 * The generation itself lives in a server function. This file handles the part
 * that keeps the feature honest: the human review loop. A report is a draft
 * until somebody reads it, edits it and approves it; only then can it be
 * exported, attached to the job, or emailed.
 */
import { PDFDocument, StandardFonts, rgb, type PDFImage } from "pdf-lib";

import { supabase } from "@/integrations/supabase/client";
import { layoutPhotoGrid } from "@/lib/invoice-photo-grid";
import { loadInvoicePhotos } from "@/lib/invoice-photos";
import { signedPhotoUrl } from "@/lib/job-photos";
import { jpegForPdf } from "@/lib/photo-pdf";
import { DOCUMENT_BUCKET } from "@/lib/documents";
import {
  chosenSections,
  emptyReportReason,
  normalizeSections,
  sectionLabel,
  type ReportSectionKey,
  type ReportSections,
} from "@/lib/job-report-sections";
import type { Database } from "@/integrations/supabase/types";

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type JobReport = Database["public"]["Tables"]["job_reports"]["Row"];
export type JobReportType = Database["public"]["Enums"]["job_report_type"];

export const REPORT_TYPES: JobReportType[] = ["carrier_submission", "internal_review"];

export const REPORT_TYPE_LABEL: Record<JobReportType, string> = {
  carrier_submission: "Carrier submission",
  customer_update: "Customer update",
  internal_review: "Internal job review",
};

export const REPORT_TYPE_BLURB: Record<JobReportType, string> = {
  carrier_submission: "Written for an adjuster, from the sections you tick below and nothing else.",
  customer_update: "Retired. Client-facing updates are written by a person, never generated.",
  internal_review: "For a branch manager. Cost and margin may be included; never send it out.",
};

/**
 * The toast line when the template wrote a draft: why the AI did not. Each
 * entry is "<model>: <what the provider said>", straight from the server.
 */
export function templateReason(aiErrors: readonly string[] | null | undefined): string {
  const tail = "so the facts were written out plainly. Read and approve before sending.";
  const errors = (aiErrors ?? []).map((e) => e.trim()).filter(Boolean);
  if (errors.length === 0) return `No AI model is set up on the server, ${tail}`;
  const why = errors
    .slice(0, 2)
    .map((e) => (e.length > 120 ? `${e.slice(0, 119)}…` : e))
    .join(" · ");
  return `The AI could not write it (${why}), ${tail}`;
}

export function reportBody(r: JobReport): string {
  return r.edited_narrative ?? r.narrative ?? "";
}

export async function listJobReports(jobId: string): Promise<JobReport[]> {
  // A superseded report is one somebody cleared (FE7): kept, never listed.
  const { data, error } = await supabase
    .from("job_reports")
    .select("*")
    .eq("job_id", jobId)
    .neq("status", "superseded")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function saveReportEdit(id: string, text: string): Promise<void> {
  const { error } = await supabase
    .from("job_reports")
    .update({ edited_narrative: text })
    .eq("id", id);
  if (error) throw error;
}

/**
 * FE7, 28 Oct — "Clear generated data": the job's generated drafts leave the
 * Reports list so the next one starts fresh. Only drafts (never approved,
 * never sent) are touched, and they are marked superseded rather than
 * deleted, so nothing is lost and version numbers never repeat. Approved
 * reports, documents and every job record stay exactly as they are.
 * Returns how many drafts were cleared.
 */
export async function clearDraftReports(jobId: string): Promise<number> {
  const { data, error } = await supabase
    .from("job_reports")
    .update({ status: "superseded" })
    .eq("job_id", jobId)
    .eq("status", "draft")
    .select("id");
  if (error) throw error;
  return data?.length ?? 0;
}

export async function approveReport(id: string, userId: string): Promise<void> {
  const { error } = await supabase
    .from("job_reports")
    .update({ status: "approved", approved_by: userId, approved_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

/* ------------------------------------------------------------------ */
/* Traceability — the figures a reader can check the narrative against  */
/* ------------------------------------------------------------------ */

/**
 * `section` says which tick puts this figure on the paper. Before the report
 * was something you assemble, every figure printed on every report — which is
 * the "amount of photos... Invoices, this, I don't have to share with them"
 * the client was reading off the screen.
 */
export type SnapshotFigure = {
  label: string;
  value: string;
  source: string;
  section: ReportSectionKey;
};

type Snap = {
  job?: Record<string, unknown>;
  timeline?: Record<string, unknown>;
  crew?: Record<string, unknown>;
  equipment?: unknown[];
  drying?: {
    points_total?: number;
    points_at_goal?: number;
    crew_reading_days?: number;
  } | null;
  photos?: { total?: number };
  money?: Record<string, unknown>;
  invoices?: unknown[];
  estimates?: unknown[];
  missing?: string[];
};

const plain = (v: unknown) => (v == null || v === "" ? "Not recorded" : String(v));

/**
 * The labour block, with each figure's real source spelled out — and, where the
 * figure was never actually computed, an honest refusal instead of a zero.
 *
 * Every one of these used to be sourced to `time_entries.*`, which is exactly
 * what made a job documented on daily field forms read as zero. The source
 * string is now taken from the snapshot the report was generated against, so
 * an old report keeps saying what it actually came from and a new one says
 * "field_work_tickets".
 *
 * That fixed the attribution but not the number. A snapshot written before the
 * rollup existed carries zeros produced by a code path that could only read
 * `time_entries`, so a job worked entirely off daily field forms was stored as
 * `total_hours: 0`. Those zeros mean "nobody looked", not "nobody worked", and
 * this is a carrier- and customer-facing document: a bare 0 asserts that no
 * crew attended. Such a figure now reads "Not computed" and names the remedy.
 * A zero is printed only where the rollup genuinely read both the field forms
 * and the clock and had nothing to count.
 */
function labourFigures(c: Record<string, unknown>): SnapshotFigure[] {
  const source = (c["source"] as string | undefined) ?? null;
  // No `source` key at all: this snapshot pre-dates the field-form rollup.
  const predatesFieldForms = source == null;
  const table =
    source === "field_form"
      ? "field_work_tickets (crew size × hours)"
      : source === "both"
        ? "field_work_tickets, then time_entries where no form"
        : source === "time_clock"
          ? "time_entries.minutes"
          : predatesFieldForms
            ? // Pre-dates the field-form rollup: it can only have been the clock.
              "time_entries.minutes (before field forms fed this report)"
            : "no labor recorded";

  const STALE_SOURCE =
    "not computed — this report pre-dates daily field forms; regenerate it to count them";
  const EMPTY_SOURCE = "no daily field form and no time-clock entry against this job";

  /**
   * One labour figure. Zero-or-absent is the only value second-guessed: a
   * positive number was measured by whichever path wrote the snapshot, and is
   * reported as it stands.
   */
  const fig = (label: string, key: string, src: string): SnapshotFigure => {
    const v = c[key];
    const section = "labour" as const;
    if (v == null || v === "" || Number(v) === 0) {
      if (predatesFieldForms)
        return { label, value: "Not computed", source: STALE_SOURCE, section };
      if (source === "none") return { label, value: "Not recorded", source: EMPTY_SOURCE, section };
    }
    return { label, value: plain(v), source: src, section };
  };

  const out: SnapshotFigure[] = [
    fig("Man-hours on site", "total_hours", table),
    fig(
      "Hours approved",
      "approved_hours",
      predatesFieldForms
        ? "time_entries.status"
        : "field_ticket_crew_reviews.review_state / time_entries.status",
    ),
    fig(
      "Crew-days (person-days)",
      "crew_days",
      predatesFieldForms ? "time_entries.work_date" : "crew size summed per day",
    ),
  ];

  if (c["days_on_site"] != null) {
    out.push(fig("Days on site", "days_on_site", "distinct work dates"));
  }
  out.push(
    fig(
      "People on job",
      "distinct_people",
      predatesFieldForms
        ? "time_entries.user_id"
        : "largest crew on a field form, or named people on the clock",
    ),
  );

  // Only worth printing once both sources are actually in play.
  if (source === "both") {
    out.push(
      {
        label: "— from field forms",
        value: plain(c["field_form_hours"]),
        source: "field_work_tickets",
        section: "labour",
      },
      {
        label: "— from time clock",
        value: plain(c["time_clock_hours"]),
        source: "time_entries, on days with no field form",
        section: "labour",
      },
    );
  }
  if (Number(c["superseded_time_clock_hours"] ?? 0) > 0) {
    out.push({
      label: "Clock hours a form already covers",
      value: plain(c["superseded_time_clock_hours"]),
      source: "not added — the field form is the record for that day",
      section: "labour",
    });
  }
  return out;
}

/** Flattens the stored snapshot into the figures shown beside the narrative. */
export function snapshotFigures(snapshot: unknown): SnapshotFigure[] {
  const s = (snapshot ?? {}) as Snap;
  const j = s.job ?? {};
  const t = s.timeline ?? {};
  const c = s.crew ?? {};
  return [
    {
      label: "Date of loss",
      value: plain(j["loss_date"]),
      source: "jobs.loss_date",
      section: "timeline",
    },
    {
      label: "Started",
      value: plain(j["start_date"]),
      source: "jobs.start_date",
      section: "timeline",
    },
    {
      label: "Completed",
      value: plain(j["completion_date"]),
      source: "jobs.completion_date",
      section: "timeline",
    },
    {
      label: "Cycle time (days)",
      value: plain(t["cycle_time_days"]),
      source: "jobs.created_at → completion_date",
      section: "timeline",
    },
    ...labourFigures(c),
    {
      label: "Equipment placements",
      value: String((s.equipment ?? []).length),
      source: "equipment_placements",
      section: "equipment",
    },
    // Only on a snapshot that carries drying at all — reports made before the
    // section existed should not grow two "Not available" rows.
    ...(s.drying !== undefined
      ? ([
          {
            label: "Material points at dry goal",
            value: s.drying
              ? `${s.drying.points_at_goal ?? 0} of ${s.drying.points_total ?? 0}`
              : "Not available",
            source: "job_moisture_readings, latest reading vs dry goal",
            section: "drying",
          },
          {
            label: "Days with crew drying readings",
            value: s.drying ? String(s.drying.crew_reading_days ?? 0) : "Not available",
            source: "job_drying_readings (crew rows only, not weather)",
            section: "drying",
          },
        ] satisfies SnapshotFigure[])
      : []),
    /*
     * There is deliberately no "Photos: 8" figure here.
     *
     * David, 17 Sep, after downloading a report he had picked four photographs
     * for: the text told him "there are eight total in the system", which he
     * called irrelevant and wrong to surface. A report says what it CONTAINS.
     * How many other pictures happen to sit on the job is the app's business,
     * not the adjuster's.
     */
    /*
     * No Estimated / Billed / Approved / Collected / Shortfall figures either:
     * the "Amounts" section was removed so a client report never carries
     * amounts (David, 27 Oct).
     */
  ];
}

/**
 * The figures a report is actually allowed to print.
 *
 * `snapshotFigures` describes everything a snapshot could show; this is the
 * part the sender ticked. A report generated before this existed has no
 * `sections` recorded, and `normalizeSections` reads that as all-off — which
 * would blank the figures panel on every historical report. So an unassembled
 * report keeps its old behaviour and shows what it was built with, and only a
 * report that was composed is filtered. Rewriting the past is not the fix; the
 * client's complaint was about the next report, not the last one.
 */
export function figuresForSections(
  snapshot: unknown,
  sections: ReportSections | null,
): SnapshotFigure[] {
  const all = snapshotFigures(snapshot);
  if (!sections) return all;
  return all.filter((f) => sections[f.section]);
}

/**
 * What was ticked when this report was made, or null for one made before
 * reports were assembled by hand.
 */
export function reportSections(r: { sections?: unknown }): ReportSections | null {
  if (r.sections == null) return null;
  return normalizeSections(r.sections);
}

export function reportPhotoIds(r: { photo_ids?: string[] | null }): string[] {
  return r.photo_ids ?? [];
}

export function snapshotGaps(snapshot: unknown): string[] {
  return ((snapshot ?? {}) as Snap).missing ?? [];
}

/**
 * One sentence naming where the hours came from.
 *
 * A snapshot with no `source` was generated before field forms fed this at all.
 * It used to return null there, so the report said nothing and its zeros stood
 * unqualified; it now says plainly that the figures were read from the clock
 * alone and how to get the real ones.
 */
export function snapshotLabourNote(snapshot: unknown): string | null {
  const c = ((snapshot ?? {}) as Snap).crew ?? {};
  const note = c["source_note"];
  if (typeof note === "string" && note) return note;
  if (c["source"] == null && Object.keys(c).length > 0) {
    return "This report was generated before daily field forms fed the labor figures, so its crew numbers were read from the time clock alone and cannot speak for a job documented on field forms. Regenerate the report to count them.";
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

function wrap(text: string, font: ReturnType<typeof Object>, size: number, maxWidth: number) {
  const f = font as unknown as { widthOfTextAtSize: (t: string, s: number) => number };
  const out: string[] = [];
  for (const para of text.split(/\n/)) {
    if (!para.trim()) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of para.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (f.widthOfTextAtSize(next, size) > maxWidth && line) {
        out.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

type PreparedReportPhoto = { image: PDFImage; width: number; height: number };

/**
 * Fetch, downscale and embed the chosen photographs.
 *
 * Deliberately the invoice's own helpers: `loadInvoicePhotos` resolves the job
 * grid's ids — a ULID for an album picture, `doc:<uuid>` for one filed as a
 * document — and `jpegForPdf` handles the HEIC and the 12-megapixel phone
 * photograph that would otherwise bloat the file.
 *
 * Never throws. A picture that will not fetch or decode is counted so the page
 * can say so; one bad file must not cost the whole report.
 */
async function prepareReportPhotos(
  pdf: PDFDocument,
  jobId: string,
  ids: string[],
): Promise<{ items: PreparedReportPhoto[]; missing: number }> {
  if (ids.length === 0) return { items: [], missing: 0 };
  const set = await loadInvoicePhotos(jobId, ids);
  const items: PreparedReportPhoto[] = [];
  let missing = set.missing;
  for (const p of set.photos) {
    try {
      const url = await signedPhotoUrl(p.bucket, p.displayPath ?? p.originalPath);
      if (!url) throw new Error("no signed url");
      const res = await fetch(url);
      if (!res.ok) throw new Error(`storage ${res.status}`);
      const jpeg = await jpegForPdf(await res.blob(), p.originalPath.split("/").pop() || p.id);
      if (!jpeg.ok) {
        missing += 1;
        continue;
      }
      items.push({ image: await pdf.embedJpg(jpeg.jpeg), width: jpeg.width, height: jpeg.height });
    } catch {
      missing += 1;
    }
  }
  return { items, missing };
}

export async function buildReportPdf(
  report: JobReport,
  jobNumber: string,
  address: string,
): Promise<Uint8Array> {
  const sections = reportSections(report);
  /*
   * "A report with nothing in it should say so rather than generating an empty
   * PDF." A blank page handed to the office is indistinguishable from a broken
   * button, and it is the one outcome a start-from-empty design makes easy to
   * reach — so it refuses in words instead.
   */
  if (sections) {
    const why = emptyReportReason(sections, reportPhotoIds(report));
    if (why) throw new Error(why);
  }
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const navy = rgb(0.063, 0.141, 0.239);
  const grey = rgb(0.4, 0.4, 0.4);
  const gold = rgb(0.722, 0.627, 0.188); // #B8A030
  const M = 54;
  const W = 612 - M * 2;

  let page = pdf.addPage([612, 792]);
  let y = 792 - M;
  const line = (text: string, size = 10, f = font, color = rgb(0.1, 0.1, 0.1)) => {
    if (y < M + 40) {
      page = pdf.addPage([612, 792]);
      y = 792 - M;
    }
    page.drawText(text, { x: M, y, size, font: f, color });
    y -= size + 4;
  };

  page.drawText("1-877-95-WATER", { x: M + W - 92, y, size: 10, font: bold, color: navy });
  // The Gold Star logo (12 Nov); the name in type only when it cannot load.
  const { BRAND_LOGO, drawLogo, embedLogoSource } = await import("@/lib/brand-logo");
  const logo = await embedLogoSource(pdf, BRAND_LOGO);
  if (logo) {
    y -= drawLogo(page, logo, M, y + 10, 120) + 4;
  } else {
    line("GOLD STAR RESTORATION", 16, bold, navy);
  }
  line(REPORT_TYPE_LABEL[report.report_type], 11, font, grey);
  y -= 4;
  page.drawRectangle({ x: M, y, width: W, height: 3, color: gold });
  y -= 20;

  for (const [k, v] of [
    ["Job", jobNumber],
    ["Property", address],
    ["Version", `v${report.version}`],
    ["Status", report.status === "approved" ? "Approved" : "DRAFT — not for release"],
    ["Generated", new Date(report.created_at).toLocaleString("en-US")],
  ] as [string, string][]) {
    page.drawText(`${k}:`, { x: M, y, size: 9, font: bold, color: grey });
    page.drawText(v, { x: M + 70, y, size: 9, font, color: navy });
    y -= 14;
  }
  y -= 10;

  for (const l of wrap(reportBody(report), font, 10, W)) {
    if (!l) {
      y -= 6;
      continue;
    }
    line(l, 10);
  }

  /*
   * Only the figures behind the sections that were ticked. An assembled report
   * that says nothing about money must not carry the money block underneath it
   * — the block was most of what the client was pointing at.
   */
  /*
   * The figures, as a summary a person would put at the end of a report.
   *
   * David, 17 Sep, reading one of these: "I wanted it to look good and
   * professional and not that it's being pulled from somewhere else." He named
   * "underlying figures" as a phrase to go, and the parenthesised source after
   * every number — "(time_entries.minutes)" — was the same problem louder. The
   * numbers are the report's; where they were read from is Gold Star's
   * business and is no longer printed.
   */
  const figures = figuresForSections(report.snapshot, sections);
  if (figures.length > 0) {
    y -= 14;
    line("Summary", 11, bold, navy);
    for (const f of figures) {
      line(`${f.label}: ${f.value}`, 8, font, grey);
    }
  }

  /*
   * The photographs themselves.
   *
   * David, 17 Sep, picked four pictures, downloaded the PDF and found none of
   * them in it — the report said "4 photographs selected by hand for this
   * report" and stopped. A sentence about pictures is not pictures.
   *
   * Drawn with the same pipeline the invoice uses — loadInvoicePhotos,
   * jpegForPdf, layoutPhotoGrid — rather than a second one, so a photograph
   * lands on a report the way it already lands on an invoice. A picture that
   * will not fetch or decode is counted and said on the page; one bad file
   * must not cost the whole report.
   */
  const photoIds = reportPhotoIds(report);
  if ((!sections || sections.photos) && photoIds.length > 0) {
    const prepared = await prepareReportPhotos(pdf, report.job_id, photoIds);
    y -= 8;
    line("Photographs", 11, bold, navy);
    if (prepared.items.length > 0) {
      y -= 6;
      const grid = layoutPhotoGrid({
        count: prepared.items.length,
        x0: M,
        width: W,
        startY: y,
        pageTop: 792 - M,
        pageBottom: M,
      });
      const pages = [page];
      for (const cell of grid.cells) {
        while (pages.length <= cell.page) pages.push(pdf.addPage([612, 792]));
        const target = pages[cell.page]!;
        const it = prepared.items[cell.index]!;
        // Fitted, never cropped: the edge of a damage photograph is often the
        // point of it.
        const inner = cell.size - 2;
        const scale = Math.min(inner / it.width, inner / it.height);
        const dw = Math.max(1, it.width * scale);
        const dh = Math.max(1, it.height * scale);
        target.drawRectangle({
          x: cell.x,
          y: cell.y,
          width: cell.size,
          height: cell.size,
          borderColor: grey,
          borderWidth: 0.5,
        });
        target.drawImage(it.image, {
          x: cell.x + (cell.size - dw) / 2,
          y: cell.y + (cell.size - dh) / 2,
          width: dw,
          height: dh,
        });
      }
      page = pages[pages.length - 1]!;
      y = grid.endY;
    }
    if (prepared.missing > 0) {
      line(
        `${prepared.missing} photograph${prepared.missing === 1 ? "" : "s"} could not be included.`,
        8,
        font,
        grey,
      );
    }
  }

  const gaps = !sections || sections.gaps ? snapshotGaps(report.snapshot) : [];
  if (gaps.length > 0) {
    y -= 8;
    // "Not recorded" describes paperwork. This heading is about the property.
    line("Not applicable to this job", 11, bold, navy);
    for (const g of gaps) line(`• ${g}`, 8, font, grey);
  }

  return pdf.save();
}

/** One line naming what this report was assembled from, for the panel. */
export function reportContentsSummary(report: {
  sections?: unknown;
  photo_ids?: string[] | null;
}): string {
  const sections = reportSections(report);
  if (!sections) return "Generated before reports were assembled by hand — it carries everything.";
  const names = chosenSections(sections)
    .filter((k) => k !== "photos")
    .map(sectionLabel);
  const photos = reportPhotoIds(report).length;
  if (sections.photos && photos > 0) {
    names.push(`${photos} photo${photos === 1 ? "" : "s"}`);
  }
  return names.length === 0 ? "Nothing selected." : names.join(" · ");
}

/**
 * The name to put in the file-name box before anybody types.
 *
 * David, 17 Sep: the saved report was named after the preset he had picked —
 * "Carrier submission — initial job review" — and he wanted "a box that we can
 * type in whatever we want... what the file name should be called", naming
 * "Mitigation Report" off the job type as the kind of thing he meant.
 *
 * So the suggestion follows the LOSS, which is what a restoration report is
 * about, and falls back to the report's own kind when the job has no loss type
 * recorded. It is only ever a suggestion — the box is free text.
 */
const LOSS_REPORT_NAME: Record<string, string> = {
  water: "Mitigation Report",
  sewer: "Mitigation Report",
  storm: "Mitigation Report",
  fire: "Fire Damage Report",
  smoke: "Smoke Damage Report",
  mold: "Mold Remediation Report",
  biohazard: "Biohazard Remediation Report",
  cleaning: "Cleaning Report",
};

export function suggestedReportName(
  lossType: string | null | undefined,
  reportType: JobReportType,
): string {
  const byLoss = lossType ? LOSS_REPORT_NAME[lossType] : undefined;
  return byLoss ?? `${REPORT_TYPE_LABEL[reportType]} Report`;
}

/**
 * A typed name made safe for a file system, without second-guessing the words.
 *
 * Only the characters a path cannot carry are replaced. David types the name;
 * tidying his capitalisation or his spacing would be answering a question he
 * did not ask.
 */
export function reportFileName(name: string, fallback: string): string {
  const cleaned = (name || "")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  const base = cleaned || fallback;
  return base.toLowerCase().endsWith(".pdf") ? base : `${base}.pdf`;
}

/** Attaches an approved report to the job as a document, with its hash. */
export async function attachReportToJob(input: {
  report: JobReport;
  jobId: string;
  jobNumber: string;
  address: string;
  locationId: string | null;
  accountId: string | null;
  userId: string;
  /** What the sender typed in the name box. Falls back to the old wording. */
  documentName?: string | null;
}): Promise<string> {
  if (!input.locationId) {
    throw new Error("This job has no location, so the document cannot be filed.");
  }
  if (input.report.status !== "approved") {
    throw new Error("Approve the report before attaching it to the job.");
  }
  const bytes = await buildReportPdf(input.report, input.jobNumber, input.address);
  const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: "application/pdf" });
  const path = `${input.report.id}/report-v${input.report.version}.pdf`;

  const { data: doc, error: docErr } = await supabase
    .from("documents")
    .insert({
      location_id: input.locationId,
      job_id: input.jobId,
      account_id: input.accountId,
      doc_type: "job_report",
      // The typed name wins. Without one, the old preset-derived wording
      // stands, so nothing that already works changes shape.
      name:
        input.documentName?.trim() ||
        `${REPORT_TYPE_LABEL[input.report.report_type]} — ${input.jobNumber} (v${input.report.version})`,
      status: "signed",
      storage_bucket: DOCUMENT_BUCKET,
      storage_path: path,
      mime: "application/pdf",
      size_bytes: blob.size,
      content_hash: await sha256Hex(bytes),
      created_by: input.userId,
    })
    .select("id")
    .single();
  if (docErr) throw docErr;

  const up = await supabase.storage
    .from(DOCUMENT_BUCKET)
    .upload(path, blob, { contentType: "application/pdf", upsert: true });
  if (up.error) throw up.error;

  await supabase.from("job_reports").update({ document_id: doc.id }).eq("id", input.report.id);
  return doc.id;
}

export function downloadReportPdf(bytes: Uint8Array, filename: string) {
  const url = URL.createObjectURL(
    new Blob([bytes.slice().buffer as ArrayBuffer], { type: "application/pdf" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
