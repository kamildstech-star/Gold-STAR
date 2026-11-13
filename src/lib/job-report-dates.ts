/**
 * Which days a job report covers (22 Oct): one day's field form, several
 * chosen days, or the full job.
 *
 * "Under the reports — I want to be able to select the date, so it pulls a
 * report of that day's field form, or select multiple days, or full job."
 *
 * The day-by-day parts of the snapshot are narrowed to the chosen days BEFORE
 * the model sees anything — the same rule as the section switches: data that
 * is not in the prompt cannot leak into the report. Job-level facts (who the
 * customer is, the loss, the carrier) stay; they are the context any report
 * needs. Pure, so every rule is tested without a database.
 */

export type ReportDates = { mode: "all" } | { mode: "days"; days: string[] };

export const ALL_DAYS: ReportDates = { mode: "all" };
/** More than this is a full-job report in all but name. */
export const MAX_REPORT_DAYS = 62;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Cleaned: real "YYYY-MM-DD" days, unique, oldest first; none left means the full job. */
export function normalizeReportDates(raw: unknown): ReportDates {
  const r = raw as Partial<{ mode: string; days: unknown }> | null | undefined;
  if (!r || r.mode !== "days" || !Array.isArray(r.days)) return ALL_DAYS;
  const days = [
    ...new Set(r.days.map(String).filter((d) => DAY_RE.test(d) && !Number.isNaN(Date.parse(d)))),
  ]
    .sort()
    .slice(-MAX_REPORT_DAYS);
  return days.length ? { mode: "days", days } : ALL_DAYS;
}

const fmt = (d: string, withYear = true) =>
  new Date(`${d}T12:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
  });

/** "Full job", "Oct 21, 2026", "Oct 20 – Oct 22, 2026" or "3 days: Oct 14, Oct 16, Oct 21, 2026". */
export function reportPeriodLabel(dates: ReportDates): string {
  if (dates.mode === "all") return "Full job";
  const d = dates.days;
  if (d.length === 0) return "No days chosen yet";
  if (d.length === 1) return fmt(d[0]!);
  const consecutive = d.every(
    (day, i) => i === 0 || Date.parse(day) - Date.parse(d[i - 1]!) === 86_400_000,
  );
  const sameYear = d[0]!.slice(0, 4) === d[d.length - 1]!.slice(0, 4);
  if (consecutive) return `${fmt(d[0]!, !sameYear)} – ${fmt(d[d.length - 1]!)}`;
  if (d.length <= 4)
    return `${d.length} days: ${d.map((x, i) => fmt(x, i === d.length - 1 || !sameYear)).join(", ")}`;
  return `${d.length} days, ${fmt(d[0]!, !sameYear)} – ${fmt(d[d.length - 1]!)}`;
}

/** The instruction that keeps the narrative to the chosen days. */
export function reportPeriodInstruction(dates: ReportDates): string {
  if (dates.mode === "all") return "";
  return `REPORT PERIOD: this report covers ${reportPeriodLabel(dates)} only. Describe the work on ${
    dates.days.length === 1 ? "that day" : "those days"
  }; do not describe other days of the job as if they were in this period. Name the period once, near the top.`;
}

/** The local calendar day of a timestamp or date string. */
const dayOf = (v: unknown): string | null => {
  if (typeof v !== "string" || !v) return null;
  if (DAY_RE.test(v)) return v;
  const t = new Date(v);
  if (Number.isNaN(t.getTime())) return null;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
};

type Snapshot = Record<string, unknown>;
type ByDay = {
  date: string;
  source?: string;
  hours: number | null;
  crew_size?: number | null;
  from_field_form?: boolean;
};

const sum = (xs: (number | null | undefined)[]) =>
  Math.round(xs.reduce<number>((s, x) => s + (Number(x) || 0), 0) * 100) / 100;

/**
 * The snapshot narrowed to the chosen days. Field forms, the crew's day-by-day
 * hours (and the totals recomputed from those days only), equipment that was
 * on site on any of the days, and notes written on them. A figure that cannot
 * be split by day (approved hours, who worked) is withheld rather than shown
 * as if it were the period's. Unchanged for the full job.
 */
export function scopeSnapshotToDays(snapshot: Snapshot, dates: ReportDates): Snapshot {
  if (dates.mode === "all")
    return { ...snapshot, report_period: { mode: "all", label: "Full job" } };
  const days = new Set(dates.days);
  const first = dates.days[0]!;
  const last = dates.days[dates.days.length - 1]!;
  const out: Snapshot = { ...snapshot };

  const forms = Array.isArray(snapshot.field_forms)
    ? (snapshot.field_forms as { work_date?: string }[])
    : [];
  out.field_forms = forms.filter((f) => !!f.work_date && days.has(f.work_date.slice(0, 10)));

  const crew = snapshot.crew as (Snapshot & { by_day?: ByDay[] }) | undefined;
  if (crew && Array.isArray(crew.by_day)) {
    const byDay = crew.by_day.filter((d) => days.has(String(d.date).slice(0, 10)));
    out.crew = {
      ...crew,
      by_day: byDay,
      total_hours: sum(byDay.map((d) => d.hours)),
      field_form_hours: sum(byDay.filter((d) => d.from_field_form).map((d) => d.hours)),
      time_clock_hours: sum(byDay.filter((d) => !d.from_field_form).map((d) => d.hours)),
      days_on_site: byDay.length,
      crew_days: byDay.reduce((s, d) => s + (Number(d.crew_size) || 0), 0),
      peak_crew: byDay.reduce((m, d) => Math.max(m, Number(d.crew_size) || 0), 0),
      entry_count: byDay.length,
      // Not split by day in the rollup: withheld rather than passed off as the period's.
      approved_hours: null,
      superseded_time_clock_hours: null,
      uncosted_hours: null,
      distinct_people: null,
      named_people: null,
      period_note: `Hours and crew are for ${reportPeriodLabel(dates)} only.`,
    };
  }

  // Equipment on site at any point during the chosen days.
  if (Array.isArray(snapshot.equipment)) {
    out.equipment = (
      snapshot.equipment as { placed_at?: string; retrieved_at?: string | null }[]
    ).filter((e) => {
      const placed = dayOf(e.placed_at);
      const retrieved = dayOf(e.retrieved_at ?? null);
      if (!placed || placed > last) return false;
      return !retrieved || retrieved >= first;
    });
  }

  if (Array.isArray(snapshot.notes)) {
    out.notes = (snapshot.notes as { created_at?: string }[]).filter((n) => {
      const d = dayOf(n.created_at);
      return !!d && days.has(d);
    });
  }

  out.report_period = { mode: "days", days: dates.days, label: reportPeriodLabel(dates) };
  return out;
}

/** The period a stored report covers, from its snapshot; "Full job" for older reports. */
export function snapshotPeriodLabel(snapshot: unknown): string {
  const p = (snapshot as { report_period?: { label?: string } } | null)?.report_period;
  return p?.label ?? "Full job";
}
