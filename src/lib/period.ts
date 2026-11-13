/**
 * Period + comparison period as first-class values.
 *
 * Every report and every scorecard reads its window from here, so the two can
 * never disagree about what "Last quarter vs same quarter last year" means.
 * Ranges are inclusive of both end dates; `to` is normalised to end-of-day so
 * a timestamp filter of `<= to` behaves the way a reader expects.
 */

export type PeriodPreset =
  | "this_month"
  | "last_month"
  | "this_quarter"
  | "last_quarter"
  | "last_90"
  | "last_3_months"
  | "last_6_months"
  | "ytd"
  | "full_year"
  | "all_time"
  | "custom";

export type CompareMode = "previous" | "last_year" | "custom" | "none";

export type Range = { from: Date; to: Date };

export const PERIOD_PRESETS: { key: PeriodPreset; label: string }[] = [
  { key: "this_month", label: "This month" },
  { key: "last_month", label: "Last month" },
  { key: "this_quarter", label: "This quarter" },
  { key: "last_quarter", label: "Last quarter" },
  { key: "last_90", label: "Last 90 days" },
  { key: "last_3_months", label: "Past 3 months" },
  { key: "last_6_months", label: "Past 6 months" },
  { key: "ytd", label: "Year to date" },
  { key: "full_year", label: "Full year" },
  { key: "all_time", label: "All time" },
  { key: "custom", label: "Custom" },
];

export const COMPARE_MODES: { key: CompareMode; label: string }[] = [
  { key: "previous", label: "Previous period" },
  { key: "last_year", label: "Same period last year" },
  { key: "custom", label: "Custom range" },
  { key: "none", label: "No comparison" },
];

/* ------------------------------------------------------------------ */
/* Date plumbing — local calendar days, ISO date strings in the URL    */
/* ------------------------------------------------------------------ */

export function toDateStr(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function parseDateStr(s: string | undefined | null): Date | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

export function endOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function addMonths(d: Date, n: number): Date {
  const x = new Date(d);
  x.setMonth(x.getMonth() + n);
  return x;
}

function dayCount(r: Range): number {
  return Math.round((startOfDay(r.to).getTime() - startOfDay(r.from).getTime()) / 86400_000) + 1;
}

/* ------------------------------------------------------------------ */
/* Resolution                                                          */
/* ------------------------------------------------------------------ */

export function resolvePeriod(
  preset: PeriodPreset,
  from?: string,
  to?: string,
  now = new Date(),
): Range {
  const today = startOfDay(now);
  const y = today.getFullYear();
  const m = today.getMonth();
  const q = Math.floor(m / 3) * 3;

  switch (preset) {
    case "this_month":
      return { from: new Date(y, m, 1), to: endOfDay(new Date(y, m + 1, 0)) };
    case "last_month":
      return { from: new Date(y, m - 1, 1), to: endOfDay(new Date(y, m, 0)) };
    case "this_quarter":
      return { from: new Date(y, q, 1), to: endOfDay(new Date(y, q + 3, 0)) };
    case "last_quarter":
      return { from: new Date(y, q - 3, 1), to: endOfDay(new Date(y, q, 0)) };
    case "ytd":
      return { from: new Date(y, 0, 1), to: endOfDay(today) };
    case "full_year":
      return { from: new Date(y, 0, 1), to: endOfDay(new Date(y, 11, 31)) };
    case "last_3_months":
      return { from: addMonths(today, -3), to: endOfDay(today) };
    case "last_6_months":
      return { from: addMonths(today, -6), to: endOfDay(today) };
    case "all_time":
      // Predates any Gold Star record; "everything we have" without a magic null.
      return { from: new Date(2000, 0, 1), to: endOfDay(today) };
    case "custom": {
      const f = parseDateStr(from) ?? addDays(today, -29);
      const t = parseDateStr(to) ?? today;
      return f <= t ? { from: f, to: endOfDay(t) } : { from: t, to: endOfDay(f) };
    }
    case "last_90":
    default:
      return { from: addDays(today, -89), to: endOfDay(today) };
  }
}

export function resolveCompare(
  mode: CompareMode,
  range: Range,
  from?: string,
  to?: string,
): Range | null {
  if (mode === "none") return null;
  if (mode === "custom") {
    const f = parseDateStr(from);
    const t = parseDateStr(to);
    if (!f || !t) return null;
    return f <= t ? { from: f, to: endOfDay(t) } : { from: t, to: endOfDay(f) };
  }
  if (mode === "last_year") {
    return {
      from: addMonths(startOfDay(range.from), -12),
      to: endOfDay(addMonths(startOfDay(range.to), -12)),
    };
  }
  const days = dayCount(range);
  const to2 = addDays(startOfDay(range.from), -1);
  return { from: addDays(to2, -(days - 1)), to: endOfDay(to2) };
}

/* ------------------------------------------------------------------ */
/* Presentation                                                        */
/* ------------------------------------------------------------------ */

const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Aug 1–Aug 31, 2026" — spelled out so nobody has to guess the boundaries. */
export function formatRange(r: Range): string {
  const a = r.from;
  const b = r.to;
  const left = `${MONTH[a.getMonth()]} ${a.getDate()}`;
  const right = `${MONTH[b.getMonth()]} ${b.getDate()}, ${b.getFullYear()}`;
  if (a.getFullYear() !== b.getFullYear()) {
    return `${left}, ${a.getFullYear()}–${right}`;
  }
  return `${left}–${right}`;
}

export function describeSelection(range: Range, compare: Range | null): string {
  return compare ? `${formatRange(range)} · vs ${formatRange(compare)}` : formatRange(range);
}

/* ------------------------------------------------------------------ */
/* Deltas                                                              */
/* ------------------------------------------------------------------ */

export type Delta = {
  /** null when there is no comparison period, or nothing to compare against. */
  pct: number | null;
  abs: number | null;
  direction: "up" | "down" | "flat" | "none";
};

export function delta(current: number | null, previous: number | null): Delta {
  if (current == null || previous == null) return { pct: null, abs: null, direction: "none" };
  const abs = current - previous;
  if (previous === 0) {
    return { pct: null, abs, direction: abs === 0 ? "flat" : abs > 0 ? "up" : "down" };
  }
  const pct = abs / Math.abs(previous);
  return {
    pct,
    abs,
    direction: Math.abs(pct) < 0.005 ? "flat" : pct > 0 ? "up" : "down",
  };
}

/** Bucket a range into a sensible chart granularity. */
export function bucketsFor(range: Range): { key: string; label: string; from: Date; to: Date }[] {
  const days = dayCount(range);
  const out: { key: string; label: string; from: Date; to: Date }[] = [];
  if (days <= 45) {
    for (let i = 0; i < days; i += 1) {
      const d = addDays(startOfDay(range.from), i);
      out.push({
        key: toDateStr(d),
        label: `${MONTH[d.getMonth()]} ${d.getDate()}`,
        from: startOfDay(d),
        to: endOfDay(d),
      });
    }
    return out;
  }
  if (days <= 200) {
    let cursor = startOfDay(range.from);
    while (cursor <= range.to) {
      const end = addDays(cursor, 6);
      out.push({
        key: toDateStr(cursor),
        label: `${MONTH[cursor.getMonth()]} ${cursor.getDate()}`,
        from: cursor,
        to: endOfDay(end > range.to ? range.to : end),
      });
      cursor = addDays(cursor, 7);
    }
    return out;
  }
  let cursor = new Date(range.from.getFullYear(), range.from.getMonth(), 1);
  while (cursor <= range.to) {
    const end = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
    out.push({
      key: `${cursor.getFullYear()}-${cursor.getMonth() + 1}`,
      label: `${MONTH[cursor.getMonth()]} ${String(cursor.getFullYear()).slice(2)}`,
      from: cursor,
      to: endOfDay(end > range.to ? range.to : end),
    });
    cursor = addMonths(cursor, 1);
  }
  return out;
}

export function median(values: number[]): number | null {
  const v = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}
