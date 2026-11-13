/**
 * Fixed material test points: is the STRUCTURE dry, not just the air?
 *
 * Heshy Landau's checklist (1 Sep, via David) asks for fixed points on the
 * structural materials — drywall, baseboard, subfloor, framing — each with a
 * Dry Standard, read every day until the standard is met. The air readings
 * already on the log prove a room is drying; these prove the wall is. An
 * adjuster who sees a dehumidifier billed for day six asks exactly one
 * question: was the drywall still wet on day five? This is the answer.
 *
 * FIXED is the point of it. The same spot on the same material, found again
 * tomorrow by whoever is on the job, so a falling number is the material
 * drying and not a tech who happened to press the meter somewhere drier.
 *
 * THE DRY STANDARD is the reading of the same material in an unaffected part
 * of the building — what dry means for this house, this season, this meter.
 * A point is DRY when its reading is within DRY_TOLERANCE of the standard.
 * S500 leaves the exact goal to the restorer; within 10% of the reference
 * (never less than one point, because a meter's last digit is noise) is the
 * common field convention, and it is one constant so Heshy can move it.
 * A point with no standard is never dry — it is "no standard yet" — because
 * the only alternative is guessing, and a guessed "dry" ends a drying job.
 *
 * Pure. Rows in, verdicts out; the timeline, the entry drawer and the summary
 * all read the same functions.
 */

export type MoistureMaterial = "drywall" | "baseboard" | "subfloor" | "framing" | "other";

export const MOISTURE_MATERIALS: { key: MoistureMaterial; en: string; es: string }[] = [
  { key: "drywall", en: "Drywall", es: "Tablaroca" },
  { key: "baseboard", en: "Baseboard", es: "Zócalo" },
  { key: "subfloor", en: "Subfloor", es: "Subpiso" },
  { key: "framing", en: "Framing", es: "Estructura de madera" },
  { key: "other", en: "Other", es: "Otro" },
];

export const MOISTURE_MATERIAL_LABEL: Record<string, string> = Object.fromEntries(
  MOISTURE_MATERIALS.map((m) => [m.key, m.en]),
);

/** Relative tolerance on the dry standard: within 10%. */
export const DRY_TOLERANCE_RATIO = 0.1;
/** ...but never tighter than one point on the meter. */
export const DRY_TOLERANCE_MIN = 1;

export type MoisturePoint = {
  id: string;
  job_id: string;
  room_id: string | null;
  material: string;
  location: string | null;
  dry_standard: number | null;
  removed_at: string | null;
  created_at: string;
};

export type MoistureReading = {
  id: string;
  point_id: string;
  job_id: string;
  reading_date: string;
  moisture_pct: number;
  captured_at: string;
};

/** The highest reading that still counts as dry, or null with no standard. */
export function dryGoal(standard: number | null | undefined): number | null {
  if (standard == null || !Number.isFinite(standard) || standard < 0) return null;
  const tolerance = Math.max(DRY_TOLERANCE_MIN, standard * DRY_TOLERANCE_RATIO);
  return Math.round((standard + tolerance) * 10) / 10;
}

export type MaterialStatus = "dry" | "wet" | "no_standard" | "no_reading";

/** One reading against one standard. */
export function materialStatus(
  reading: number | null | undefined,
  standard: number | null | undefined,
): MaterialStatus {
  const goal = dryGoal(standard);
  if (goal == null) return "no_standard";
  if (reading == null || !Number.isFinite(reading)) return "no_reading";
  return reading <= goal ? "dry" : "wet";
}

/**
 * How far from the first reading to the goal the latest one has come, 0–1.
 *
 * Null when there is nothing to measure against (no standard, one reading or
 * none), and 1 once dry. A material that got WETTER reads 0, not a negative —
 * the bar is "progress toward dry", and the wetter-than-day-one case is said
 * separately by the status staying "wet".
 */
export function progressToDry(
  first: number | null | undefined,
  latest: number | null | undefined,
  standard: number | null | undefined,
): number | null {
  const goal = dryGoal(standard);
  if (goal == null || first == null || latest == null) return null;
  if (latest <= goal) return 1;
  const span = first - goal;
  if (span <= 0) return null;
  return Math.max(0, Math.min(1, (first - latest) / span));
}

/** Parse a typed meter reading. Blank, negative or not a number is null. */
export function parseMoisturePct(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Local calendar date of a timestamp. Never the UTC slice. */
function localDate(ts: string): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export type PointSummary = {
  point: MoisturePoint;
  /** The point's readings, oldest first; one per day (the latest that day). */
  history: MoistureReading[];
  first: MoistureReading | null;
  latest: MoistureReading | null;
  status: MaterialStatus;
  progress: number | null;
  /** The first day a reading met the goal, or null. */
  metOn: string | null;
  /** Material cut out rather than dried; no longer asked for. */
  removed: boolean;
};

/** Latest reading per day, oldest day first. */
function dailyHistory(readings: MoistureReading[]): MoistureReading[] {
  const byDay = new Map<string, MoistureReading>();
  for (const r of readings) {
    const cur = byDay.get(r.reading_date);
    if (!cur || r.captured_at > cur.captured_at) byDay.set(r.reading_date, r);
  }
  return [...byDay.values()].sort((a, b) => a.reading_date.localeCompare(b.reading_date));
}

export function summarizePoint(point: MoisturePoint, readings: MoistureReading[]): PointSummary {
  const history = dailyHistory(readings.filter((r) => r.point_id === point.id));
  const first = history[0] ?? null;
  const latest = history[history.length - 1] ?? null;
  const goal = dryGoal(point.dry_standard);
  const met = goal == null ? null : history.find((r) => r.moisture_pct <= goal);
  return {
    point,
    history,
    first,
    latest,
    status: materialStatus(latest?.moisture_pct, point.dry_standard),
    progress: progressToDry(first?.moisture_pct, latest?.moisture_pct, point.dry_standard),
    metOn: met?.reading_date ?? null,
    removed: point.removed_at != null,
  };
}

export type MaterialsDay = {
  /** Points being dried on that day. */
  total: number;
  /** Of those, how many had met their standard by that day. */
  dry: number;
  /** Of those, how many were read ON that day. */
  read: number;
};

/**
 * The progress line for the daily timeline: on each date, how many fixed
 * points were in play and how many had reached dry by then.
 *
 * A point is in play from the day it was established (or its first reading,
 * if a queued point landed after its reading) until the day its material was
 * removed. "Dry by then" is the latest reading on or before that date — a day
 * nobody read the drywall still shows where it last stood, and the `read`
 * count is what shows the day was skipped.
 */
export function materialsByDay(
  points: MoisturePoint[],
  readings: MoistureReading[],
  dates: string[],
): Map<string, MaterialsDay> {
  const out = new Map<string, MaterialsDay>();
  const perPoint = points.map((p) => {
    const history = dailyHistory(readings.filter((r) => r.point_id === p.id));
    const createdOn = localDate(p.created_at);
    const firstRead = history[0]?.reading_date;
    const start = firstRead && firstRead < createdOn ? firstRead : createdOn;
    const end = p.removed_at ? localDate(p.removed_at) : null;
    return { p, history, start, end, goal: dryGoal(p.dry_standard) };
  });

  for (const date of dates) {
    let total = 0;
    let dry = 0;
    let read = 0;
    for (const x of perPoint) {
      if (date < x.start) continue;
      if (x.end && date >= x.end) continue;
      total += 1;
      let asOf: MoistureReading | null = null;
      for (const r of x.history) {
        if (r.reading_date > date) break;
        asOf = r;
        if (r.reading_date === date) read += 1;
      }
      if (asOf && x.goal != null && asOf.moisture_pct <= x.goal) dry += 1;
    }
    if (total > 0) out.set(date, { total, dry, read });
  }
  return out;
}
