import type { DryingReading } from "@/lib/drying-log";
import { derive, isUsableReading } from "@/lib/psychrometrics";

/**
 * The psychrometrics grid: days across the top, outside and inside down the
 * side, every day typed in one sitting.
 *
 * The client, with Moisture Mapper's Psychrometrics screen on the monitor:
 * "it opens up like a chart or calendar type of view and you can put in all
 * days at one time ... versus right now you have to click each day separately
 * and it takes up a lot more room on the screen."
 *
 * Rows, in the order that screen reads: Outside °F, Outside %RH, Outside GPP,
 * Inside °F, Inside %RH, Inside GPP, Inside dew point, and the grain
 * difference between inside and outside. Only the four temperature / humidity
 * rows are typed; the rest are derived with the same `derive` every stored
 * reading uses, so the grid and the log can never disagree about a number.
 *
 * 11 Nov (client, on the grid): "these two will work repeatedly according to
 * room" — every room has its own Inside °F and Inside %RH rows, each saving
 * as that room's reading. A job with no rooms keeps the one property pair.
 *
 * SAVING NEVER EDITS. A changed cell becomes a NEW reading for that day, the
 * same thing the day form writes. The log already judges a day on its newest
 * reading, so the new figures take over while the old ones stay on the record
 * — a drying log with figures quietly overwritten is worth nothing as
 * evidence, and an upsert would also drop a meter photo the old row carried.
 */

export type GridPoint = "exterior" | "interior";
export const GRID_POINTS: GridPoint[] = ["exterior", "interior"];

/** Where a cell's figure came from, for how it is drawn and what its title says. */
export type GridCellSource = "manual" | "weather" | "room" | null;

export type GridCell = {
  tempF: number | null;
  rh: number | null;
  source: GridCellSource;
  /** Said on hover: "Automatic — Open-Meteo", "From the Kitchen reading". */
  note: string | null;
};

/**
 * One pair of typed rows: outside, or inside for one room (or for the whole
 * property when roomId is null). `key` addresses its drafts and cells.
 */
export type GridLine = {
  key: string;
  point: GridPoint;
  roomId: string | null;
  /** "Outside", "Kitchen", "Whole property". */
  label: string;
};

export const EXTERIOR_LINE: GridLine = {
  key: "exterior",
  point: "exterior",
  roomId: null,
  label: "Outside",
};

export const lineKey = (point: GridPoint, roomId: string | null) =>
  point === "exterior" ? "exterior" : `interior:${roomId ?? ""}`;

/**
 * The lines the grid shows: outside, then one inside line per room in the
 * job's room order. A job with no rooms has one inside line for the whole
 * property, as before. A job with rooms shows the whole-property line too
 * only while one of its days already holds such a reading, so nothing on
 * record disappears from the grid.
 */
export function gridLines(
  rooms: ReadonlyMap<string, string>,
  readings: readonly DryingReading[] = [],
  dates: readonly string[] = [],
): GridLine[] {
  const property: GridLine = {
    key: lineKey("interior", null),
    point: "interior",
    roomId: null,
    label: rooms.size ? "Whole property" : "Inside",
  };
  if (rooms.size === 0) return [EXTERIOR_LINE, property];
  const wanted = new Set(dates);
  const hasProperty = readings.some(
    (r) => r.point === "interior" && !r.room_id && wanted.has(r.reading_date),
  );
  return [
    EXTERIOR_LINE,
    ...[...rooms].map(([id, name]) => ({
      key: lineKey("interior", id),
      point: "interior" as const,
      roomId: id,
      label: name,
    })),
    ...(hasProperty ? [property] : []),
  ];
}

/** Each day's cell per line key. */
export type GridDay = Record<string, GridCell>;

const EMPTY: GridCell = { tempF: null, rh: null, source: null, note: null };

/** Newest first, the order the log judges a day by. */
function newestFirst(a: DryingReading, b: DryingReading): number {
  return (b.captured_at ?? "").localeCompare(a.captured_at ?? "");
}

/**
 * What each day already says, per line.
 *
 * Outside: a crew's own outside reading beats the automatic one, as it does
 * everywhere else in the log. Inside: each room's newest reading that day,
 * and the whole property's (no room) newest on its own line.
 */
export function gridDaysFromReadings(
  readings: readonly DryingReading[],
  dates: readonly string[],
  lines: readonly GridLine[] = gridLines(new Map(), readings, dates),
): Map<string, GridDay> {
  const out = new Map<string, GridDay>();
  const wanted = new Set(dates);
  const byDate = new Map<string, DryingReading[]>();
  for (const r of readings) {
    if (!wanted.has(r.reading_date)) continue;
    if (r.point !== "exterior" && r.point !== "interior") continue;
    const list = byDate.get(r.reading_date) ?? [];
    list.push(r);
    byDate.set(r.reading_date, list);
  }
  for (const date of dates) {
    const day = [...(byDate.get(date) ?? [])].sort(newestFirst);
    const ext = day.filter((r) => r.point === "exterior");
    const manual = ext.find((r) => r.source !== "weather");
    const auto = ext.find((r) => r.source === "weather");
    const ints = day.filter((r) => r.point === "interior");

    const cells: GridDay = {};
    for (const line of lines) {
      if (line.point === "exterior") {
        cells[line.key] = manual
          ? {
              tempF: manual.temperature_f,
              rh: manual.relative_humidity,
              source: "manual",
              note: null,
            }
          : auto
            ? {
                tempF: auto.temperature_f,
                rh: auto.relative_humidity,
                source: "weather",
                note: "Filled in automatically — type over it to use a crew reading",
              }
            : EMPTY;
        continue;
      }
      const r = ints.find((x) => (x.room_id ?? null) === line.roomId);
      cells[line.key] = r
        ? { tempF: r.temperature_f, rh: r.relative_humidity, source: "manual", note: null }
        : EMPTY;
    }
    out.set(date, cells);
  }
  return out;
}

/** "72.4", "55" — a stored figure as the box shows it. */
export function fmtGridNumber(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "";
  return String(Math.round(n * 10) / 10);
}

export function parseGridNumber(text: string | undefined): number | null {
  if (text == null) return null;
  const t = text.trim().replace(",", ".");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** What the boxes hold: typed text by `date|line|field`, absent where untouched. */
export type GridDrafts = Record<string, string>;
export type GridField = "temp" | "rh";

export const draftKey = (date: string, line: string, field: GridField) =>
  `${date}|${line}|${field}`;

/** The pair a cell shows: the typed text where there is some, else the stored figure. */
export function effectivePair(
  drafts: GridDrafts,
  date: string,
  line: string,
  cell: GridCell,
): { tempF: number | null; rh: number | null } {
  const t = drafts[draftKey(date, line, "temp")];
  const h = drafts[draftKey(date, line, "rh")];
  return {
    tempF: t !== undefined ? parseGridNumber(t) : cell.tempF,
    rh: h !== undefined ? parseGridNumber(h) : cell.rh,
  };
}

export type GridDerived = {
  outsideGpp: number | null;
  insideGpp: number | null;
  insideDewPoint: number | null;
  /** Inside GPP minus outside. Above zero the building holds more water than the air outside. */
  gppDifference: number | null;
};

export function deriveGridDay(
  outside: { tempF: number | null; rh: number | null },
  inside: { tempF: number | null; rh: number | null },
): GridDerived {
  const o = derive(outside.tempF, outside.rh);
  const i = derive(inside.tempF, inside.rh);
  return {
    outsideGpp: o.gpp,
    insideGpp: i.gpp,
    insideDewPoint: i.dewPointF,
    gppDifference: o.gpp != null && i.gpp != null ? Math.round((i.gpp - o.gpp) * 10) / 10 : null,
  };
}

export type GridSave = {
  date: string;
  point: GridPoint;
  /** The room an inside reading is for; null = outside, or the whole property. */
  roomId: string | null;
  temperatureF: number;
  relativeHumidity: number;
};

export type GridProblem = { date: string; line: string; message: string };

/**
 * Which cells become readings, and which cannot be saved as typed.
 *
 * A cell is saved only when something was typed in it AND the pair it now
 * shows differs from what the day already says — retyping the same figure, or
 * tabbing through an automatic one, writes nothing. Half a pair, or a humidity
 * outside 1–100%, is a problem, the same rule the day form applies.
 */
export function gridChanges(
  drafts: GridDrafts,
  days: ReadonlyMap<string, GridDay>,
  dates: readonly string[],
  lines: readonly GridLine[] = gridLines(new Map()),
): { saves: GridSave[]; problems: GridProblem[] } {
  const saves: GridSave[] = [];
  const problems: GridProblem[] = [];
  for (const date of dates) {
    const day = days.get(date);
    for (const line of lines) {
      const touched =
        drafts[draftKey(date, line.key, "temp")] !== undefined ||
        drafts[draftKey(date, line.key, "rh")] !== undefined;
      if (!touched) continue;
      const cell = day?.[line.key] ?? EMPTY;
      const pair = effectivePair(drafts, date, line.key, cell);
      if (pair.tempF == null && pair.rh == null) continue;
      if (!isUsableReading(pair.tempF, pair.rh)) {
        problems.push({
          date,
          line: line.key,
          message: "Needs both a temperature and a humidity between 1 and 100%.",
        });
        continue;
      }
      if (pair.tempF === cell.tempF && pair.rh === cell.rh) continue;
      saves.push({
        date,
        point: line.point,
        roomId: line.point === "interior" ? line.roomId : null,
        temperatureF: pair.tempF!,
        relativeHumidity: pair.rh!,
      });
    }
  }
  return { saves, problems };
}

/** "8/13" — the column heading, as the screen it replaces wrote it. */
export function gridDateLabel(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${Number(m)}/${Number(d)}`;
}
