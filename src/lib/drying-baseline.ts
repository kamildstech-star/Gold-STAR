/**
 * The baseline set — what the property read before anything was dried.
 *
 * From the 2026-09-04 call with Melly Chein: a set of readings is taken when
 * the job starts or the equipment is dropped, which "should really be the same
 * time", and every later day is read against it. Without it a drying log is a
 * column of numbers; with it, it is a claim — "the affected chamber was 71 °F
 * dew point on the day we set the dehus and it is 58 today" is the sentence a
 * carrier pays equipment days for.
 *
 * Two ways a day becomes the baseline, in this order:
 *
 *  1. A crew ticked "this is the baseline set" when they logged it, which
 *     writes `is_baseline` on those rows. This is the real answer.
 *  2. Nothing is flagged, so the FIRST day with a crew reading is used and the
 *     set is marked `declared: false`. Every surface that shows an inferred
 *     baseline has to say it was inferred — a log where the first visit was
 *     three days after the equipment went in has a baseline that flatters the
 *     job, and quietly presenting it as the starting condition would overstate
 *     the drying.
 *
 * `is_baseline` ships in a migration that is not applied yet (see
 * supabase/MIGRATION_RECONCILIATION.md), so rule 2 is not a fallback for an
 * empty log — it is the working path until that migration lands, and the code
 * must read the same either way.
 *
 * Everything here is pure. It takes rows and returns numbers.
 */
import { DRYING_POINTS, type DryingPoint, type DryingReading } from "./drying-log";

/** One measured point as it stood on the baseline day. */
export type BaselinePointReading = {
  point: DryingPoint;
  label: string | null;
  roomId: string | null;
  temperatureF: number;
  relativeHumidity: number;
  dewPointF: number | null;
  gpp: number | null;
  /** 'manual' for a meter, 'weather' for the modelled exterior figure. */
  source: string;
};

export type BaselineSet = {
  date: string;
  /**
   * True when a crew flagged the day as the baseline. False when it was
   * inferred as the first logged day — which every caller must surface.
   */
  declared: boolean;
  points: BaselinePointReading[];
};

/** Which way a point has moved since the baseline. */
export type BaselineVerdict = "drying" | "wetter" | "flat" | "unknown";

export type BaselineDelta = {
  point: DryingPoint;
  baselineDewPointF: number | null;
  currentDewPointF: number | null;
  /** Current minus baseline. Negative is drying. Null when either is missing. */
  deltaF: number | null;
  baselineGpp: number | null;
  currentGpp: number | null;
  deltaGpp: number | null;
  verdict: BaselineVerdict;
};

/**
 * How far a dew point has to move before it counts as movement. A field
 * thermo-hygrometer is good to about ±1 °F on dew point, so anything smaller
 * than that is the instrument, not the structure, and calling it progress is
 * how a log ends up claiming a day of drying that did not happen.
 */
export const BASELINE_TOLERANCE_F = 1;

const POINT_ORDER = DRYING_POINTS.map((p) => p.key);

function pointRank(point: string): number {
  const i = POINT_ORDER.indexOf(point as DryingPoint);
  return i === -1 ? POINT_ORDER.length : i;
}

function toBaselinePoint(r: DryingReading): BaselinePointReading {
  return {
    point: r.point as DryingPoint,
    label: r.label,
    roomId: r.room_id,
    temperatureF: r.temperature_f,
    relativeHumidity: r.relative_humidity,
    dewPointF: r.dew_point_f,
    gpp: r.grains_per_pound,
    source: r.source,
  };
}

function isCrew(r: DryingReading): boolean {
  return r.source !== "weather";
}

/**
 * The reading that represents a point on a given day: a crew's meter beats the
 * modelled figure, and among equals the WETTEST one wins.
 *
 * Wettest rather than latest because the baseline is the worst the structure
 * was, and because a job with three affected rooms is argued on the room that
 * dries last. Taking an average would invent a room nobody stood in.
 */
function representative(readings: DryingReading[]): DryingReading | null {
  let best: DryingReading | null = null;
  for (const r of readings) {
    if (!best) {
      best = r;
      continue;
    }
    const bestCrew = isCrew(best);
    const crew = isCrew(r);
    if (crew !== bestCrew) {
      if (crew) best = r;
      continue;
    }
    const a = r.dew_point_f;
    const b = best.dew_point_f;
    if (a == null) continue;
    if (b == null || a > b) best = r;
  }
  return best;
}

/** Group a day's rows by measurement point, wettest crew reading per point. */
function representativeByPoint(rows: DryingReading[]): Map<DryingPoint, DryingReading> {
  const byPoint = new Map<DryingPoint, DryingReading[]>();
  for (const r of rows) {
    const p = r.point as DryingPoint;
    const list = byPoint.get(p) ?? [];
    list.push(r);
    byPoint.set(p, list);
  }
  const out = new Map<DryingPoint, DryingReading>();
  for (const [point, list] of byPoint) {
    const pick = representative(list);
    if (pick) out.set(point, pick);
  }
  return out;
}

/**
 * The baseline set for a job, or null when nothing has been logged by a crew.
 *
 * A day of nothing but the nightly weather fill can never be the baseline: an
 * automatic exterior figure is not evidence anybody was at the property, and a
 * baseline is a statement about the inside of a building.
 */
export function findBaselineSet(rows: DryingReading[]): BaselineSet | null {
  const flagged = rows.filter((r) => (r as { is_baseline?: boolean }).is_baseline === true);
  const pool = flagged.length > 0 ? flagged : rows.filter(isCrew);
  if (pool.length === 0) return null;

  // The earliest flagged day; or, with nothing flagged, the first day a crew
  // was in the building.
  let date = pool[0]!.reading_date;
  for (const r of pool) if (r.reading_date < date) date = r.reading_date;

  // Once the day is chosen, take every row on it — including the modelled
  // exterior figure, which is the only outside number most baseline days have.
  const onDay = rows.filter((r) => r.reading_date === date);
  const points = [...representativeByPoint(onDay).values()]
    .map(toBaselinePoint)
    .sort((a, b) => pointRank(a.point) - pointRank(b.point));

  return { date, declared: flagged.length > 0, points };
}

/**
 * A day read against the baseline, point by point.
 *
 * Returns an entry for every point that appears on either side, so a point
 * measured today but missing from the baseline shows as `unknown` rather than
 * disappearing. Silence about a missing comparison is how a log comes to look
 * more complete than it is.
 */
export function compareToBaseline(
  baseline: BaselineSet | null,
  dayRows: DryingReading[],
  opts?: { toleranceF?: number },
): BaselineDelta[] {
  const tolerance = opts?.toleranceF ?? BASELINE_TOLERANCE_F;
  const current = representativeByPoint(dayRows);
  const base = new Map<DryingPoint, BaselinePointReading>(
    (baseline?.points ?? []).map((p) => [p.point, p]),
  );

  const points = new Set<DryingPoint>([...base.keys(), ...current.keys()]);
  return [...points]
    .sort((a, b) => pointRank(a) - pointRank(b))
    .map((point) => {
      const b = base.get(point) ?? null;
      const c = current.get(point) ?? null;
      const baselineDewPointF = b?.dewPointF ?? null;
      const currentDewPointF = c?.dew_point_f ?? null;
      const baselineGpp = b?.gpp ?? null;
      const currentGpp = c?.grains_per_pound ?? null;
      const deltaF =
        baselineDewPointF == null || currentDewPointF == null
          ? null
          : round1(currentDewPointF - baselineDewPointF);
      const deltaGpp =
        baselineGpp == null || currentGpp == null ? null : round1(currentGpp - baselineGpp);
      return {
        point,
        baselineDewPointF,
        currentDewPointF,
        deltaF,
        baselineGpp,
        currentGpp,
        deltaGpp,
        verdict: verdictFor(deltaF, tolerance),
      };
    });
}

function verdictFor(deltaF: number | null, tolerance: number): BaselineVerdict {
  if (deltaF == null) return "unknown";
  if (deltaF <= -tolerance) return "drying";
  if (deltaF >= tolerance) return "wetter";
  return "flat";
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * The interior delta in one number, which is what the day square shows: how far
 * the inside of the property has moved from the baseline. Negative is drying.
 */
export function interiorDeltaF(deltas: BaselineDelta[]): number | null {
  return deltas.find((d) => d.point === "interior")?.deltaF ?? null;
}

/** "6.2° drier than the baseline", "1.4° wetter", "level with the baseline". */
export function describeDelta(delta: BaselineDelta): string {
  if (delta.deltaF == null) return "no baseline to compare against";
  const magnitude = Math.abs(delta.deltaF);
  if (delta.verdict === "flat") return "level with the baseline";
  return `${magnitude}° ${delta.verdict === "drying" ? "drier" : "wetter"} than the baseline`;
}

/**
 * Whole days between the baseline and a later date. Parsed at UTC noon so a
 * clock change cannot eat or invent a day of equipment rental.
 */
export function daysSinceBaseline(baselineDate: string, date: string): number {
  const a = Date.parse(`${baselineDate}T12:00:00Z`);
  const b = Date.parse(`${date}T12:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/**
 * Melly's rule, checked: the baseline and the equipment drop "should really be
 * the same time". Returns the sentence to show when they are not, or null when
 * they agree (or when there is nothing to compare).
 *
 * This is a warning, never a block. A crew that read the property the morning
 * before the dehus arrived took a real baseline; the log just has to say the
 * two are a day apart rather than implying the machines ran on it.
 */
export function describeBaselineAlignment(
  baselineDate: string | null | undefined,
  equipmentDropDate: string | null | undefined,
): string | null {
  if (!baselineDate || !equipmentDropDate) return null;
  const gap = daysSinceBaseline(equipmentDropDate, baselineDate);
  if (gap === 0) return null;
  const days = Math.abs(gap);
  const unit = days === 1 ? "day" : "days";
  return gap > 0
    ? `The baseline was taken ${days} ${unit} after the equipment was dropped — the drying it shows started before the first reading.`
    : `The baseline was taken ${days} ${unit} before the equipment was dropped.`;
}
