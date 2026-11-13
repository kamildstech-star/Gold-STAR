/**
 * Equipment hour meters: what the dial said when the machine went in, what it
 * said when it came out, and the operating hours in between.
 *
 * Heshy Landau's checklist (1 Sep, via David). Days on site is what Gold Star
 * bills by (src/lib/equipment.ts `equipmentDaysOnSite`); hours RUN is what a
 * carrier's reviewer checks it against. A dehumidifier billed for five days
 * whose meter moved eleven hours was unplugged for four of them, and the only
 * defence of a rental line is a photo-grade record of both readings.
 *
 * Only machines that carry a meter are asked (HOUR_METER_TYPES). Air movers
 * are billed by the day and mostly have no meter, and a box on every air
 * mover in a twelve-fan setup is twelve boxes a crew learns to skip.
 *
 * Pure.
 */

export const HOUR_METER_TYPES: ReadonlySet<string> = new Set([
  "dehumidifier",
  "air_scrubber",
  "hepa",
  "heater",
  "generator",
]);

export function hasHourMeter(equipmentType: string | null | undefined): boolean {
  return !!equipmentType && HOUR_METER_TYPES.has(equipmentType);
}

/** A typed meter reading, or null. Blank, negative and not-a-number are null. */
export function parseHourMeter(text: string | null | undefined): number | null {
  const t = String(text ?? "").trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 10) / 10 : null;
}

export type HoursResult =
  | { kind: "hours"; hours: number }
  /** Still on the job: the start is known, the end is not yet. */
  | { kind: "running"; start: number }
  /** Either reading is missing, so there is nothing to bill from. */
  | { kind: "missing" }
  /** End below start — a replaced or rolled-over meter; needs a person. */
  | { kind: "backwards"; start: number; end: number };

export function operatingHours(
  start: number | null | undefined,
  end: number | null | undefined,
  retrieved: boolean,
): HoursResult {
  if (start == null) return { kind: "missing" };
  if (end == null) return retrieved ? { kind: "missing" } : { kind: "running", start };
  if (end < start) return { kind: "backwards", start, end };
  return { kind: "hours", hours: Math.round((end - start) * 10) / 10 };
}

/**
 * The end reading a crew is about to save, checked before it is: a number
 * below the start is refused by the database (it would bill negative hours),
 * so it is said on the pickup screen instead of failing in the sync list.
 */
export function checkEndReading(
  start: number | null | undefined,
  end: number | null,
): string | null {
  if (end == null || start == null) return null;
  return end < start
    ? `Below the ${start} h it read when it was placed. Check the dial — if the meter was replaced, leave this blank and say so in the placement note.`
    : null;
}

export type HourPlacement = {
  equipment_type: string | null | undefined;
  hour_meter_start: number | null | undefined;
  hour_meter_end: number | null | undefined;
  retrieved_at: string | null | undefined;
};

export type JobHoursTotal = {
  /** Operating hours across every placement with both readings. */
  hours: number;
  /** Placements the total is built from. */
  counted: number;
  /** Metered units still on the job (start read, end not yet). */
  running: number;
  /** Metered placements missing a reading they should have. */
  missing: number;
  /** End below start. */
  backwards: number;
};

/** The job's billing line: total hours and how complete the evidence is. */
export function jobHoursTotal(placements: HourPlacement[]): JobHoursTotal {
  const t: JobHoursTotal = { hours: 0, counted: 0, running: 0, missing: 0, backwards: 0 };
  for (const p of placements) {
    const metered = hasHourMeter(p.equipment_type);
    const res = operatingHours(p.hour_meter_start, p.hour_meter_end, !!p.retrieved_at);
    if (res.kind === "hours") {
      t.hours += res.hours;
      t.counted += 1;
    } else if (res.kind === "running") t.running += 1;
    else if (res.kind === "backwards") t.backwards += 1;
    // An unmetered machine with no readings is not missing anything.
    else if (metered) t.missing += 1;
  }
  t.hours = Math.round(t.hours * 10) / 10;
  return t;
}

export function describeHours(res: HoursResult): string {
  switch (res.kind) {
    case "hours":
      return `${res.hours} h run`;
    case "running":
      return `meter ${res.start} h at placement`;
    case "backwards":
      return `meter reads ${res.end} h, below ${res.start} h at placement`;
    default:
      return "no hour meter reading";
  }
}
