import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import {
  PIE_MAX,
  VIZ_OTHER,
  aggregate,
  chartFit,
  foldOther,
  monthKey,
  presetChartKinds,
  toChartSpec,
} from "./report-charts";
import { blankDefinition, buildCustomChart, shapeCustomResult } from "./custom-reports";

/**
 * David, 22 Sep: "can the reports be set in charts also... the custom reports
 * should have include different type of charts, including charts or just
 * data... broken down by different states and different tabs."
 */

const lookups = { officeName: (id: unknown) => String(id ?? "Unassigned"), statusName: String };
const jobs = [
  {
    id: "1",
    region: "NJ",
    billed_amount: 100,
    created_at: "2026-08-03T10:00:00Z",
    location_id: "LW",
  },
  {
    id: "2",
    region: "NJ",
    billed_amount: 50,
    created_at: "2026-09-01T10:00:00Z",
    location_id: "LW",
  },
  {
    id: "3",
    region: "NY",
    billed_amount: 200,
    created_at: "2026-09-12T10:00:00Z",
    location_id: "BK",
  },
];

describe("grouping", () => {
  it("counts or sums per group, biggest first", () => {
    const pts = aggregate(
      jobs,
      (r) => ({ key: String(r.region), label: String(r.region) }),
      () => 1,
    );
    expect(pts.map((p) => [p.label, p.value])).toEqual([
      ["NJ", 2],
      ["NY", 1],
    ]);
  });

  it("keeps months in time order", () => {
    const pts = aggregate(
      jobs,
      (r) => {
        const k = monthKey(r.created_at);
        return k ? { key: k, label: k } : null;
      },
      (r) => Number(r.billed_amount),
      { time: true },
    );
    expect(pts.map((p) => [p.label, p.value])).toEqual([
      ["2026-08", 100],
      ["2026-09", 250],
    ]);
  });

  it("folds a long tail into Other instead of generating hues", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ label: `S${i}`, value: 9 - i, order: 0 }));
    const folded = foldOther(many, PIE_MAX);
    expect(folded).toHaveLength(PIE_MAX);
    expect(folded.at(-1)).toMatchObject({ label: "Other (4)", value: 10, other: true });
    const spec = toChartSpec("pie", many, { label: "x", fmt: "int" });
    expect(spec.data.at(-1)!.fill).toBe(VIZ_OTHER);
  });
});

describe("refusing nonsense", () => {
  const two = [
    { label: "NJ", value: 2, order: 0 },
    { label: "NY", value: 1, order: 0 },
  ];
  it("will not draw a line through things that are not time", () => {
    expect(chartFit("line", two, { time: false })).toEqual({
      ok: false,
      reason: "A line needs a time axis. Group by a month field, or use bars.",
    });
    expect(chartFit("line", two, { time: true }).ok).toBe(true);
  });

  it("will not chart one group, all zeros, nothing, or a negative pie", () => {
    expect(chartFit("bar", [two[0]!], { time: false }).ok).toBe(false);
    expect(
      chartFit(
        "bar",
        two.map((p) => ({ ...p, value: 0 })),
        { time: false },
      ).ok,
    ).toBe(false);
    expect(chartFit("bar", [], { time: false }).ok).toBe(false);
    expect(chartFit("pie", [...two, { label: "x", value: -1, order: 0 }], { time: false }).ok).toBe(
      false,
    );
  });
});

describe("a custom report as a chart", () => {
  it("defaults to the table", () => {
    const out = shapeCustomResult(blankDefinition("jobs"), jobs, lookups);
    expect(out.chart).toBeNull();
  });

  it("breaks down by state when asked", () => {
    const def = {
      ...blankDefinition("jobs"),
      view: {
        mode: "chart" as const,
        kind: "bar" as const,
        groupBy: "region",
        measure: "billed_amount",
      },
    };
    const { chart, note } = buildCustomChart(def, jobs, lookups);
    expect(note).toBeNull();
    expect(chart!.data.map((d) => [d.label, d.value])).toEqual([
      ["NY", 200],
      ["NJ", 150],
    ]);
    expect(chart!.fmt).toBe("usd");
  });

  it("says why instead of drawing", () => {
    const def = {
      ...blankDefinition("jobs"),
      view: { mode: "chart" as const, kind: "line" as const, groupBy: "region" },
    };
    const out = shapeCustomResult(def, jobs, lookups);
    expect(out.chart).toBeNull();
    expect(out.chartNote).toMatch(/time axis/);
  });
});

describe("preset charts", () => {
  it("switch only to kinds their shape allows", () => {
    const byOffice = {
      kind: "bar" as const,
      xKey: "office",
      data: [
        { office: "LW", billed: 1 },
        { office: "BK", billed: 2 },
      ],
      series: [{ key: "billed", label: "Billed", color: "x" }],
    };
    expect(presetChartKinds(byOffice)).toEqual(["bar", "pie"]);
    const twoSeries = {
      ...byOffice,
      series: [...byOffice.series, { key: "b", label: "b", color: "y" }],
    };
    expect(presetChartKinds(twoSeries)).toEqual(["bar"]);
    const monthly = {
      ...byOffice,
      xKey: "m",
      data: [
        { m: "2026-08", billed: 1 },
        { m: "2026-09", billed: 2 },
      ],
    };
    expect(presetChartKinds(monthly)).toContain("line");
  });
});

describe("the palette", () => {
  const CSS = readFileSync("src/styles.css", "utf8");
  it("is declared for both themes, and is not the loss colors", () => {
    expect(CSS.match(/--viz-1:/g)).toHaveLength(2);
    expect(CSS).toContain("--viz-1: #2a78d6;");
    expect(CSS).toContain("--viz-1: #3987e5;");
    const src = readFileSync("src/lib/report-charts.ts", "utf8");
    expect(src).not.toMatch(/var\(--chart-\d\)/);
  });
});
