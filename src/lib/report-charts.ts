/**
 * Report charts: the data behind a chart, and the refusal when there should
 * be none.
 *
 * David, 22 Sep: "can the reports be set in charts also... let's have that
 * option — the custom reports should have include different type of charts,
 * including charts or just data... broken down by different states and
 * different tabs."
 *
 * Data stays the default; a chart is the option. A chart is always ONE
 * measure grouped by ONE natural dimension (office, state, status, month, a
 * category like carrier) — never two scales on one axis. And a shape that
 * cannot chart says so in words: a pie of 40 slices or a line through
 * unordered offices is worse than the table it replaces.
 */

import type { ChartSpec, Fmt } from "@/lib/reports-engine";

export type ChartKind = "bar" | "line" | "pie";

/**
 * Categorical series colors, in fixed order — the validated default palette
 * (light and dark stepped separately in styles.css as --viz-1..6), NOT the
 * --chart-* tokens: those are the loss-type colors, and a red slice would read
 * as "fire". --viz-other is the neutral for the folded remainder.
 */
export const VIZ_SERIES = [
  "var(--viz-1)",
  "var(--viz-2)",
  "var(--viz-3)",
  "var(--viz-4)",
  "var(--viz-5)",
  "var(--viz-6)",
] as const;
export const VIZ_OTHER = "var(--viz-other)";

/** Most slices a pie shows before folding the rest into "Other". */
export const PIE_MAX = 6;
/** Most bars before folding the rest into "Other". */
export const BAR_MAX = 12;

export type ChartPoint = { label: string; value: number; order: number; other?: boolean };

export type ChartFit = { ok: true } | { ok: false; reason: string };

/** "2026-09-14T…" → "2026-09", or null for anything that is not a date. */
export function monthKey(v: unknown): string | null {
  const m = typeof v === "string" ? /^(\d{4})-(\d{2})/.exec(v) : null;
  return m ? `${m[1]}-${m[2]}` : null;
}

export function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return new Date(y!, (m ?? 1) - 1, 1).toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
  });
}

/**
 * Rows → one point per group. `group` names a row's group (null = skipped);
 * `measure` is its contribution (1 for a count). Time groups keep time order;
 * everything else is biggest first, so the fold into "Other" keeps the top.
 */
export function aggregate(
  rows: readonly Record<string, unknown>[],
  group: (row: Record<string, unknown>) => { key: string; label: string; order?: number } | null,
  measure: (row: Record<string, unknown>) => number,
  opts: { time?: boolean } = {},
): ChartPoint[] {
  const by = new Map<string, ChartPoint>();
  for (const row of rows) {
    const g = group(row);
    if (!g) continue;
    const v = measure(row);
    const p = by.get(g.key) ?? { label: g.label, value: 0, order: g.order ?? 0 };
    p.value += Number.isFinite(v) ? v : 0;
    by.set(g.key, p);
  }
  const points = [...by.entries()].map(([key, p]) => ({
    ...p,
    order: opts.time ? Number(key.replace("-", "")) : p.order,
  }));
  return opts.time
    ? points.sort((a, b) => a.order - b.order)
    : points.sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
}

/** Keep the first `max - 1` and sum the rest into one "Other". */
export function foldOther(points: readonly ChartPoint[], max: number): ChartPoint[] {
  if (points.length <= max) return [...points];
  const keep = points.slice(0, max - 1);
  const rest = points.slice(max - 1);
  return [
    ...keep,
    {
      label: `Other (${rest.length})`,
      value: rest.reduce((s, p) => s + p.value, 0),
      order: 0,
      other: true,
    },
  ];
}

/** Can this data be drawn as this kind of chart? The refusal is the message shown. */
export function chartFit(
  kind: ChartKind,
  points: readonly ChartPoint[],
  opts: { time: boolean },
): ChartFit {
  if (points.length === 0)
    return { ok: false, reason: "Nothing to chart — no rows have a value to group by." };
  if (points.every((p) => p.value === 0)) {
    return {
      ok: false,
      reason: "Every group comes to zero, so a chart would be empty. The table shows the rows.",
    };
  }
  if (points.length === 1) {
    return {
      ok: false,
      reason: `Everything falls in one group (${points[0]!.label}), so a chart would be a single bar. Group by something else, or read the table.`,
    };
  }
  if (kind === "line" && !opts.time) {
    return { ok: false, reason: "A line needs a time axis. Group by a month field, or use bars." };
  }
  if (kind === "pie" && points.some((p) => p.value < 0)) {
    return { ok: false, reason: "A pie cannot show negative values. Use bars." };
  }
  return { ok: true };
}

/** Points → the ChartSpec ReportView draws. One measure, one series. */
export function toChartSpec(
  kind: ChartKind,
  points: readonly ChartPoint[],
  series: { label: string; fmt: Fmt },
): ChartSpec {
  const folded =
    kind === "pie"
      ? foldOther(points, PIE_MAX)
      : kind === "bar"
        ? foldOther(points, BAR_MAX)
        : [...points];
  return {
    kind,
    xKey: "label",
    data: folded.map((p, i) => ({
      label: p.label,
      value: Math.round(p.value * 100) / 100,
      // Pie slices are categorical; a bar or line is one series, one color.
      fill:
        kind === "pie" ? (p.other ? VIZ_OTHER : VIZ_SERIES[i % VIZ_SERIES.length]) : VIZ_SERIES[0],
    })),
    series: [{ key: "value", label: series.label, color: VIZ_SERIES[0] }],
    fmt: series.fmt,
  };
}

/**
 * Which kinds a preset's own chart can switch to. A preset chart already has
 * its groups; bars always work, a line only over something that reads as
 * time, a pie only for one series with no negatives.
 */
export function presetChartKinds(spec: ChartSpec): ChartKind[] {
  const kinds: ChartKind[] = ["bar"];
  const xs = spec.data.map((d) => d[spec.xKey]);
  const timeLike =
    xs.length > 1 &&
    xs.every(
      (x) =>
        typeof x === "string" &&
        (/^\d{4}-\d{2}/.test(x) || /^[A-Z][a-z]{2}\b/.test(x) || /^W\d+/i.test(x)),
    );
  if (timeLike) kinds.push("line");
  const oneSeries = spec.series.length === 1;
  const nonNegative = spec.data.every((d) => Number(d[spec.series[0]?.key ?? ""]) >= 0);
  if (oneSeries && nonNegative && spec.data.length > 1) kinds.push("pie");
  return kinds;
}
