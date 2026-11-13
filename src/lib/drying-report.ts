/**
 * The drying report: the drying log laid out the way a carrier is used to
 * reading one — cover, outside conditions, equipment applied, then each area
 * (its room, its material moisture points, its inside conditions), then the
 * readings as tables.
 *
 * Mark, 2026-10-06, sending a MoistureMapper report for 5622 Delmare Blvd:
 * "there needs to be a way to run a report that can make something like this
 * for each job".
 *
 * ONE DATA ASSEMBLY, TWO FILES
 * The workbook an adjuster can be handed (drying-log-export.ts) already
 * decides which days the log covers, which days are gaps, what a modelled
 * figure is called and which reading a row is. The report does not decide any
 * of that again: its tables ARE the workbook's sheets, and its charts are drawn
 * from the same `buildDryingLog` calendar the workbook is built on, with the
 * same window. A carrier holding both files can never find a day on one that
 * the other disagrees about.
 *
 * WHAT IT MUST NOT DO — the same rules the workbook keeps, because it is the
 * same evidence in a different shape:
 *  - Draw a missing day as a zero. A day with no reading is `null` in every
 *    series here; the renderer draws it as a break, never as a dip to 0.
 *  - Pass a modelled outside figure off as a measurement. A crew's outside
 *    reading wins the day when there is one (the drying-day-grid rule); a day
 *    that only has the Open-Meteo figure is flagged `modelled` point by point.
 *  - Invent a floor plan or a moisture point. Gold Star records rooms with a
 *    length and width but not where they sit, so the schematic draws rooms to
 *    size, side by side, and says so. Moisture content is charted only where a
 *    crew established a fixed point.
 *
 * Pure: rows in, plain data out. drying-report-pdf.ts draws it.
 */
import { dryGoal, summarizePoint } from "@/lib/drying-materials";
import type { MoisturePoint, MoistureReading, PointSummary } from "@/lib/drying-materials";
import { EXPORT_MAX_DAYS, dryingLogWorkbook, type DryingLogSheets } from "@/lib/drying-log-export";
import {
  DEHU_POINTS,
  buildDryingLog,
  equipmentPickupDate,
  type DryingDay,
  type DryingLog,
  type DryingReading,
  type DryingSeries,
} from "@/lib/drying-log";
import { EQUIPMENT_TYPES, EQUIPMENT_TYPE_LABEL, officeDate } from "@/lib/equipment";
import type { JobRoom } from "@/lib/job-rooms";
import { grainsPerPound } from "@/lib/psychrometrics";

/** A placement as the report needs it. `listDryingPlacements` rows satisfy it. */
export type ReportPlacement = {
  id: string;
  room_id: string | null;
  placed_at: string;
  retrieved_at: string | null;
  equipment_type: string | null;
  asset_tag: string | null;
  hour_meter_start?: number | null;
  hour_meter_end?: number | null;
};

/** One value per calendar day. `null` is a day with no reading — never 0. */
export type DailyValues = (number | null)[];

/* ------------------------------------------------------------------ */
/* Grains per pound                                                    */
/* ------------------------------------------------------------------ */

/**
 * The reading's grains per pound. Stored on the row at write time by
 * psychrometrics.ts; a row from before that column was filled is derived here
 * with the same function, so the two can only differ by the stored rounding.
 */
export function readingGpp(r: {
  grains_per_pound: number | null;
  temperature_f: number | null;
  relative_humidity: number | null;
}): number | null {
  if (r.grains_per_pound != null && Number.isFinite(Number(r.grains_per_pound))) {
    return Number(r.grains_per_pound);
  }
  const g = grainsPerPound(r.temperature_f, r.relative_humidity);
  return g == null ? null : Math.round(g * 10) / 10;
}

/* ------------------------------------------------------------------ */
/* Days → chart series                                                 */
/* ------------------------------------------------------------------ */

/** The instant a reading is ordered by: the modelled hour, else when it was logged. */
function readingTime(r: DryingReading): string {
  return (r as { observed_at?: string | null }).observed_at ?? r.captured_at ?? "";
}

/**
 * The reading a day is judged on: the last one taken. The screen's table and
 * day squares apply the same rule (they read the newest row of the day); this
 * picks it by time rather than by trusting the input's order.
 */
export function lastOfDay(readings: readonly DryingReading[] | undefined): DryingReading | null {
  if (!readings || readings.length === 0) return null;
  let best = readings[0]!;
  for (const r of readings) if (readingTime(r) > readingTime(best)) best = r;
  return best;
}

export type ConditionsSeries = {
  /** Local `YYYY-MM-DD`, oldest first, one per calendar day — gaps included. */
  dates: string[];
  temperatureF: DailyValues;
  relativeHumidity: DailyValues;
  gpp: DailyValues;
  /** Per day: the figure came from the weather model, not a meter on site. */
  modelled: boolean[];
};

/**
 * Trim a calendar to the days between the first and the last that carry a
 * value. A log runs to the day it was exported, so a finished job printed a
 * month later would otherwise squash its whole drying curve into the left
 * fifth of every chart. Gaps BETWEEN readings are kept — those are findings.
 */
function trimToData<T>(
  dates: string[],
  has: (i: number) => boolean,
  cols: T[][],
): { dates: string[]; cols: T[][] } {
  let a = 0;
  let b = dates.length - 1;
  while (a <= b && !has(a)) a += 1;
  while (b >= a && !has(b)) b -= 1;
  if (a > b) return { dates: [], cols: cols.map(() => []) };
  return { dates: dates.slice(a, b + 1), cols: cols.map((c) => c.slice(a, b + 1)) };
}

/**
 * Temperature, RH and GPP per day for a set of series, oldest first.
 *
 * `crewKeys` are tried before `modelledKeys`: a technician with a meter beats
 * a grid model on the same day, and a day that only has the model's number is
 * marked so the chart can say so. Within a group the last reading of the day
 * wins.
 */
export function conditionsSeries(
  days: readonly DryingDay[],
  crewKeys: readonly string[],
  modelledKeys: readonly string[] = [],
): ConditionsSeries {
  const ordered = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const dates: string[] = [];
  const t: DailyValues = [];
  const rh: DailyValues = [];
  const g: DailyValues = [];
  const m: boolean[] = [];
  const pick = (d: DryingDay, keys: readonly string[]) =>
    lastOfDay(keys.flatMap((k) => d.bySeries[k] ?? []));
  for (const d of ordered) {
    const crew = pick(d, crewKeys);
    const r = crew ?? pick(d, modelledKeys);
    dates.push(d.date);
    t.push(r?.temperature_f ?? null);
    rh.push(r?.relative_humidity ?? null);
    g.push(r ? readingGpp(r) : null);
    m.push(!crew && r != null);
  }
  const trimmed = trimToData<number | null | boolean>(dates, (i) => t[i] != null || rh[i] != null, [
    t,
    rh,
    g,
    m,
  ]);
  return {
    dates: trimmed.dates,
    temperatureF: trimmed.cols[0] as DailyValues,
    relativeHumidity: trimmed.cols[1] as DailyValues,
    gpp: trimmed.cols[2] as DailyValues,
    modelled: trimmed.cols[3] as boolean[],
  };
}

/** The outside series: every crew exterior series first, the modelled one behind it. */
export function outsideConditions(log: DryingLog): ConditionsSeries {
  const exterior = log.series.filter((s) => s.point === "exterior");
  const modelled = exterior.filter((s) => s.key.endsWith("|auto")).map((s) => s.key);
  const crew = exterior.filter((s) => !s.key.endsWith("|auto")).map((s) => s.key);
  return conditionsSeries(log.days, crew, modelled);
}

/** Every calendar day from `from` to `to` inclusive. DST-proof (UTC noon steps). */
export function calendarDays(from: string, to: string, max = EXPORT_MAX_DAYS): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T12:00:00Z`);
  for (let i = 0; i < max; i += 1) {
    const s = d.toISOString().slice(0, 10);
    if (s > to) break;
    out.push(s);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Equipment on site per day                                           */
/* ------------------------------------------------------------------ */

export type EquipmentByDay = {
  dates: string[];
  /** Types present, air movers and dehumidifiers first (the catalogue's order). */
  types: string[];
  labels: Record<string, string>;
  /** type → units on site each day. Zero is a real count here: nothing was on site. */
  counts: Record<string, number[]>;
};

/**
 * Units on site by type, per day, from the placements.
 *
 * A unit counts on every calendar day from the day it was placed to the day it
 * was retrieved, both inclusive, in the office's time zone — the rule the
 * running cost bills by (`equipmentDaysOnSite`, `job_running_cost`), so the
 * chart can never show a machine on a day it was not billed, or the reverse.
 *
 * Its range is the equipment's own: first drop to the last retrieval, or to
 * `today` while anything is still out. Unlike a missing reading, a day with no
 * equipment IS zero units — so this is the one series where 0 is drawn.
 */
export function equipmentByDay(
  placements: readonly ReportPlacement[],
  today: string,
): EquipmentByDay {
  const spans: { type: string; from: string; to: string }[] = [];
  for (const p of placements) {
    if (!p.placed_at || !Number.isFinite(new Date(p.placed_at).getTime())) continue;
    const from = officeDate(p.placed_at);
    const retrieved =
      p.retrieved_at && Number.isFinite(new Date(p.retrieved_at).getTime())
        ? officeDate(p.retrieved_at)
        : null;
    const to = retrieved ?? (today > from ? today : from);
    spans.push({ type: p.equipment_type || "other", from, to: to < from ? from : to });
  }
  if (spans.length === 0) return { dates: [], types: [], labels: {}, counts: {} };

  const first = spans.reduce((m, s) => (s.from < m ? s.from : m), spans[0]!.from);
  const last = spans.reduce((m, s) => (s.to > m ? s.to : m), spans[0]!.to);
  const dates = calendarDays(first, last);
  const present = new Set(spans.map((s) => s.type));
  const rank = (t: string) => {
    const i = EQUIPMENT_TYPES.indexOf(t);
    return i < 0 ? EQUIPMENT_TYPES.length : i;
  };
  const types = [...present].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const counts: Record<string, number[]> = Object.fromEntries(
    types.map((t) => [t, dates.map(() => 0)]),
  );
  for (const s of spans) {
    dates.forEach((d, i) => {
      if (d >= s.from && d <= s.to) counts[s.type]![i]! += 1;
    });
  }
  const labels = Object.fromEntries(types.map((t) => [t, EQUIPMENT_TYPE_LABEL[t] ?? t]));
  return { dates, types, labels, counts };
}

/* ------------------------------------------------------------------ */
/* Areas                                                               */
/* ------------------------------------------------------------------ */

export const UNASSIGNED_AREA_KEY = "unassigned";
export const UNASSIGNED_AREA_TITLE = "Readings not tied to a room";

/** Points whose series belong to a place inside the building. */
const AREA_POINTS: ReadonlySet<string> = new Set(["interior", "affected", "unaffected"]);

export type MoistureChart = {
  dates: string[];
  lines: {
    pointId: string;
    name: string;
    values: DailyValues;
    /** Highest reading that still counts as dry, or null with no standard. */
    goal: number | null;
    standard: number | null;
  }[];
};

export type ReportArea = {
  key: string;
  title: string;
  room: JobRoom | null;
  /** Inside / affected / unaffected series measured in this area. */
  series: { series: DryingSeries; conditions: ConditionsSeries }[];
  moisture: PointSummary[];
  moistureChart: MoistureChart | null;
  placements: ReportPlacement[];
};

/** "Drywall, north wall 12 in up" — how a point is named in a legend or table. */
export function moisturePointName(p: MoisturePoint, materialLabel: Record<string, string>): string {
  const material = materialLabel[p.material] ?? p.material;
  const where = p.location?.trim();
  return where ? `${material}, ${where}` : material;
}

/**
 * One line per fixed point across the area's days, oldest first. A day the
 * point was not read is null — the chart breaks there rather than pretending
 * the wall was read and came out at zero.
 */
export function moistureChart(
  summaries: readonly PointSummary[],
  materialLabel: Record<string, string>,
): MoistureChart | null {
  const withReadings = summaries.filter((s) => s.history.length > 0);
  if (withReadings.length === 0) return null;
  const all = withReadings.flatMap((s) => s.history.map((h) => h.reading_date)).sort();
  const dates = calendarDays(all[0]!, all[all.length - 1]!);
  return {
    dates,
    lines: withReadings.map((s) => {
      const byDay = new Map(s.history.map((h) => [h.reading_date, h.moisture_pct]));
      return {
        pointId: s.point.id,
        name: moisturePointName(s.point, materialLabel),
        values: dates.map((d) => byDay.get(d) ?? null),
        goal: dryGoal(s.point.dry_standard),
        standard: s.point.dry_standard,
      };
    }),
  };
}

/**
 * The areas the report walks through, in the Rooms tab's order, with the
 * readings that could not be tied to a room last.
 *
 * A room is an area when something was measured or placed in it: an inside or
 * affected series, a fixed moisture point, or a piece of equipment. A room
 * with none of those is still drawn on every schematic — it is part of the
 * building — but gets no pages of its own, because a page that says "nothing
 * here" three times is noise to an adjuster.
 *
 * A series or point whose room is no longer on the job (deleted after the
 * reading) falls to the unassigned area instead of vanishing: the reading was
 * taken, and the report keeps it.
 */
export function groupAreas(input: {
  log: DryingLog;
  rooms: readonly JobRoom[];
  placements: readonly ReportPlacement[];
  moisture: { points: MoisturePoint[]; readings: MoistureReading[] } | null;
  materialLabel: Record<string, string>;
  roomLabel: (r: JobRoom) => string;
}): ReportArea[] {
  const known = new Set(input.rooms.map((r) => r.id));
  const areaOf = (roomId: string | null | undefined) =>
    roomId && known.has(roomId) ? roomId : UNASSIGNED_AREA_KEY;

  const seriesBy = new Map<string, DryingSeries[]>();
  for (const s of input.log.series) {
    if (!AREA_POINTS.has(s.point) || DEHU_POINTS.has(s.point)) continue;
    const k = areaOf(s.roomId);
    seriesBy.set(k, [...(seriesBy.get(k) ?? []), s]);
  }

  const pointsBy = new Map<string, PointSummary[]>();
  for (const p of input.moisture?.points ?? []) {
    const k = areaOf(p.room_id);
    const summary = summarizePoint(p, input.moisture!.readings);
    pointsBy.set(k, [...(pointsBy.get(k) ?? []), summary]);
  }

  const placementsBy = new Map<string, ReportPlacement[]>();
  for (const p of input.placements) {
    if (!p.room_id || !known.has(p.room_id)) continue;
    placementsBy.set(p.room_id, [...(placementsBy.get(p.room_id) ?? []), p]);
  }

  const build = (key: string, room: JobRoom | null): ReportArea | null => {
    const series = seriesBy.get(key) ?? [];
    const moisture = pointsBy.get(key) ?? [];
    const placements = placementsBy.get(key) ?? [];
    if (series.length === 0 && moisture.length === 0 && placements.length === 0) return null;
    return {
      key,
      title: room ? input.roomLabel(room) : UNASSIGNED_AREA_TITLE,
      room,
      series: series.map((s) => ({
        series: s,
        conditions: conditionsSeries(input.log.days, [s.key]),
      })),
      moisture,
      moistureChart: moistureChart(moisture, input.materialLabel),
      placements,
    };
  };

  const out: ReportArea[] = [];
  for (const room of input.rooms) {
    const a = build(room.id, room);
    if (a) out.push(a);
  }
  const rest = build(UNASSIGNED_AREA_KEY, null);
  if (rest) out.push(rest);
  return out;
}

/* ------------------------------------------------------------------ */
/* Room schematic                                                      */
/* ------------------------------------------------------------------ */

export type SchematicRect = {
  roomId: string;
  label: string;
  floor: string | null;
  /** "12' x 10'" or null when the room has no length and width recorded. */
  dims: string | null;
  /** Points, from the box's top-left corner, y growing downwards. */
  x: number;
  y: number;
  w: number;
  h: number;
};

export type SchematicLayout = {
  rects: SchematicRect[];
  /** Floor headings and where to print them (same coordinate frame). */
  floors: { label: string; x: number; y: number }[];
  /** Points per foot the sized rooms were drawn at; null when none had a size. */
  scale: number | null;
};

const FLOOR_HEADING_H = 12;
const GUTTER = 6;
/** A room with no recorded size is drawn as this square, dashed, and says so. */
const UNSIZED_FT = 10;
/** Below this a label cannot be read, so a tiny closet is drawn at least this big. */
const MIN_BOX = 26;

function feet(n: number): string {
  const whole = Math.floor(n);
  const inches = Math.round((n - whole) * 12);
  if (inches === 0) return `${whole}'`;
  if (inches === 12) return `${whole + 1}'`;
  return `${whole}' ${inches}"`;
}

/**
 * Rooms as rectangles drawn to their recorded length and width, packed in
 * rows, one band per floor.
 *
 * WHY NOT A FLOOR PLAN. Gold Star records each room's size but not where it
 * sits in the building, and the Xactimate Sketch drawing is proprietary and
 * never comes through an ESX import. Drawing rooms next to each other in the
 * shape of a plan would be inventing walls. So the schematic is honest about
 * what it is — sizes, not positions — and the PDF prints that sentence under
 * it. When Field Capture records openings and positions, this is the function
 * that grows into a plan.
 *
 * The scale is the largest one at which every room fits the box; it is found
 * by bisection because packing is not monotonic enough to solve directly.
 */
export function schematicLayout(
  rooms: readonly Pick<JobRoom, "id" | "name" | "unit" | "floor" | "length_ft" | "width_ft">[],
  box: { width: number; height: number },
  roomLabel: (r: Pick<JobRoom, "unit" | "name">) => string,
): SchematicLayout {
  if (rooms.length === 0) return { rects: [], floors: [], scale: null };
  const sized = (r: (typeof rooms)[number]) =>
    r.length_ft != null && r.width_ft != null && r.length_ft > 0 && r.width_ft > 0;
  const anySized = rooms.some(sized);

  // Floors in first-seen order; rooms keep the Rooms tab's order inside them.
  const floorOrder: (string | null)[] = [];
  for (const r of rooms) {
    const f = r.floor?.trim() || null;
    if (!floorOrder.includes(f)) floorOrder.push(f);
  }
  const showFloors = floorOrder.length > 1 || floorOrder[0] != null;

  const pack = (scale: number, overflow = false): SchematicLayout | null => {
    const rects: SchematicRect[] = [];
    const floors: SchematicLayout["floors"] = [];
    let y = 0;
    for (const f of floorOrder) {
      if (showFloors) {
        floors.push({ label: f ?? "Floor not recorded", x: 0, y });
        y += FLOOR_HEADING_H;
      }
      let x = 0;
      let rowH = 0;
      for (const r of rooms.filter((r) => (r.floor?.trim() || null) === f)) {
        const long = sized(r) ? Math.max(r.length_ft!, r.width_ft!) : UNSIZED_FT;
        const short = sized(r) ? Math.min(r.length_ft!, r.width_ft!) : UNSIZED_FT;
        const w = Math.max(MIN_BOX * 1.4, long * scale);
        const h = Math.max(MIN_BOX, short * scale);
        if (w > box.width && !overflow) return null;
        if (x > 0 && x + w > box.width) {
          x = 0;
          y += rowH + GUTTER;
          rowH = 0;
        }
        rects.push({
          roomId: r.id,
          label: roomLabel(r),
          floor: r.floor?.trim() || null,
          dims: sized(r) ? `${feet(r.length_ft!)} x ${feet(r.width_ft!)}` : null,
          x,
          y,
          w,
          h,
        });
        x += w + GUTTER;
        rowH = Math.max(rowH, h);
      }
      y += rowH + GUTTER;
    }
    if (y - GUTTER > box.height && !overflow) return null;
    return { rects, floors, scale: anySized ? scale : null };
  };

  let lo = 0.25;
  let hi = 40;
  let best = pack(lo);
  if (!best) {
    // Too many rooms for the box even at the smallest scale: draw them at the
    // minimum size anyway and let the box overflow downward rather than drop
    // a room from the drawing.
    return pack(0, true)!;
  }
  for (let i = 0; i < 24; i += 1) {
    const mid = (lo + hi) / 2;
    const fit = pack(mid);
    if (fit) {
      best = fit;
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return best;
}

/** Equipment placed in each room during the job, by type. */
export function equipmentByRoom(
  placements: readonly ReportPlacement[],
): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const p of placements) {
    if (!p.room_id) continue;
    const m = out.get(p.room_id) ?? new Map<string, number>();
    const t = p.equipment_type || "other";
    m.set(t, (m.get(t) ?? 0) + 1);
    out.set(p.room_id, m);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* The whole report                                                    */
/* ------------------------------------------------------------------ */

export type DryingReportInput = {
  rows: DryingReading[];
  rooms: JobRoom[];
  roomLabel: (r: JobRoom) => string;
  placements: ReportPlacement[];
  /** Null when the moisture-point tables are not in this database yet. */
  moisture: { points: MoisturePoint[]; readings: MoistureReading[] } | null;
  materialLabel: Record<string, string>;
  jobNumber?: string | null;
  address?: string | null;
  /** Local `YYYY-MM-DD`. Required: a report pinned to a date must not read the clock. */
  today: string;
  /** The zone observation times are printed in; the workbook's rule. */
  timeZone: string;
};

export type DryingReportData = {
  /** The workbook's customer sheets, verbatim: Summary, Readings. */
  sheets: DryingLogSheets;
  log: DryingLog;
  outside: ConditionsSeries;
  equipment: EquipmentByDay;
  areas: ReportArea[];
  rooms: JobRoom[];
  roomLabel: (r: JobRoom) => string;
  placements: ReportPlacement[];
  /** Null = the moisture tables are not migrated; [] = migrated, nothing recorded. */
  moisturePoints: PointSummary[] | null;
  jobNumber: string | null;
  address: string | null;
  today: string;
  timeZone: string;
};

export function buildDryingReportData(input: DryingReportInput): DryingReportData {
  const roomNames = new Map(input.rooms.map((r) => [r.id, input.roomLabel(r)]));
  const endDate = equipmentPickupDate(input.placements);
  const sheets = dryingLogWorkbook({
    rows: input.rows,
    roomNames,
    jobNumber: input.jobNumber,
    address: input.address,
    today: input.today,
    timeZone: input.timeZone,
    endDate,
  });
  // The workbook's own calendar: same rows, same rooms, same window.
  const log = buildDryingLog(input.rows, {
    today: input.today,
    roomNames,
    maxDays: EXPORT_MAX_DAYS,
    endDate,
  });
  return {
    sheets,
    log,
    outside: outsideConditions(log),
    equipment: equipmentByDay(input.placements, input.today),
    areas: groupAreas({
      log,
      rooms: input.rooms,
      placements: input.placements,
      moisture: input.moisture,
      materialLabel: input.materialLabel,
      roomLabel: input.roomLabel,
    }),
    rooms: input.rooms,
    roomLabel: input.roomLabel,
    placements: input.placements,
    moisturePoints: input.moisture
      ? input.moisture.points.map((p) => summarizePoint(p, input.moisture!.readings))
      : null,
    jobNumber: input.jobNumber ?? null,
    address: input.address ?? null,
    today: input.today,
    timeZone: input.timeZone,
  };
}

/** `drying-report-<job>-<yyyy-mm-dd>.pdf` */
export function dryingReportFilename(jobNumber: string | null | undefined, today: string): string {
  const job = (jobNumber ?? "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return job ? `drying-report-${job}-${today}.pdf` : `drying-report-${today}.pdf`;
}

/**
 * The report cut to a date range (28 Oct: "Please add date selection to dry
 * log report"). Inclusive `YYYY-MM-DD` bounds; either may be null.
 *
 *  - Readings and moisture readings outside the range are dropped, so the
 *    calendar starts at the first reading in it.
 *  - Equipment placed before the range starts on its first day; equipment
 *    still out, or picked up after the range, is treated as still running at
 *    its end — the report stops at the last day asked for, not at pickup.
 *  - `today` becomes the range's end when that is earlier, so nothing after
 *    it is drawn.
 */
export function windowDryingReport<
  R extends { reading_date: string },
  M extends { reading_date: string },
>(
  input: {
    rows: R[];
    placements: ReportPlacement[];
    moisture: { points: MoisturePoint[]; readings: M[] } | null;
    today: string;
  },
  from: string | null,
  to: string | null,
): {
  rows: R[];
  placements: ReportPlacement[];
  moisture: { points: MoisturePoint[]; readings: M[] } | null;
  today: string;
} {
  if (!from && !to) return input;
  const inRange = (d: string) => (!from || d >= from) && (!to || d <= to);
  // Noon UTC is the same calendar day in every US zone.
  const noon = (d: string) => `${d}T12:00:00Z`;
  const placements: ReportPlacement[] = [];
  for (const p of input.placements) {
    const placed = officeDate(p.placed_at);
    const back = p.retrieved_at ? officeDate(p.retrieved_at) : null;
    if (to && placed > to) continue;
    if (from && back && back < from) continue;
    placements.push({
      ...p,
      placed_at: from && placed < from ? noon(from) : p.placed_at,
      retrieved_at: to && (!back || back > to) ? null : p.retrieved_at,
    });
  }
  return {
    rows: input.rows.filter((r) => inRange(r.reading_date)),
    placements,
    moisture: input.moisture
      ? {
          ...input.moisture,
          readings: input.moisture.readings.filter((r) => inRange(r.reading_date)),
        }
      : null,
    today: to && to < input.today ? to : input.today,
  };
}
