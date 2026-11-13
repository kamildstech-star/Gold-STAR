/**
 * The daily update email: what happened on a job on one day, for the
 * customer, the property manager or the adjuster.
 *
 * David asked for it on 26 Oct (#60) and again on 3 Nov ("daily update
 * emails", with the mitigation letters and the drying report). It is built
 * from what the crew already recorded that day, nothing else:
 *
 *  - the field work ticket(s) for the day: the work done, who led the crew,
 *    whether the job is finished or the crew is coming back;
 *  - the drying log: outside and inside conditions by room, and how many
 *    moisture points have reached their dry standard;
 *  - the equipment on site that day.
 *
 * Not written by a model. The 22 Sep rule stands: a client-facing update is
 * a person's to send. This only lays the day's facts out as a draft; the
 * office reads it, edits it in the job's email window and presses Send. A
 * section with nothing recorded is left out rather than printed empty, and
 * nothing is guessed: no reading, no sentence about readings.
 *
 * Pure: the caller hands it the day's rows, so the test suite can build a
 * real update from fixtures.
 */
import { escapeHtml } from "@/lib/safe-html";
import { SCOPE_OPTIONS, type FieldWorkTicket } from "@/lib/field-work-ticket";
import type { DryingReportData } from "@/lib/drying-report";

export type DailyUpdateTicket = Pick<
  FieldWorkTicket,
  | "work_date"
  | "crew_chief_name"
  | "gsr_crew_size"
  | "temp_crew_size"
  | "scope_completed"
  | "work_notes"
  | "job_completed"
  | "more_work_needed"
>;

export type DailyUpdateInput = {
  /** Local `YYYY-MM-DD`: the day the update is about. */
  date: string;
  address: string | null;
  jobNumber: string | null;
  /** The person it is addressed to; "there" when unknown. */
  recipientName?: string | null;
  /** Every ticket on the job; only the day's are used. */
  tickets: readonly DailyUpdateTicket[];
  /** The drying report data cut to end on `date`; null when the job has no log. */
  drying: DryingReportData | null;
  company?: string;
};

export type DailyUpdate = {
  subject: string;
  /** Plain text, one paragraph per blank line. */
  text: string;
  /** The same, as simple HTML for the email editor. */
  html: string;
  /** Whether anything was recorded that day; false = nothing to report. */
  hasContent: boolean;
};

type Section = { heading: string; lines: string[] };

const SCOPE_LABEL = Object.fromEntries(SCOPE_OPTIONS.map((o) => [o.key, o.en]));

/** "Tuesday, November 10" — US style, no year (it is today's news). */
export function dailyUpdateDateLabel(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

const round = (n: number) => Math.round(n);

function listSentence(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The work section from the day's tickets. */
function workSection(tickets: readonly DailyUpdateTicket[]): Section | null {
  if (!tickets.length) return null;
  const lines: string[] = [];
  const scope = [
    ...new Set(tickets.flatMap((t) => t.scope_completed ?? []).map((k) => SCOPE_LABEL[k] ?? k)),
  ].filter(Boolean);
  if (scope.length)
    lines.push(`Work completed: ${listSentence(scope.map((s) => s.toLowerCase()))}.`);

  const chiefs = [...new Set(tickets.map((t) => t.crew_chief_name?.trim()).filter(Boolean))];
  const crew = tickets.reduce((n, t) => n + (t.gsr_crew_size ?? 0) + (t.temp_crew_size ?? 0), 0);
  if (chiefs.length || crew > 0) {
    const who = chiefs.length ? ` led by ${listSentence(chiefs as string[])}` : "";
    lines.push(crew > 0 ? `Our crew of ${crew} was on site${who}.` : `Our crew was on site${who}.`);
  }
  for (const t of tickets) {
    const note = t.work_notes?.trim();
    if (note) lines.push(note.endsWith(".") ? note : `${note}.`);
  }
  return lines.length ? { heading: "Work today", lines } : null;
}

function dayIndex(dates: readonly string[], date: string): number {
  return dates.lastIndexOf(date);
}

/** Outside, then each room's inside conditions, then the moisture points. */
function dryingSection(data: DryingReportData, date: string): Section | null {
  const lines: string[] = [];

  const oi = dayIndex(data.outside.dates, date);
  if (oi >= 0) {
    const t = data.outside.temperatureF[oi];
    const rh = data.outside.relativeHumidity[oi];
    if (t != null && rh != null)
      lines.push(`Outside: ${round(t)}°F, ${round(rh)}% relative humidity.`);
  }

  const roomLines: string[] = [];
  for (const area of data.areas) {
    for (const s of area.series) {
      if (s.series.point !== "interior" && s.series.point !== "affected") continue;
      const i = dayIndex(s.conditions.dates, date);
      if (i < 0) continue;
      const t = s.conditions.temperatureF[i];
      const rh = s.conditions.relativeHumidity[i];
      if (t == null || rh == null) continue;
      const gpp = s.conditions.gpp[i];
      const prev = i > 0 ? s.conditions.gpp[i - 1] : null;
      const trend =
        gpp != null && prev != null && prev > 0
          ? gpp < prev
            ? ", drier than yesterday"
            : gpp > prev
              ? ", more moisture in the air than yesterday"
              : ", unchanged from yesterday"
          : "";
      roomLines.push(`${area.title}: ${round(t)}°F, ${round(rh)}% relative humidity${trend}.`);
      break;
    }
  }
  if (roomLines.length) {
    lines.push("Inside, by room:");
    lines.push(...roomLines.map((l) => `• ${l}`));
  }

  // Materials: points measured that day (or earlier) against their standard.
  const points = (data.moisturePoints ?? []).filter((p) => !p.removed && p.latest);
  const withStandard = points.filter((p) => p.status === "dry" || p.status === "wet");
  if (withStandard.length) {
    const dry = withStandard.filter((p) => p.status === "dry").length;
    lines.push(
      dry === withStandard.length
        ? `All ${plural(withStandard.length, "moisture point")} we monitor have reached their dry standard.`
        : `${dry} of ${plural(withStandard.length, "moisture point")} we monitor have reached their dry standard; the rest are still drying.`,
    );
  }
  const removed = (data.moisturePoints ?? []).filter((p) => p.removed).length;
  if (removed) lines.push(`${plural(removed, "wet material")} removed rather than dried.`);

  return lines.length ? { heading: "Drying progress", lines } : null;
}

function equipmentSection(data: DryingReportData, date: string): Section | null {
  const i = dayIndex(data.equipment.dates, date);
  if (i < 0) return null;
  const parts = data.equipment.types
    .map((type) => {
      const n = data.equipment.counts[type]?.[i] ?? 0;
      const raw = type === "other" ? "other unit" : (data.equipment.labels[type] ?? type);
      // "HEPA" stays capitals; "Air mover" reads "air mover" mid-sentence.
      const label = raw === raw.toUpperCase() ? raw : raw.toLowerCase();
      return n > 0 ? plural(n, label) : null;
    })
    .filter((p): p is string => !!p);
  return parts.length ? { heading: "Equipment on site", lines: [`${listSentence(parts)}.`] } : null;
}

function nextStep(input: DailyUpdateInput, today: DailyUpdateTicket[]): string | null {
  if (today.some((t) => t.job_completed) && !today.some((t) => t.more_work_needed)) {
    return "The work on site is complete. We will be in touch about the next steps.";
  }
  if (today.some((t) => t.more_work_needed)) {
    return "More work is needed; our crew will be back to continue.";
  }
  const points = (input.drying?.moisturePoints ?? []).filter(
    (p) => !p.removed && (p.status === "dry" || p.status === "wet"),
  );
  if (points.length && points.every((p) => p.status === "dry")) {
    return "The materials we monitor are dry. We will schedule the equipment pickup.";
  }
  if (input.drying && equipmentSection(input.drying, input.date)) {
    return "We will keep monitoring daily until everything reaches its dry standard.";
  }
  return null;
}

export function buildDailyUpdate(input: DailyUpdateInput): DailyUpdate {
  const company = input.company ?? "Gold Star Restoration";
  const day = dailyUpdateDateLabel(input.date);
  const where =
    input.address?.trim() || (input.jobNumber ? `job ${input.jobNumber}` : "your property");
  const today = input.tickets.filter((t) => t.work_date === input.date);

  const sections = [
    workSection(today),
    input.drying ? dryingSection(input.drying, input.date) : null,
    input.drying ? equipmentSection(input.drying, input.date) : null,
  ].filter((s): s is Section => s != null);
  const next = nextStep(input, today);

  const subject = `Daily update: ${where}, ${day}`;
  const greeting = `Hello ${input.recipientName?.trim() || "there"},`;
  const intro = `Here is our update for ${where} on ${day}.`;
  const empty = "Nothing was recorded on site for this day.";
  const close = ["Please reply to this email with any questions.", "Thank you,", company];

  const textBlocks = [
    greeting,
    sections.length ? intro : `${intro} ${empty}`,
    ...sections.map((s) => [s.heading, ...s.lines].join("\n")),
    ...(next ? [`Next steps\n${next}`] : []),
    close.join("\n"),
  ];

  const p = (s: string) => `<p>${escapeHtml(s)}</p>`;
  // Lines in order; a run of "• " lines becomes one list.
  const sectionHtml = (s: Section) => {
    let out = `<p><strong>${escapeHtml(s.heading)}</strong></p>`;
    let list: string[] = [];
    const flush = () => {
      if (list.length) out += `<ul>${list.map((b) => `<li>${escapeHtml(b)}</li>`).join("")}</ul>`;
      list = [];
    };
    for (const l of s.lines) {
      if (l.startsWith("• ")) list.push(l.slice(2));
      else {
        flush();
        out += p(l);
      }
    }
    flush();
    return out;
  };
  const html = [
    p(greeting),
    p(sections.length ? intro : `${intro} ${empty}`),
    ...sections.map(sectionHtml),
    next ? `<p><strong>Next steps</strong></p>${p(next)}` : "",
    `<p>${close.map(escapeHtml).join("<br/>")}</p>`,
  ].join("");

  return { subject, text: textBlocks.join("\n\n"), html, hasContent: sections.length > 0 };
}
