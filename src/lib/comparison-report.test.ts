import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  PAYMENT_TYPE_GROUPS,
  aggregateComparison,
  comparisonPeriods,
  defaultComparison,
  delta,
  describeComparison,
  sanitizeComparison,
  shapeComparison,
  windowMonths,
  type CompJob,
  type ComparisonSpec,
  type Group,
} from "@/lib/comparison-report";
import { sanitizeDefinition } from "@/lib/custom-reports";

/*
 * David, 21 Oct: "pull MoM and YoY comparative graphs, broken down by
 * location, referral source, job type and payment type." Today is pinned to
 * 22 Oct 2026, so Oct 2026 is a month still running.
 */
const TODAY = new Date(2026, 9, 22);
const spec = (over: Partial<ComparisonSpec>): ComparisonSpec => ({
  ...defaultComparison("yoy"),
  ...over,
});
const job = (id: string, date: string, group = "all", billed = 100, collected = 50): CompJob => ({
  id,
  date,
  group,
  billed,
  collected,
});

describe("periods", () => {
  it("year over year: Jan–Oct this year against Jan–Oct last year, both cut to the 22nd", () => {
    const p = comparisonPeriods(spec({ window: { kind: "ytd" } }), TODAY);
    expect(p.map((x) => [x.from, x.to])).toEqual([
      ["2025-01-01", "2025-10-22"],
      ["2026-01-01", "2026-10-22"],
    ]);
    expect(p[1]!.label).toMatch(/Jan–Oct 2026 \(to Oct 22\) — to date/);
    expect(p[0]!.label).toMatch(/Jan–Oct 2025 \(to Oct 22\)/);
    // Completed months stay whole in every year.
    expect(p[0]!.months[8]).toMatchObject({ key: "2025-09", to: "2025-09-30", partial: false });
  });

  it("year over year with three years", () => {
    const p = comparisonPeriods(
      spec({ years: 3, window: { kind: "fixed", from: "2026-01", to: "2026-03" } }),
      TODAY,
    );
    expect(p.map((x) => x.key)).toEqual(["y2024", "y2025", "y2026"]);
    // A finished window is compared whole, not cut.
    expect(p.every((x) => !x.partial)).toBe(true);
    expect(p[0]!.to).toBe("2024-03-31");
  });

  it("month over month: one period per month, this month marked month to date", () => {
    const p = comparisonPeriods(
      spec({ mode: "mom", window: { kind: "rolling", months: 3 } }),
      TODAY,
    );
    expect(p.map((x) => x.label)).toEqual(["Aug 2026", "Sep 2026", "Oct 2026 — month to date"]);
    expect(p[2]!.to).toBe("2026-10-22");
  });

  it("never runs past this month", () => {
    expect(windowMonths({ kind: "fixed", from: "2026-09", to: "2027-03" }, TODAY)).toEqual([
      "2026-09",
      "2026-10",
    ]);
    expect(windowMonths({ kind: "rolling", months: 12 }, TODAY)[0]).toBe("2025-11");
  });
});

describe("counting", () => {
  it("puts each job in its period and month, and skips days past the cut", () => {
    const s = spec({ window: { kind: "ytd" } });
    const periods = comparisonPeriods(s, TODAY);
    const m = aggregateComparison(
      periods,
      [{ key: "all", label: "All jobs" }],
      [
        job("a", "2026-10-05"),
        job("b", "2025-10-05"),
        // 25 Oct 2025 is past the 22nd: not set against a part-month.
        job("c", "2025-10-25"),
        job("d", "2025-03-01"),
        job("e", null as never),
      ],
      (j) => j.billed,
    );
    expect(m.totals.get("y2026")).toBe(100);
    expect(m.totals.get("y2025")).toBe(200);
    expect(m.counted).toBe(3);
  });

  it("keeps every group as a row at zero when it has no jobs", () => {
    const periods = comparisonPeriods(spec({ window: { kind: "ytd" } }), TODAY);
    const m = aggregateComparison(
      periods,
      PAYMENT_TYPE_GROUPS,
      [job("a", "2026-02-01", "cash")],
      () => 1,
    );
    const r = shapeComparison({
      spec: spec({ dimension: "payment_type", window: { kind: "ytd" } }),
      periods,
      groups: PAYMENT_TYPE_GROUPS,
      matrix: m,
      notes: [],
      measure: "jobs",
    });
    expect(r.rows.map((x) => x.group)).toEqual([
      "Insurance",
      "Self-pay",
      "T&M",
      "Reconstruction",
      "Undetermined / not set",
    ]);
    expect(r.rows.find((x) => x.group === "T&M")).toMatchObject({ y2025: 0, y2026: 0 });
  });

  it("shows a group the list did not know rather than dropping it", () => {
    const groups: Group[] = [{ key: "nj", label: "NJ" }];
    const periods = comparisonPeriods(spec({ window: { kind: "ytd" } }), TODAY);
    const m = aggregateComparison(
      periods,
      groups,
      [job("a", "2026-02-01", "closed-office")],
      () => 1,
    );
    const r = shapeComparison({
      spec: spec({ dimension: "office", window: { kind: "ytd" } }),
      periods,
      groups,
      matrix: m,
      notes: [],
      measure: "jobs",
    });
    expect(r.rows).toHaveLength(2);
  });
});

describe("the change between periods", () => {
  it("absolute and percentage, with no percentage from zero", () => {
    expect(delta(150, 100)).toEqual({ abs: 50, pct: 0.5 });
    expect(delta(50, 100)).toEqual({ abs: -50, pct: -0.5 });
    expect(delta(10, 0)).toEqual({ abs: 10, pct: null });
  });

  it("year over year by month: a row per month, a column per year, the change, totals on top", () => {
    const s = spec({ window: { kind: "fixed", from: "2026-01", to: "2026-02" } });
    const periods = comparisonPeriods(s, TODAY);
    const m = aggregateComparison(
      periods,
      [{ key: "all", label: "All jobs" }],
      [
        job("a", "2025-01-10", "all", 100),
        job("b", "2026-01-10", "all", 300),
        job("c", "2026-02-10", "all", 50),
      ],
      (j) => j.billed,
    );
    const r = shapeComparison({
      spec: s,
      periods,
      groups: [{ key: "all", label: "All jobs" }],
      matrix: m,
      notes: [],
      measure: "billed",
    });
    expect(r.rows[0]).toMatchObject({
      group: "Jan",
      y2025: 100,
      y2026: 300,
      delta: 200,
      deltaPct: 2,
    });
    expect(r.totals).toMatchObject({ y2025: 100, y2026: 350, delta: 250 });
    expect(r.chart?.series.map((x) => x.key)).toEqual(["y2025", "y2026"]);
    expect(r.columns.map((c) => c.label)).toContain("Change %");
  });

  it("month over month by group: lines per group, the biggest six and Other", () => {
    const s = spec({
      mode: "mom",
      dimension: "office",
      window: { kind: "rolling", months: 2 },
      chart: "line",
    });
    const periods = comparisonPeriods(s, TODAY);
    const groups = Array.from({ length: 8 }, (_, i) => ({ key: `o${i}`, label: `Office ${i}` }));
    const jobs = groups.map((g, i) => job(`j${i}`, "2026-09-10", g.key, (i + 1) * 10));
    const m = aggregateComparison(periods, groups, jobs, (j) => j.billed);
    const r = shapeComparison({
      spec: s,
      periods,
      groups,
      matrix: m,
      notes: [],
      measure: "billed",
    });
    expect(r.chart?.kind).toBe("line");
    expect(r.chart?.series).toHaveLength(7);
    expect(r.chart?.series.at(-1)?.label).toBe("Other (2)");
  });

  it("says why there is no chart when nothing falls in any period", () => {
    const s = spec({ window: { kind: "ytd" } });
    const periods = comparisonPeriods(s, TODAY);
    const m = aggregateComparison(periods, [{ key: "all", label: "All jobs" }], [], () => 1);
    const r = shapeComparison({
      spec: s,
      periods,
      groups: [{ key: "all", label: "All jobs" }],
      matrix: m,
      notes: [],
      measure: "jobs",
    });
    expect(r.chart).toBeNull();
    expect(r.chartNote).toMatch(/nothing to draw/);
    expect(r.rows.length).toBeGreaterThan(0);
  });
});

describe("saving and permissions", () => {
  it("survives a save: a stored comparison comes back sanitized", () => {
    const def = sanitizeDefinition({
      area: "jobs",
      columns: ["job_number"],
      comparison: {
        mode: "mom",
        dimension: "loss_type",
        measure: "profit",
        years: 9,
        window: { kind: "rolling", months: 99 },
      },
    });
    expect(def.comparison).toMatchObject({
      mode: "mom",
      dimension: "loss_type",
      measure: "profit",
      years: 4,
      window: { kind: "rolling", months: 24 },
    });
    expect(sanitizeComparison({ dimension: "nonsense", measure: "nonsense" })).toMatchObject({
      dimension: "none",
      measure: "billed",
    });
  });

  it("describes itself in one line", () => {
    expect(describeComparison(spec({ dimension: "referral_type" }))).toBe(
      "Year over year (2 years) · billed by referral source type · January to date",
    );
  });

  it("falls back to job counts for someone who may not see money", () => {
    const src = readFileSync("src/lib/comparison-report.ts", "utf8");
    expect(src).toMatch(
      /if \(measureOf\(measure\)\.money && !opts\.money\) \{\s*measure = "jobs";/,
    );
    const page = readFileSync("src/routes/_authenticated/reports.index.tsx", "utf8");
    expect(page).toMatch(/runCustomReport\(ran, ctx, \{ money: canSeeMoney \}\)/);
    expect(page).toMatch(/const canSeeMoney = useCan\("job\.view_costs"\)/);
  });

  it("is office-scoped like every report: an empty selection reads nothing", () => {
    const src = readFileSync("src/lib/comparison-report.ts", "utf8");
    expect(src).toMatch(
      /q\.in\("location_id", ctx\.locationIds\.length \? ctx\.locationIds : \[NO_OFFICE\]\)/,
    );
  });
});
