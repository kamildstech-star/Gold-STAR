/**
 * What goes into a job report — chosen, not collected.
 *
 * David, on a generated report: "That's pulling random information... I don't
 * need all this information in here... we should have a report section here
 * that's blank. And you manually have to choose what updates you want to put
 * in, meaning the updates from today's field form, the updates, today's
 * updated pictures, or select the updated pictures that you want to put in
 * instead of just giving me this all this jibber... amount of photos, you
 * know, here's the photos attached... Invoices, this, I don't have to share
 * with them... It's talking too much irrelevant stuff."
 *
 * So the report starts EMPTY. `EMPTY_REPORT_SECTIONS` is every section off,
 * and it is the only default there is: a report is assembled by ticking, and a
 * tick is the only thing that puts anything on the paper. That matters beyond
 * tidiness — this document goes to a homeowner or an adjuster, so a section
 * that arrives switched on by itself is a leak, not noise. The test file next
 * to this one pins that: nothing internal can be included by default.
 *
 * This is the job-report half of the print-option idea that
 * `src/lib/report-filters.ts` already carries for estimates and invoices, and
 * it deliberately reuses that file's shapes — `PrintOptionDef` with its
 * `finance` flag, a defs array that drives the dialog, and the internal-only
 * rule enforced once in `src/lib/document-audience.ts` rather than in each
 * builder. The two differ in one respect only, and it is the client's point: a
 * printed estimate has a sensible standard layout to default to, a job report
 * has none.
 */
import type { PrintOptionDef } from "@/lib/report-filters";

/**
 * One block of a report. Ordering here is the order it is written and printed
 * in, so the list reads top-down as the document does.
 *
 * `narrative` is not a member: the written prose IS the report. These are the
 * things the prose is allowed to be about, and the figures printed under it.
 */
export type ReportSectionKey =
  | "fieldForm"
  | "photos"
  | "timeline"
  | "labour"
  | "equipment"
  | "drying"
  | "notes"
  | "documents"
  /*
   * "photoSummary" is deliberately absent. It printed how many photographs
   * exist on the job, which David called irrelevant on 17 Sep after a report
   * told him "there are eight total in the system" for a selection of four.
   *
   * Removed from the union too, not just the catalogue: normalizeSections
   * builds from REPORT_SECTION_KEYS, so a report saved with the old key parses
   * fine and simply drops it.
   */
  | "invoices"
  | "gaps";

export type ReportSections = Record<ReportSectionKey, boolean>;

export type ReportSectionDef = PrintOptionDef<ReportSectionKey> & {
  /**
   * The keys of `gatherJobSnapshot()`'s output this section is allowed to see.
   * `narrowSnapshot` keeps only these, so an unticked section is not something
   * the model was asked to leave out — it is something the model was never
   * shown.
   */
  snapshotKeys: readonly string[];
  /**
   * Which column of the picker this sits in.
   *
   * The panel used to print all eleven as one vertical list, which David found
   * a long scroll to get through before he could generate anything. Grouping is
   * a property of the section rather than of the panel so the two orders cannot
   * drift, and so a section added later lands somewhere deliberate.
   */
  group: ReportSectionGroup;
};

/** The four columns, in the order they are shown. */
export const REPORT_SECTION_GROUPS = ["On site", "Pictures", "The record", "Money"] as const;
export type ReportSectionGroup = (typeof REPORT_SECTION_GROUPS)[number];

/**
 * The catalogue. Every entry names the snapshot keys it unlocks, because the
 * defence against "talking too much irrelevant stuff" is not a prompt line
 * asking nicely; it is that the data is not in the prompt at all.
 */
export const REPORT_SECTION_DEFS: readonly ReportSectionDef[] = [
  {
    key: "fieldForm",
    group: "On site",
    label: "Field form updates",
    hint: "Scope completed, materials used and crew notes from the daily field forms.",
    snapshotKeys: ["field_forms"],
  },
  {
    key: "photos",
    group: "Pictures",
    label: "Selected photos",
    hint: "Only the pictures you tick below. Nothing is attached until you choose it.",
    // Deliberately no snapshot key: the pictures are chosen by hand and listed
    // on the report, and their filenames are not something the model narrates.
    snapshotKeys: [],
  },
  {
    key: "timeline",
    group: "The record",
    label: "Dates & timeline",
    hint: "Date of loss, start, completion, and the status history between them.",
    snapshotKeys: ["timeline"],
  },
  {
    key: "labour",
    group: "On site",
    label: "Crew & hours",
    hint: "Man-hours on site, crew-days and how many people worked the job.",
    snapshotKeys: ["crew"],
  },
  {
    key: "equipment",
    group: "On site",
    label: "Equipment on site",
    hint: "What was placed or left on site, when, and what has not come back yet.",
    /*
     * Both records of the same machines. `equipment` is what was scanned into
     * a placement; `equipment_from_field_forms` is what a crew wrote on the
     * daily sheet, which for a job whose machines were never asset-tagged is
     * the only record there is. Without the second key the section could not
     * mention equipment left on site however the brief was worded.
     */
    snapshotKeys: ["equipment", "equipment_from_field_forms"],
  },
  {
    /*
     * Mark, 13 Oct: the report should say how the drying went: readings
     * against each material's dry goal and the day it was met. Crew readings
     * only (job-report-drying.ts). An automatic outside figure is never handed
     * to the writer, so it cannot be narrated as a measurement taken on site.
     */
    key: "drying",
    group: "On site",
    label: "Drying progress",
    hint: "Moisture readings against each material's dry goal, and the day each goal was met.",
    snapshotKeys: ["drying"],
  },
  {
    key: "notes",
    group: "The record",
    label: "Job notes",
    hint: "Notes written on the job record by the office and the crew.",
    snapshotKeys: ["notes"],
  },
  {
    key: "documents",
    group: "The record",
    label: "Documents on file",
    hint: "Names and status of the paperwork filed against this job.",
    snapshotKeys: ["documents"],
  },
  /*
   * "Photo counts by room" is gone from the pickable sections.
   *
   * David, 17 Sep, reading a report he had chosen four photographs for: it told
   * him "there are eight total in the system", which he called irrelevant and
   * wrong to surface. The section existed to print exactly that count, so there
   * was nothing in it to fix. The pictures he picks are now IN the PDF instead.
   *
   * The key stays in the union below so a report saved before today still
   * parses; it simply is not offered and prints nothing.
   */
  /*
   * "Amounts" is gone from the pickable sections (David, 27 Oct): a client
   * report must never carry amounts, so there is no tick that can put them on
   * the paper. A report saved with the old "money" key still parses — the key
   * is simply not in the catalogue, so normalizeSections drops it.
   */
  {
    key: "invoices",
    group: "Money",
    label: "Invoice detail",
    hint: "Invoice numbers, dates, balances and payments. Internal — never send to a customer.",
    finance: true,
    snapshotKeys: ["invoices", "payments"],
  },
  {
    key: "gaps",
    group: "The record",
    label: "What this job has no record of",
    hint: "The list of missing data. Useful to an adjuster, embarrassing to a homeowner.",
    snapshotKeys: ["missing"],
  },
];

export const REPORT_SECTION_KEYS: readonly ReportSectionKey[] = REPORT_SECTION_DEFS.map(
  (d) => d.key,
);

/**
 * Nothing selected. Built from the catalogue rather than written out, so a
 * section added above cannot arrive switched on because someone forgot a line.
 */
export const EMPTY_REPORT_SECTIONS: ReportSections = Object.freeze(
  Object.fromEntries(REPORT_SECTION_KEYS.map((k) => [k, false])) as ReportSections,
);

/** A fresh, all-off selection. Callers mutate their own copy. */
export function emptySections(): ReportSections {
  return { ...EMPTY_REPORT_SECTIONS };
}

/**
 * Reads a `job_reports.sections` value back into a selection.
 *
 * Anything unrecognised is dropped and anything absent is OFF — the column is
 * jsonb written by an older build, by a newer one, or not at all, and in every
 * one of those cases the safe reading of "no opinion recorded" is "do not
 * include it".
 */
export function normalizeSections(value: unknown): ReportSections {
  const out = emptySections();
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  const raw = value as Record<string, unknown>;
  for (const key of REPORT_SECTION_KEYS) {
    if (raw[key] === true) out[key] = true;
  }
  return out;
}

/**
 * What to pre-tick when composing the next report on this job.
 *
 * "So they are not re-ticking the same boxes daily": a job in progress gets a
 * report most days and it is the same three or four sections every time. The
 * memory is per JOB rather than per user or per browser, because the shape of
 * the update belongs to the job — a water loss under drying reports the field
 * form and pictures; a job in the middle of a carrier dispute reports dates.
 *
 * Reports arrive newest-first from `listJobReports`. The first one that
 * actually recorded a selection wins; reports older than this feature recorded
 * none, and on a job that only has those the answer is the blank start, which
 * is the client's stated default anyway.
 */
export function lastUsedSections(reports: readonly { sections?: unknown }[]): ReportSections {
  for (const r of reports) {
    if (r.sections == null) continue;
    const s = normalizeSections(r.sections);
    if (chosenSections(s).length > 0) return s;
  }
  return emptySections();
}

/** The ticked sections, in catalogue order. */
export function chosenSections(sections: ReportSections): ReportSectionKey[] {
  return REPORT_SECTION_KEYS.filter((k) => sections[k]);
}

export function sectionLabel(key: ReportSectionKey): string {
  return REPORT_SECTION_DEFS.find((d) => d.key === key)?.label ?? key;
}

/**
 * Why this report cannot be produced yet, or null when it can.
 *
 * An empty selection is the starting state, not a mistake, so it must say so
 * in words at every point it could otherwise produce a blank page — the button
 * that is off, the server that refuses, and the PDF builder. One sentence,
 * one place, so the three never tell the office three different stories.
 */
export function emptyReportReason(
  sections: ReportSections,
  photoIds: readonly string[] = [],
): string | null {
  const chosen = chosenSections(sections);
  if (chosen.length > 0 && !(chosen.length === 1 && chosen[0] === "photos")) return null;
  if (sections.photos && photoIds.length > 0) return null;
  if (sections.photos) {
    return "Photos are ticked but none are selected. Choose the pictures to include, or add another section.";
  }
  return "Nothing has been chosen for this report yet. Tick what to include — the field form, photos, dates — and it will be written from those alone.";
}

export function isEmptyReport(sections: ReportSections, photoIds: readonly string[] = []): boolean {
  return emptyReportReason(sections, photoIds) != null;
}

/**
 * The snapshot cut down to what was ticked.
 *
 * `job` and `generated_at` always survive: a report has to be able to name the
 * job it is about, and those carry no figure the client objected to. Everything
 * else is gone unless a ticked section named it — including the `missing`
 * array, which is honest but is exactly the "this is mentioned that I have
 * highlighted here" the client does not want going out by default.
 *
 * This runs AFTER the role-based redaction in `generateJobReport`, never
 * instead of it. It can only remove.
 */
export const ALWAYS_IN_SNAPSHOT = ["generated_at", "job"] as const;

export function narrowSnapshot(
  snapshot: Record<string, unknown>,
  sections: ReportSections,
): Record<string, unknown> {
  const allowed = new Set<string>(ALWAYS_IN_SNAPSHOT);
  for (const def of REPORT_SECTION_DEFS) {
    if (!sections[def.key]) continue;
    for (const k of def.snapshotKeys) allowed.add(k);
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(snapshot)) {
    if (allowed.has(k)) out[k] = v;
  }
  return out;
}

/**
 * The instruction given to the model, assembled from the ticks.
 *
 * Named sections and nothing else, then said again as a prohibition, because
 * the failure this feature exists to fix was a report that volunteered
 * invoices and photo counts nobody asked for.
 */
export function sectionBrief(sections: ReportSections): string {
  const chosen = chosenSections(sections).filter((k) => k !== "photos");
  const lines = chosen.map((k) => `- ${sectionLabel(k)}: ${SECTION_BRIEF[k]}`);
  const photos = sections.photos
    ? "\nA set of photographs chosen by hand is attached to this report. You may refer to them as attached photographs. Do not count them, describe them, or state how many exist on the job."
    : "";
  return (
    `COVER ONLY THESE SUBJECTS AND NOTHING ELSE (the REPORT OUTLINE sets the order):\n${lines.join("\n")}\n` +
    `Write nothing about any other subject. Do not mention money, invoices, photo counts, ` +
    `document lists, equipment, drying readings, crew hours or missing data unless it is named above — the ` +
    `sender chose these sections deliberately and everything else is withheld on purpose.${photos}`
  );
}

const SECTION_BRIEF: Record<ReportSectionKey, string> = {
  fieldForm:
    "the work done on site — scope completed, materials used, and what the crew noted. " +
    "Write it as the work, never as a form: no 'the field form recorded'.",
  photos: "the attached photographs.",
  timeline: "the dates and the sequence of status changes between them.",
  labour: "man-hours on site, crew-days and people. Never name where the hours came from.",
  equipment:
    "equipment placed or left on site, how long it was there, anything not yet retrieved, and " +
    "any note written against a machine. A machine with no asset tag is still a machine: say " +
    "what was left and on which date, without naming where that came from.",
  drying:
    "how the drying went: each material's first and latest reading against its dry goal, " +
    "and the day the goal was met. Crew measurements only; never describe outside weather.",
  notes: "what was noted about the job.",
  documents: "the paperwork for this job and where each item stands.",
  invoices: "the invoices raised and what has been paid against them.",
  gaps: "what this job does not have yet, stated plainly as a fact about the job.",
};
