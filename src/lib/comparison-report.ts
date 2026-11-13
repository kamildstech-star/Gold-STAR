/**
 * Comparative reports — month over month and year over year (David, 21 Oct):
 * "pull MoM and YoY comparative graphs, broken down by location, referral
 * source (salesperson or broker), job type (water, fire, mold, sewer, bio),
 * and payment type (self-pay, insurance, TNM)."
 *
 * A comparison is a mode of the custom report (custom-reports.ts): its spec
 * rides in the saved definition, so it is saved, re-run and shared exactly
 * like any custom report, and it renders through the same ReportView — the
 * chart machinery, the table with its totals on top, CSV and Excel.
 *
 * WHAT IS COUNTED. Jobs, placed in a month by their date of loss (or, if
 * chosen, the date they were created) — the same spine the preset reports
 * use. Billed and collected are each job's own billed / collected total;
 * profit is the job ledger's own figure (jobProfit over job_running_cost),
 * so no number here can disagree with the job page.
 *
 * HONEST PERIODS. A month or year still in progress is labelled as such
 * ("Oct 2026 — month to date"), and in year over year the earlier years are
 * cut to the same day, so a part-month is never set against a whole one.
 *
 * Pure from `comparisonPeriods` to `shapeComparison`; `runComparison` is the
 * one function that reads the database.
 */
import { supabase } from "@/integrations/supabase/client";
import { JOB_LOSS_LABELS, JOB_LOSS_TYPES } from "@/lib/jobs";
import { jobProfit } from "@/lib/job-ledger";
import { fetchOptionValues } from "@/lib/option-lists";
import { VIZ_OTHER, VIZ_SERIES } from "@/lib/report-charts";
import type { ChartSpec, Col, Fmt, Kpi, ReportCtx, ReportResult } from "@/lib/reports-engine";
import { idChunks, referrerDisplayName } from "@/lib/referrer-name";
import { jobRunningCost } from "@/lib/running-cost";
import { roundMoneyLoose } from "@/lib/money";

/* ------------------------------------------------------------------ */
/* The spec                                                            */
/* ------------------------------------------------------------------ */

export type ComparisonMode = "mom" | "yoy";

export type ComparisonDimension =
  "none" | "office" | "referral_type" | "referrer" | "loss_type" | "payment_type";

export type ComparisonMeasure = "billed" | "collected" | "jobs" | "profit";

export type ComparisonWindow =
  /** The last N months, ending with this one. */
  | { kind: "rolling"; months: number }
  /** January to this month. */
  | { kind: "ytd" }
  /** From one month to another, inclusive, "YYYY-MM". */
  | { kind: "fixed"; from: string; to: string };

export type ComparisonSpec = {
  mode: ComparisonMode;
  dimension: ComparisonDimension;
  measure: ComparisonMeasure;
  /** Which date puts a job in a month. */
  dateBasis: "loss_date" | "created_at";
  window: ComparisonWindow;
  /** Year over year: how many years side by side, this one included. */
  years: number;
  chart: "bar" | "line";
};

export const DIMENSIONS: { key: ComparisonDimension; label: string }[] = [
  { key: "none", label: "No breakdown" },
  { key: "office", label: "Office" },
  { key: "referral_type", label: "Referral source type (salesperson, broker…)" },
  { key: "referrer", label: "Referring person or company" },
  { key: "loss_type", label: "Job type (water, fire, mold…)" },
  { key: "payment_type", label: "Payment type (self-pay, insurance, T&M)" },
];

export const MEASURES: { key: ComparisonMeasure; label: string; fmt: Fmt; money: boolean }[] = [
  { key: "billed", label: "Billed", fmt: "usd0", money: true },
  { key: "collected", label: "Collected", fmt: "usd0", money: true },
  { key: "jobs", label: "Jobs", fmt: "int", money: false },
  { key: "profit", label: "Profit", fmt: "usd0", money: true },
];

export const measureOf = (k: ComparisonMeasure) =>
  MEASURES.find((m) => m.key === k) ?? MEASURES[2]!;

export function defaultComparison(mode: ComparisonMode = "yoy"): ComparisonSpec {
  return {
    mode,
    dimension: "none",
    measure: "billed",
    dateBasis: "loss_date",
    window: mode === "yoy" ? { kind: "ytd" } : { kind: "rolling", months: 6 },
    years: 2,
    chart: mode === "yoy" ? "bar" : "line",
  };
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** A stored spec made safe to run — unknown values fall back, numbers clamp. */
export function sanitizeComparison(raw: unknown): ComparisonSpec {
  const d = (raw ?? {}) as Partial<ComparisonSpec>;
  const mode: ComparisonMode = d.mode === "mom" ? "mom" : "yoy";
  const base = defaultComparison(mode);
  const w = d.window as ComparisonWindow | undefined;
  let window: ComparisonWindow = base.window;
  if (w?.kind === "ytd") window = { kind: "ytd" };
  else if (w?.kind === "rolling" && Number.isFinite(Number(w.months)))
    window = { kind: "rolling", months: Math.min(24, Math.max(1, Math.round(Number(w.months)))) };
  else if (w?.kind === "fixed" && MONTH_RE.test(w.from) && MONTH_RE.test(w.to))
    window =
      w.from <= w.to
        ? { kind: "fixed", from: w.from, to: w.to }
        : { kind: "fixed", from: w.to, to: w.from };
  return {
    mode,
    dimension: DIMENSIONS.some((x) => x.key === d.dimension) ? d.dimension! : base.dimension,
    measure: MEASURES.some((x) => x.key === d.measure) ? d.measure! : base.measure,
    dateBasis: d.dateBasis === "created_at" ? "created_at" : "loss_date",
    window,
    years: Math.min(4, Math.max(2, Math.round(Number(d.years) || 2))),
    chart: d.chart === "line" ? "line" : d.chart === "bar" ? "bar" : base.chart,
  };
}

/* ------------------------------------------------------------------ */
/* Periods                                                             */
/* ------------------------------------------------------------------ */

const pad = (n: number) => String(n).padStart(2, "0");
/** "YYYY-MM-DD" for a local date. */
export const dayKey = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const ym = (y: number, m: number) => {
  const t = new Date(y, m - 1, 1);
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}`;
};
const lastDay = (y: number, m: number) => new Date(y, m, 0).getDate();
const MONTH_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const monthName = (key: string) => {
  const [y, m] = key.split("-").map(Number);
  return `${MONTH_SHORT[m! - 1]} ${y}`;
};

/** One month of one period: the days it covers, inclusive. */
export type PeriodMonth = { key: string; from: string; to: string; partial: boolean };

export type Period = {
  key: string;
  label: string;
  /** Inclusive "YYYY-MM-DD" bounds. */
  from: string;
  to: string;
  partial: boolean;
  months: PeriodMonth[];
};

/** The months the window covers, oldest first, never past this month. */
export function windowMonths(w: ComparisonWindow, today: Date): string[] {
  const y = today.getFullYear();
  const m = today.getMonth() + 1;
  const now = ym(y, m);
  let from: string;
  let to: string;
  if (w.kind === "ytd") {
    from = ym(y, 1);
    to = now;
  } else if (w.kind === "rolling") {
    from = ym(y, m - (w.months - 1));
    to = now;
  } else {
    from = w.from;
    to = w.to < now ? w.to : now;
  }
  const out: string[] = [];
  let [cy, cm] = from.split("-").map(Number) as [number, number];
  for (let guard = 0; guard < 120; guard += 1) {
    const k = ym(cy, cm);
    if (k > to) break;
    out.push(k);
    cm += 1;
    if (cm > 12) {
      cm = 1;
      cy += 1;
    }
  }
  return out;
}

/**
 * The periods compared.
 *
 * Month over month: one period per month of the window; this month, while it
 * runs, is "month to date".
 *
 * Year over year: the window's months (at most twelve, the latest kept) in
 * this year and the `years - 1` before it. While the window's last month is
 * still running, EVERY year is cut to the same day of it — Jan 1 – Oct 22 set
 * against Jan 1 – Oct 22 — so a part-year is never compared with a whole one.
 */
export function comparisonPeriods(spec: ComparisonSpec, today: Date): Period[] {
  const todayKey = dayKey(today);
  let months = windowMonths(spec.window, today);
  if (spec.mode === "mom") {
    return months.map((k) => {
      const [y, m] = k.split("-").map(Number) as [number, number];
      const end = `${k}-${pad(lastDay(y, m))}`;
      const partial = todayKey < end && todayKey >= `${k}-01`;
      const to = partial ? todayKey : end;
      return {
        key: k,
        label: partial ? `${monthName(k)} — month to date` : monthName(k),
        from: `${k}-01`,
        to,
        partial,
        months: [{ key: k, from: `${k}-01`, to, partial }],
      };
    });
  }

  months = months.slice(-12);
  if (!months.length) return [];
  const last = months[months.length - 1]!;
  const [ly, lm] = last.split("-").map(Number) as [number, number];
  const cutDay =
    todayKey >= `${last}-01` && todayKey < `${last}-${pad(lastDay(ly, lm))}`
      ? today.getDate()
      : null;
  const periods: Period[] = [];
  for (let back = spec.years - 1; back >= 0; back -= 1) {
    const pm: PeriodMonth[] = months.map((k) => {
      const [y, m] = k.split("-").map(Number) as [number, number];
      const key = ym(y - back, m);
      const full = lastDay(y - back, m);
      const day = k === last && cutDay != null ? Math.min(cutDay, full) : full;
      return {
        key,
        from: `${key}-01`,
        to: `${key}-${pad(day)}`,
        partial: k === last && cutDay != null,
      };
    });
    const first = pm[0]!;
    const end = pm[pm.length - 1]!;
    const [fy] = first.key.split("-").map(Number) as [number];
    const [ey] = end.key.split("-").map(Number) as [number];
    const span =
      pm.length === 1
        ? monthName(first.key)
        : `${MONTH_SHORT[Number(first.key.slice(5)) - 1]}${fy !== ey ? ` ${fy}` : ""}–${MONTH_SHORT[Number(end.key.slice(5)) - 1]} ${ey}`;
    const cut = end.partial
      ? ` (to ${MONTH_SHORT[Number(end.key.slice(5)) - 1]} ${Number(end.to.slice(8))})`
      : "";
    periods.push({
      key: `y${ey}`,
      label: `${span}${cut}${back === 0 && end.partial ? " — to date" : ""}`,
      from: first.from,
      to: end.to,
      partial: end.partial,
      months: pm,
    });
  }
  return periods;
}

/* ------------------------------------------------------------------ */
/* Groups                                                              */
/* ------------------------------------------------------------------ */

export type Group = { key: string; label: string };

/** Payment type, in the client's words. `job_type` is a real field on every job. */
export const PAYMENT_TYPE_GROUPS: Group[] = [
  { key: "insurance", label: "Insurance" },
  { key: "cash", label: "Self-pay" },
  { key: "t_m", label: "T&M" },
  { key: "reconstruction", label: "Reconstruction" },
  { key: "undetermined", label: "Undetermined / not set" },
];

export const NO_REFERRAL = "__none";

/** One job, reduced to what a comparison needs. */
export type CompJob = {
  id: string;
  /** "YYYY-MM-DD" the job is placed by. */
  date: string | null;
  group: string;
  billed: number;
  collected: number;
};

/* ------------------------------------------------------------------ */
/* Aggregation                                                         */
/* ------------------------------------------------------------------ */

export type Matrix = {
  /** group → period key → value */
  byGroup: Map<string, Map<string, number>>;
  /** period key → month index → value (all groups) */
  byMonth: Map<string, number[]>;
  /** period key → value (all groups) */
  totals: Map<string, number>;
  /** Jobs that landed in at least one period. */
  counted: number;
};

/** Sum `value` per group, period and month. Every group and period starts at 0. */
export function aggregateComparison(
  periods: readonly Period[],
  groups: readonly Group[],
  jobs: readonly CompJob[],
  value: (j: CompJob) => number | null,
): Matrix {
  const byGroup = new Map<string, Map<string, number>>();
  for (const g of groups) byGroup.set(g.key, new Map(periods.map((p) => [p.key, 0])));
  const byMonth = new Map(periods.map((p) => [p.key, p.months.map(() => 0)]));
  const totals = new Map(periods.map((p) => [p.key, 0]));
  let counted = 0;
  for (const j of jobs) {
    if (!j.date) continue;
    const v = value(j);
    let hit = false;
    for (const p of periods) {
      if (j.date < p.from || j.date > p.to) continue;
      const mi = p.months.findIndex((m) => j.date! >= m.from && j.date! <= m.to);
      if (mi < 0) continue; // inside the span, outside a cut month (YoY)
      hit = true;
      if (v == null) continue;
      if (!byGroup.has(j.group)) byGroup.set(j.group, new Map(periods.map((q) => [q.key, 0])));
      const g = byGroup.get(j.group)!;
      g.set(p.key, (g.get(p.key) ?? 0) + v);
      byMonth.get(p.key)![mi]! += v;
      totals.set(p.key, (totals.get(p.key) ?? 0) + v);
    }
    if (hit) counted += 1;
  }
  return { byGroup, byMonth, totals, counted };
}

const round2 = roundMoneyLoose;

/** Change from `before` to `after`: absolute, and as a fraction (null from zero). */
export function delta(after: number, before: number): { abs: number; pct: number | null } {
  return {
    abs: round2(after - before),
    pct: before !== 0 ? (after - before) / Math.abs(before) : null,
  };
}

/* ------------------------------------------------------------------ */
/* Shaping into a report                                               */
/* ------------------------------------------------------------------ */

export type ShapeInput = {
  spec: ComparisonSpec;
  periods: Period[];
  groups: Group[];
  matrix: Matrix;
  /** Said under the KPIs: money withheld, jobs not costed, … */
  notes: string[];
  /** The measure actually shown — jobs when money is not the viewer's to see. */
  measure: ComparisonMeasure;
};

const MAX_SERIES = 6;

export function shapeComparison(input: ShapeInput): ReportResult {
  const { spec, periods, matrix, notes } = input;
  const measure = measureOf(input.measure);
  const fmt = measure.fmt;
  const groupLabel = new Map(input.groups.map((g) => [g.key, g.label]));
  // Groups the data brought that the list did not know (an office since
  // closed, a payment type added later) are shown too, never dropped.
  const groups: Group[] = [
    ...input.groups,
    ...[...matrix.byGroup.keys()]
      .filter((k) => !groupLabel.has(k))
      .map((k) => ({ key: k, label: k || "Not set" })),
  ];
  const last = periods[periods.length - 1];
  const prev = periods[periods.length - 2];
  const dimLabel =
    DIMENSIONS.find((d) => d.key === spec.dimension)?.label.replace(/ \(.*$/, "") ?? "Group";

  if (!periods.length) {
    return {
      kpis: [],
      chart: null,
      columns: [],
      rows: [],
      empty: "This window has no months up to today — pick a window that has started.",
    };
  }

  const kpis: Kpi[] = periods.slice(-2).map((p, i, arr) => ({
    label: `${measure.label} · ${p.label}`,
    value: matrix.totals.get(p.key) ?? 0,
    prev: i === arr.length - 1 && arr.length > 1 ? (matrix.totals.get(arr[0]!.key) ?? 0) : null,
    fmt,
    ...(p.partial ? { note: "still in progress" } : {}),
  }));
  if (notes.length)
    kpis.push({ label: "Note", value: null, prev: null, fmt: "text", note: notes.join(" ") });

  const pctCol = (
    key: string,
    label: string,
    get: (r: Record<string, unknown>) => unknown,
  ): Col => ({
    key,
    label,
    num: true,
    fmt: "pct",
    get,
  });
  const deltaCols = (): Col[] =>
    last && prev
      ? [
          {
            key: "delta",
            label: `Change vs ${prev.label}`,
            num: true,
            fmt,
            get: (r) => r.delta,
          },
          pctCol("deltaPct", "Change %", (r) => r.deltaPct),
        ]
      : [];
  const periodCols: Col[] = periods.map((p) => ({
    key: p.key,
    label: p.label,
    num: true,
    fmt,
    get: (r) => r[p.key],
  }));
  const withDelta = (row: Record<string, unknown>) => {
    if (last && prev) {
      const d = delta(Number(row[last.key]) || 0, Number(row[prev.key]) || 0);
      row.delta = d.abs;
      row.deltaPct = d.pct;
    }
    return row;
  };

  let rows: Record<string, unknown>[];
  let columns: Col[];
  let chart: ChartSpec | null = null;

  if (spec.mode === "yoy" && spec.dimension === "none") {
    // Months down the side, years across: Jan 2025 vs Jan 2026 per row.
    const monthCount = periods[0]!.months.length;
    rows = Array.from({ length: monthCount }, (_, mi) => {
      const lastMonth = last!.months[mi]!;
      const label = `${MONTH_SHORT[Number(lastMonth.key.slice(5)) - 1]}${lastMonth.partial ? ` (1–${Number(lastMonth.to.slice(8))})` : ""}`;
      const row: Record<string, unknown> = { id: `m${mi}`, group: label };
      for (const p of periods) row[p.key] = round2(matrix.byMonth.get(p.key)![mi]!);
      return withDelta(row);
    });
    columns = [
      { key: "group", label: "Month", get: (r) => r.group },
      ...periodCols,
      ...deltaCols(),
    ];
    chart = {
      kind: spec.chart,
      xKey: "group",
      fmt,
      data: rows.map((r) => ({
        group: r.group,
        ...Object.fromEntries(periods.map((p) => [p.key, r[p.key]])),
      })),
      series: periods.map((p, i) => ({
        key: p.key,
        label: p.label,
        color: VIZ_SERIES[i % VIZ_SERIES.length]!,
      })),
    };
  } else if (spec.mode === "mom" && spec.dimension === "none") {
    // One row per month, with the change from the month before.
    rows = periods.map((p, i) => {
      const v = round2(matrix.totals.get(p.key) ?? 0);
      const before = i > 0 ? (matrix.totals.get(periods[i - 1]!.key) ?? 0) : null;
      const d = before == null ? null : delta(v, before);
      return {
        id: p.key,
        group: p.label,
        value: v,
        delta: d?.abs ?? null,
        deltaPct: d?.pct ?? null,
      };
    });
    columns = [
      { key: "group", label: "Month", get: (r) => r.group },
      { key: "value", label: measure.label, num: true, fmt, get: (r) => r.value },
      { key: "delta", label: "Change vs month before", num: true, fmt, get: (r) => r.delta },
      pctCol("deltaPct", "Change %", (r) => r.deltaPct),
    ];
    chart = {
      kind: spec.chart,
      xKey: "group",
      fmt,
      data: rows.map((r) => ({ group: r.group, value: r.value })),
      series: [{ key: "value", label: measure.label, color: VIZ_SERIES[0]! }],
    };
  } else {
    // Groups down the side, periods across, change between the last two.
    rows = groups.map((g) => {
      const cells = matrix.byGroup.get(g.key);
      const row: Record<string, unknown> = { id: g.key, group: g.label };
      for (const p of periods) row[p.key] = round2(cells?.get(p.key) ?? 0);
      return withDelta(row);
    });
    columns = [
      { key: "group", label: dimLabel, get: (r) => r.group },
      ...periodCols,
      ...deltaCols(),
    ];
    if (spec.mode === "yoy") {
      // Each group's bar per year, side by side.
      chart = {
        kind: "bar",
        xKey: "group",
        fmt,
        data: rows.map((r) => ({
          group: r.group,
          ...Object.fromEntries(periods.map((p) => [p.key, r[p.key]])),
        })),
        series: periods.map((p, i) => ({
          key: p.key,
          label: p.label,
          color: VIZ_SERIES[i % VIZ_SERIES.length]!,
        })),
      };
    } else {
      // Months across, one line per group — the biggest six, the rest as Other.
      const ranked = [...rows].sort(
        (a, b) =>
          periods.reduce((s, p) => s + Math.abs(Number(b[p.key]) || 0), 0) -
          periods.reduce((s, p) => s + Math.abs(Number(a[p.key]) || 0), 0),
      );
      const shown = ranked.slice(0, MAX_SERIES);
      const rest = ranked.slice(MAX_SERIES);
      chart = {
        kind: spec.chart,
        xKey: "month",
        fmt,
        data: periods.map((p) => ({
          month: p.label,
          ...Object.fromEntries(shown.map((r) => [`g:${r.id}`, r[p.key]])),
          ...(rest.length
            ? { other: round2(rest.reduce((s, r) => s + (Number(r[p.key]) || 0), 0)) }
            : {}),
        })),
        series: [
          ...shown.map((r, i) => ({
            key: `g:${r.id}`,
            label: String(r.group),
            color: VIZ_SERIES[i % VIZ_SERIES.length]!,
          })),
          ...(rest.length
            ? [{ key: "other", label: `Other (${rest.length})`, color: VIZ_OTHER }]
            : []),
        ],
      };
    }
  }

  // Totals on top (21 Oct): the period totals, and the change between them —
  // computed from the totals, never by adding up row changes.
  const totals: Record<string, unknown> = {
    group: `Total (${matrix.counted} job${matrix.counted === 1 ? "" : "s"})`,
  };
  if (spec.mode === "mom" && spec.dimension === "none") {
    totals.value = round2(periods.reduce((s, p) => s + (matrix.totals.get(p.key) ?? 0), 0));
  } else {
    for (const p of periods) totals[p.key] = round2(matrix.totals.get(p.key) ?? 0);
    withDelta(totals);
  }

  const nothing = matrix.counted === 0;
  return {
    kpis,
    chart: nothing ? null : chart,
    chartNote: nothing
      ? "No jobs fall in any of these periods for the offices selected, so there is nothing to draw. The table lists every group at zero."
      : null,
    columns,
    rows,
    totals,
    empty: null,
  };
}

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

type JobRead = {
  id: string;
  location_id: string | null;
  loss_type: string | null;
  job_type: string | null;
  referral_source_type: string | null;
  referred_by_contact_id: string | null;
  referred_by_account_id: string | null;
  referred_by_name: string | null;
  billed_amount: number | null;
  collected_amount: number | null;
  loss_date: string | null;
  created_at: string;
};

const JOB_SELECT =
  "id, location_id, loss_type, job_type, referral_source_type, referred_by_contact_id, referred_by_account_id, referred_by_name, billed_amount, collected_amount, loss_date, created_at";

/** Above this many jobs, profit is not computed (one costing call per job) — and that is said. */
export const PROFIT_JOB_CAP = 600;

const NO_OFFICE = "00000000-0000-0000-0000-000000000000";

/** Every job in the union of the periods, read a page at a time — never silently cut. */
async function readJobs(
  spec: ComparisonSpec,
  periods: Period[],
  ctx: Pick<ReportCtx, "locationIds">,
) {
  const from = periods.reduce((a, p) => (p.from < a ? p.from : a), periods[0]!.from);
  const to = periods.reduce((a, p) => (p.to > a ? p.to : a), periods[0]!.to);
  const col = spec.dateBasis;
  // created_at is a timestamp: the day after `to` is the exclusive upper bound.
  const [ty, tm, td] = to.split("-").map(Number) as [number, number, number];
  const after = dayKey(new Date(ty, tm - 1, td + 1));
  const out: JobRead[] = [];
  for (let page = 0; page < 50; page += 1) {
    let q = supabase.from("jobs").select(JOB_SELECT).gte(col, from);
    q = col === "created_at" ? q.lt(col, after) : q.lte(col, to);
    if (ctx.locationIds)
      q = q.in("location_id", ctx.locationIds.length ? ctx.locationIds : [NO_OFFICE]);
    const { data, error } = await q.order("id").range(page * 1000, page * 1000 + 999);
    if (error) throw error;
    out.push(...((data ?? []) as unknown as JobRead[]));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

/** created_at is a UTC timestamp; the day it falls on, locally. */
function jobDate(j: JobRead, basis: ComparisonSpec["dateBasis"]): string | null {
  if (basis === "loss_date") return j.loss_date ? j.loss_date.slice(0, 10) : null;
  const t = new Date(j.created_at);
  return Number.isFinite(t.getTime()) ? dayKey(t) : null;
}

/** The dimension's full list, so a group with no jobs is a zero row, not missing. */
async function groupsFor(
  spec: ComparisonSpec,
  jobs: JobRead[],
  ctx: Pick<ReportCtx, "locationIds" | "locationNames">,
): Promise<{ groups: Group[]; groupOf: (j: JobRead) => string }> {
  switch (spec.dimension) {
    case "office": {
      const ids = ctx.locationIds ?? Object.keys(ctx.locationNames);
      return {
        groups: ids.map((id) => ({ key: id, label: ctx.locationNames[id] ?? "Unassigned" })),
        groupOf: (j) => j.location_id ?? "",
      };
    }
    case "loss_type":
      return {
        groups: JOB_LOSS_TYPES.map((k) => ({ key: k, label: JOB_LOSS_LABELS[k] })),
        groupOf: (j) => j.loss_type ?? "",
      };
    case "payment_type":
      return {
        groups: PAYMENT_TYPE_GROUPS,
        groupOf: (j) =>
          !j.job_type || j.job_type === "undetermined" ? "undetermined" : j.job_type,
      };
    case "referral_type": {
      const opts = await fetchOptionValues("referral_source_type").catch(() => []);
      return {
        groups: [
          ...opts.map((o) => ({ key: o.key, label: o.label })),
          { key: NO_REFERRAL, label: "No referral recorded" },
        ],
        groupOf: (j) => j.referral_source_type || NO_REFERRAL,
      };
    }
    case "referrer": {
      // Live names, never the stale referred_by_name copy (referrer-name.ts).
      const contacts: Record<string, string> = {};
      const accounts: Record<string, string> = {};
      for (const chunk of idChunks(jobs.map((j) => j.referred_by_contact_id ?? ""))) {
        const { data } = await supabase.from("contacts").select("id, full_name").in("id", chunk);
        for (const r of data ?? []) if (r.full_name) contacts[r.id] = r.full_name;
      }
      for (const chunk of idChunks(jobs.map((j) => j.referred_by_account_id ?? ""))) {
        const { data } = await supabase.from("accounts").select("id, name").in("id", chunk);
        for (const r of data ?? []) if (r.name) accounts[r.id] = r.name;
      }
      const keyOf = (j: JobRead) =>
        j.referred_by_contact_id
          ? `c:${j.referred_by_contact_id}`
          : j.referred_by_account_id
            ? `a:${j.referred_by_account_id}`
            : j.referred_by_name?.trim()
              ? `n:${j.referred_by_name.trim().toLowerCase()}`
              : NO_REFERRAL;
      const labels = new Map<string, string>();
      for (const j of jobs) {
        const k = keyOf(j);
        if (labels.has(k) || k === NO_REFERRAL) continue;
        labels.set(k, referrerDisplayName(j, contacts, accounts) ?? "Unnamed referrer");
      }
      return {
        groups: [
          ...[...labels.entries()]
            .sort((a, b) => a[1].localeCompare(b[1]))
            .map(([key, label]) => ({ key, label })),
          { key: NO_REFERRAL, label: "No referrer recorded" },
        ],
        groupOf: keyOf,
      };
    }
    default:
      return { groups: [{ key: "all", label: "All jobs" }], groupOf: () => "all" };
  }
}

/** The comparison, run under the viewer's own permissions and office scope. */
export async function runComparison(
  raw: ComparisonSpec,
  ctx: Pick<ReportCtx, "locationIds" | "locationNames">,
  opts: { money: boolean; today?: Date },
): Promise<ReportResult> {
  const spec = sanitizeComparison(raw);
  const today = opts.today ?? new Date();
  const periods = comparisonPeriods(spec, today);
  if (!periods.length) {
    return shapeComparison({
      spec,
      periods,
      groups: [],
      matrix: aggregateComparison([], [], [], () => 0),
      notes: [],
      measure: spec.measure,
    });
  }
  const notes: string[] = [];
  let measure = spec.measure;
  if (measureOf(measure).money && !opts.money) {
    measure = "jobs";
    notes.push("Money measures need permission to see job costs — showing job counts instead.");
  }

  const jobs = await readJobs(spec, periods, ctx);
  const { groups, groupOf } = await groupsFor(spec, jobs, ctx);

  let profitOf: Map<string, number | null> | null = null;
  if (measure === "profit") {
    if (jobs.length > PROFIT_JOB_CAP) {
      measure = "billed";
      notes.push(
        `Profit is costed job by job, and ${jobs.length} jobs is more than ${PROFIT_JOB_CAP} — showing billed instead. Narrow the months or the offices to see profit.`,
      );
    } else {
      profitOf = new Map();
      let uncosted = 0;
      for (let i = 0; i < jobs.length; i += 8) {
        await Promise.all(
          jobs.slice(i, i + 8).map(async (j) => {
            const cost = await jobRunningCost(j.id).catch(() => null);
            if (!cost) uncosted += 1;
            profitOf!.set(
              j.id,
              cost
                ? jobProfit({
                    cost,
                    effort: null,
                    billed: null,
                    paid: null,
                    referral: null,
                    commission: null,
                  } as never)
                : null,
            );
          }),
        );
      }
      if (uncosted)
        notes.push(
          `${uncosted} job${uncosted === 1 ? " has" : "s have"} no running cost and are left out of profit.`,
        );
    }
  }

  const comp: CompJob[] = jobs.map((j) => ({
    id: j.id,
    date: jobDate(j, spec.dateBasis),
    group: groupOf(j),
    billed: Number(j.billed_amount) || 0,
    collected: Number(j.collected_amount) || 0,
  }));
  const value = (c: CompJob): number | null =>
    measure === "jobs"
      ? 1
      : measure === "billed"
        ? c.billed
        : measure === "collected"
          ? c.collected
          : (profitOf?.get(c.id) ?? null);
  const matrix = aggregateComparison(periods, groups, comp, value);
  notes.push(
    `Each job is placed by its ${spec.dateBasis === "loss_date" ? "date of loss" : "created date"}${
      measureOf(measure).money
        ? `; its ${measureOf(measure).label.toLowerCase()} is the job's own total`
        : ""
    }.`,
  );
  return shapeComparison({ spec, periods, groups, matrix, notes, measure });
}

/** One line under the title. */
export function describeComparison(spec: ComparisonSpec): string {
  const s = sanitizeComparison(spec);
  const w =
    s.window.kind === "ytd"
      ? "January to date"
      : s.window.kind === "rolling"
        ? `the last ${s.window.months} month${s.window.months === 1 ? "" : "s"}`
        : `${monthName(s.window.from)} to ${monthName(s.window.to)}`;
  const mode = s.mode === "yoy" ? `Year over year (${s.years} years)` : "Month over month";
  const dim =
    s.dimension === "none"
      ? ""
      : ` by ${DIMENSIONS.find((d) => d.key === s.dimension)!
          .label.replace(/ \(.*$/, "")
          .toLowerCase()}`;
  return `${mode} · ${measureOf(s.measure).label.toLowerCase()}${dim} · ${w}`;
}
