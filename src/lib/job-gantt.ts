/**
 * Schedule maths for the job Gantt.
 *
 * Two decisions shape this file.
 *
 * 1. Everything is whole calendar days, held as integer day numbers. A
 *    placement stamped 9pm and a date-only crew assignment have to land on the
 *    same axis, and an hour of timezone drift must never push a bar into the
 *    next column.
 * 2. Only things that genuinely have a start AND an end become bars. A task
 *    carries a single `due_date`, which is a point, not a span — so the rows
 *    here are the job's own dates, crew assignments and equipment placements.
 *    On a drying job the gear standing on site is the schedule.
 */

const MS_PER_DAY = 86_400_000;

export type GanttKind = "job" | "crew" | "equipment";
export type GanttUnit = "day" | "week" | "month";

export const GANTT_KIND_LABEL: Record<GanttKind, string> = {
  job: "Job",
  crew: "Crew",
  equipment: "Equipment",
};

/** Row order on the chart: the job frames the crew, the crew places the gear. */
export const GANTT_KIND_ORDER: GanttKind[] = ["job", "crew", "equipment"];

/* ── day arithmetic ─────────────────────────────────────────────────────── */

/**
 * Calendar day of a date or a timestamp, as an integer day number.
 * Read in local time on purpose: an air mover placed at 9pm belongs to the day
 * the crew placed it, not to UTC's tomorrow.
 */
export function dayNumber(value: string | null | undefined): number | null {
  if (!value) return null;
  const d = new Date(value.length <= 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / MS_PER_DAY);
}

export function todayDayNumber(now: Date = new Date()): number {
  return Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / MS_PER_DAY);
}

/** Day number back to "YYYY-MM-DD", which is what `fmtDate` takes. */
export function dayToIso(day: number): string {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
}

/* Day numbers are UTC midnights, so every axis label is formatted in UTC too —
   otherwise a browser west of Greenwich renders the month a day early. */
function dayToUtcDate(day: number): Date {
  return new Date(day * MS_PER_DAY);
}

function fmtDay(day: number, opts: Intl.DateTimeFormatOptions): string {
  return dayToUtcDate(day).toLocaleDateString("en-US", { ...opts, timeZone: "UTC" });
}

function startOfMonth(day: number): number {
  const d = dayToUtcDate(day);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / MS_PER_DAY);
}

function addMonths(day: number, n: number): number {
  const d = dayToUtcDate(day);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1) / MS_PER_DAY);
}

function startOfYear(day: number): number {
  const d = dayToUtcDate(day);
  return Math.floor(Date.UTC(d.getUTCFullYear(), 0, 1) / MS_PER_DAY);
}

function addYears(day: number, n: number): number {
  const d = dayToUtcDate(day);
  return Math.floor(Date.UTC(d.getUTCFullYear() + n, 0, 1) / MS_PER_DAY);
}

/** Monday-anchored, matching how crews talk about a work week. */
function startOfWeek(day: number): number {
  const dow = (dayToUtcDate(day).getUTCDay() + 6) % 7;
  return day - dow;
}

/* ── bars ───────────────────────────────────────────────────────────────── */

export type GanttBar = {
  id: string;
  kind: GanttKind;
  label: string;
  sublabel: string | null;
  startDay: number;
  /** Inclusive. An open-ended item ends at today, not at nothing. */
  endDay: number;
  /** No recorded end — the bar runs to today and says so. */
  openEnded: boolean;
  /** Expected retrieval still in the future: drawn as a dashed projection. */
  projectedEndDay: number | null;
  /** Still out past the day it was expected back. */
  overdue: boolean;
  /** Plain-language explanation for the readout. */
  note: string;
};

export type GanttJob = {
  job_number: string;
  loss_date: string | null;
  call_date: string | null;
  start_date: string | null;
  completion_date: string | null;
};

export type GanttAssignment = {
  id: string;
  role: string;
  start_date: string | null;
  end_date: string | null;
  profiles: { full_name: string | null } | null;
};

export type GanttPlacement = {
  id: string;
  placed_at: string | null;
  retrieved_at: string | null;
  expected_retrieval_date: string | null;
  equipment: { asset_tag: string | null; equipment_type: string | null } | null;
};

export type BuildGanttInput = {
  job: GanttJob | null;
  crew: GanttAssignment[];
  placements: GanttPlacement[];
  today: number;
  /* Copy lives with the components that already own it, so it is passed in
     rather than duplicated here and left to drift. */
  roleLabel: (role: string) => string;
  equipmentLabel: (type: string | null) => string;
  personLabel: (profile: { full_name: string | null } | null) => string;
};

export type GanttBuild = {
  bars: GanttBar[];
  /** Rows we deliberately could not draw, so the UI can say so out loud. */
  undated: { crew: number; equipment: number };
};

export function buildGanttBars(input: BuildGanttInput): GanttBuild {
  const { job, crew, placements, today } = input;
  const bars: GanttBar[] = [];
  const undated = { crew: 0, equipment: 0 };

  if (job) {
    const lossDay = dayNumber(job.loss_date);
    const callDay = dayNumber(job.call_date);
    const startDay = dayNumber(job.start_date) ?? callDay ?? lossDay;
    const doneDay = dayNumber(job.completion_date);

    /* The gap between the loss and the day work started is the number every
       adjuster asks about, so it gets a bar rather than a footnote. */
    if (lossDay != null && startDay != null && lossDay < startDay) {
      const days = startDay - lossDay;
      bars.push({
        id: "job-response",
        kind: "job",
        label: "Loss → start",
        sublabel: `${days} day${days === 1 ? "" : "s"} to mobilize`,
        startDay: lossDay,
        endDay: startDay,
        openEnded: false,
        projectedEndDay: null,
        overdue: false,
        note: "Loss date through to the day work started.",
      });
    }

    if (startDay != null) {
      const openEnded = doneDay == null;
      bars.push({
        id: "job-span",
        kind: "job",
        label: `Job ${job.job_number}`,
        sublabel: openEnded ? "no completion date" : "start → completion",
        startDay,
        endDay: Math.max(startDay, doneDay ?? today),
        openEnded,
        projectedEndDay: null,
        overdue: false,
        note: openEnded
          ? "Still running — no completion date recorded yet."
          : "Job start through to completion.",
      });
    }
  }

  for (const a of crew) {
    const s = dayNumber(a.start_date);
    const e = dayNumber(a.end_date);
    if (s == null && e == null) {
      undated.crew += 1;
      continue;
    }
    const startDay = s ?? (e as number);
    const openEnded = e == null;
    const role = input.roleLabel(a.role);
    bars.push({
      id: `crew-${a.id}`,
      kind: "crew",
      label: input.personLabel(a.profiles),
      sublabel: openEnded ? `${role} · open` : role,
      startDay,
      endDay: Math.max(startDay, e ?? today),
      openEnded,
      projectedEndDay: null,
      overdue: false,
      note: openEnded
        ? "On the job with no end date — drawn running to today."
        : "Booked on the job for this window.",
    });
  }

  for (const p of placements) {
    const startDay = dayNumber(p.placed_at);
    if (startDay == null) {
      undated.equipment += 1;
      continue;
    }
    const retrievedDay = dayNumber(p.retrieved_at);
    const expectedDay = dayNumber(p.expected_retrieval_date);
    const stillOut = retrievedDay == null;
    const overdue = stillOut && expectedDay != null && expectedDay < today;
    const type = input.equipmentLabel(p.equipment?.equipment_type ?? null);

    bars.push({
      id: `equip-${p.id}`,
      kind: "equipment",
      label: p.equipment?.asset_tag?.trim() || "Unlabelled unit",
      sublabel: stillOut ? `${type} · still out` : type,
      startDay,
      endDay: Math.max(startDay, retrievedDay ?? today),
      openEnded: stillOut,
      /* Only a future expectation is a projection. A date already past is an
         overdue fact about the solid bar, not a guess about the future. */
      projectedEndDay: stillOut && expectedDay != null && expectedDay > today ? expectedDay : null,
      overdue,
      note:
        retrievedDay != null
          ? "Placed and picked back up."
          : overdue
            ? "Still on site — was expected back already."
            : expectedDay != null
              ? "Still on site — the dashed section is the expected pickup."
              : "Still on site, with no expected pickup date.",
    });
  }

  const rank = (b: GanttBar) => GANTT_KIND_ORDER.indexOf(b.kind);
  bars.sort(
    (a, b) => rank(a) - rank(b) || a.startDay - b.startDay || a.label.localeCompare(b.label),
  );
  return { bars, undated };
}

/* ── window + axis ──────────────────────────────────────────────────────── */

export type GanttTick = {
  key: string;
  /** Days from the window start. */
  offset: number;
  span: number;
  label: string;
};

export type GanttWindow = {
  startDay: number;
  endDay: number;
  totalDays: number;
  pxPerDay: number;
  unit: GanttUnit;
  /** Coarse band above the ticks: months, or years once the ticks are months. */
  bands: GanttTick[];
  ticks: GanttTick[];
  /** Days from the window start, or null when today sits off the axis. */
  todayOffset: number | null;
  trackWidth: number;
};

/* Aim the axis at this width and let density fall out of the data: a week-long
   job gets fat day columns, a four-month job thin ones under month ticks. */
const TARGET_TRACK_PX = 1000;
const MIN_PX_PER_DAY = 3;
const MAX_PX_PER_DAY = 38;
/** A one-day job still needs an axis you can read, so pad short windows out. */
const MIN_WINDOW_DAYS = 10;
/** How far off the data today may sit before we stop pulling it in. Keeps a
    job that finished in January from rendering seven empty months of runway. */
const TODAY_PULL_IN_DAYS = 30;

export function buildGanttWindow(bars: GanttBar[], today: number): GanttWindow | null {
  if (bars.length === 0) return null;

  let min = Infinity;
  let max = -Infinity;
  for (const b of bars) {
    min = Math.min(min, b.startDay);
    max = Math.max(max, b.endDay, b.projectedEndDay ?? b.endDay);
  }
  if (today >= min - TODAY_PULL_IN_DAYS && today <= max + TODAY_PULL_IN_DAYS) {
    min = Math.min(min, today);
    max = Math.max(max, today);
  }

  const pad = Math.min(14, Math.max(1, Math.round((max - min + 1) * 0.06)));
  const startDay = min - pad;
  let endDay = max + pad;
  if (endDay - startDay + 1 < MIN_WINDOW_DAYS) endDay = startDay + MIN_WINDOW_DAYS - 1;

  const totalDays = endDay - startDay + 1;
  const pxPerDay =
    Math.round(
      Math.min(MAX_PX_PER_DAY, Math.max(MIN_PX_PER_DAY, TARGET_TRACK_PX / totalDays)) * 100,
    ) / 100;
  const unit: GanttUnit = pxPerDay >= 20 ? "day" : pxPerDay >= 6 ? "week" : "month";

  const multiYear = fmtDay(startDay, { year: "numeric" }) !== fmtDay(endDay, { year: "numeric" });

  return {
    startDay,
    endDay,
    totalDays,
    pxPerDay,
    unit,
    bands:
      unit === "month"
        ? spans(startDay, endDay, startOfYear, addYears, (d) => fmtDay(d, { year: "numeric" }))
        : spans(startDay, endDay, startOfMonth, addMonths, (d) =>
            fmtDay(d, multiYear ? { month: "long", year: "numeric" } : { month: "long" }),
          ),
    ticks: buildTicks(startDay, endDay, unit),
    todayOffset: today >= startDay && today <= endDay ? today - startDay : null,
    trackWidth: Math.round(totalDays * pxPerDay),
  };
}

function buildTicks(startDay: number, endDay: number, unit: GanttUnit): GanttTick[] {
  if (unit === "day") {
    const out: GanttTick[] = [];
    for (let d = startDay; d <= endDay; d++) {
      out.push({
        key: `d${d}`,
        offset: d - startDay,
        span: 1,
        label: fmtDay(d, { day: "numeric" }),
      });
    }
    return out;
  }
  if (unit === "week") {
    return spans(
      startDay,
      endDay,
      startOfWeek,
      (d, n) => d + 7 * n,
      (d) => fmtDay(d, { month: "short", day: "numeric" }),
    );
  }
  return spans(startDay, endDay, startOfMonth, addMonths, (d) => fmtDay(d, { month: "short" }));
}

/**
 * Walk a window in calendar buckets. The first and last bucket get clipped to
 * the window but keep their own anchor, so a clipped month still reads as the
 * real month rather than as wherever the chart happened to begin.
 */
function spans(
  startDay: number,
  endDay: number,
  bucketStart: (day: number) => number,
  next: (day: number, n: number) => number,
  label: (anchor: number) => string,
): GanttTick[] {
  const out: GanttTick[] = [];
  let cursor = startDay;
  let guard = 0;
  while (cursor <= endDay && guard++ < 2000) {
    const anchor = bucketStart(cursor);
    const span = Math.min(next(anchor, 1) - 1, endDay) - cursor + 1;
    if (span <= 0) break;
    out.push({ key: `b${anchor}`, offset: cursor - startDay, span, label: label(anchor) });
    cursor += span;
  }
  return out;
}

export type GanttSegment = { column: number; span: number };

/** Where a bar sits on the grid, clipped to the window. Columns are 1-based. */
export function barPlacement(
  bar: GanttBar,
  win: GanttWindow,
): { solid: GanttSegment; projected: GanttSegment | null } {
  const start = Math.max(bar.startDay, win.startDay);
  const end = Math.min(bar.endDay, win.endDay);
  const solid = { column: start - win.startDay + 1, span: Math.max(1, end - start + 1) };

  if (bar.projectedEndDay == null) return { solid, projected: null };
  const pStart = Math.max(bar.endDay + 1, win.startDay);
  const pEnd = Math.min(bar.projectedEndDay, win.endDay);
  if (pEnd < pStart) return { solid, projected: null };
  return {
    solid,
    projected: { column: pStart - win.startDay + 1, span: Math.max(1, pEnd - pStart + 1) },
  };
}
