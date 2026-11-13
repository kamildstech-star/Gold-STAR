import { describe, expect, it } from "vitest";

import {
  DRYING_CHART_SERIES,
  buildDryingChartRows,
  formatChartFigure,
  panelAxis,
  panelHasData,
  seriesForPanel,
} from "@/lib/drying-day-chart";
import { buildDryingDayTiles } from "@/lib/drying-day-grid";
import { buildDryingLog, type DryingReading } from "@/lib/drying-log";

/**
 * Mark, 2026-10-06: "shrink this to 2/3 size and have the last 1/3 show a line
 * graph, one line color for each reading."
 *
 * Every date here is passed explicitly — to buildDryingLog AND to
 * buildDryingDayTiles — because both otherwise read the wall clock, and a
 * fixed date meeting Date.now() is a test that passes until the calendar moves.
 */
const TODAY = "2026-08-04";

let seq = 0;
function reading(over: Partial<DryingReading> & { reading_date: string }): DryingReading {
  seq += 1;
  return {
    id: `r${seq}`,
    job_id: "job-1",
    room_id: null,
    equipment_id: null,
    point: "affected",
    label: null,
    source: "manual",
    source_detail: null,
    temperature_f: 75,
    relative_humidity: 60,
    dew_point_f: 60,
    grains_per_pound: 78,
    notes: null,
    captured_at: `${over.reading_date}T15:00:00Z`,
    created_by: null,
    created_at: `${over.reading_date}T15:00:00Z`,
    updated_at: `${over.reading_date}T15:00:00Z`,
    is_demo: false,
    ...over,
  } as DryingReading;
}

/** Aug 1 fully read, Aug 2 outside only (the model), Aug 3 nothing, Aug 4 (today) inside only. */
function fixture() {
  const rows = [
    reading({ reading_date: "2026-08-01", point: "affected", dew_point_f: 66 }),
    reading({
      reading_date: "2026-08-01",
      point: "interior",
      temperature_f: 78,
      relative_humidity: 64,
      dew_point_f: 65,
    }),
    reading({
      reading_date: "2026-08-01",
      point: "exterior",
      temperature_f: 70,
      relative_humidity: 80,
      dew_point_f: 63.5,
    }),
    reading({
      reading_date: "2026-08-02",
      point: "exterior",
      source: "weather",
      temperature_f: 68,
      relative_humidity: 82,
      dew_point_f: 62.4,
    }),
    reading({
      reading_date: "2026-08-04",
      point: "interior",
      temperature_f: 76,
      relative_humidity: 50,
      dew_point_f: 56,
    }),
  ];
  const tiles = buildDryingDayTiles(buildDryingLog(rows, { today: TODAY }), TODAY);
  return { tiles, rows: buildDryingChartRows(tiles) };
}

describe("the chart is drawn from the squares", () => {
  it("has one row per square, same days, same order, today included", () => {
    const { tiles, rows } = fixture();
    expect(rows.map((r) => r.date)).toEqual(tiles.map((t) => t.date));
    expect(rows.map((r) => r.date)).toEqual([
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
      "2026-08-04",
    ]);
    expect(rows.map((r) => r.isToday)).toEqual([false, false, false, true]);
  });

  it("quotes the square's own figures, field for field", () => {
    const { tiles, rows } = fixture();
    rows.forEach((row, i) => {
      const t = tiles[i]!;
      expect(row).toMatchObject({
        outTemp: t.outsideTempF,
        inTemp: t.insideTempF,
        outDew: t.outsideDewPoint,
        inDew: t.insideDewPoint,
        affectedDew: t.affectedDewPoint,
        outRh: t.outsideRh,
        inRh: t.insideRh,
        status: t.status,
        outsideModelled: t.outsideModelled,
      });
    });
    expect(rows[0]).toMatchObject({ inTemp: 78, inRh: 64, inDew: 65, affectedDew: 66 });
    expect(rows[0]).toMatchObject({ outTemp: 70, outRh: 80, outDew: 63.5 });
  });

  it("follows a square that is today and has no reading yet", () => {
    const tiles = buildDryingDayTiles(buildDryingLog([], { today: TODAY }), TODAY);
    const rows = buildDryingChartRows(tiles);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.date).toBe(TODAY);
    expect(panelHasData(rows, "degrees")).toBe(false);
    expect(panelHasData(rows, "rh")).toBe(false);
    expect(panelAxis(rows, "degrees")).toBeNull();
  });
});

describe("gaps stay gaps", () => {
  it("leaves a day nobody read as null on every line — never zero", () => {
    const { rows } = fixture();
    const aug3 = rows.find((r) => r.date === "2026-08-03")!;
    expect(aug3.status).toBe("empty");
    for (const s of DRYING_CHART_SERIES) expect(aug3[s.key]).toBeNull();
  });

  it("leaves the inside null on an outside-only day, and the outside null on an inside-only day", () => {
    const { rows } = fixture();
    const aug2 = rows.find((r) => r.date === "2026-08-02")!;
    expect(aug2).toMatchObject({ inTemp: null, inRh: null, inDew: null, affectedDew: null });
    expect(aug2).toMatchObject({ outTemp: 68, outRh: 82, outDew: 62.4, outsideModelled: true });
    const aug4 = rows.find((r) => r.date === "2026-08-04")!;
    expect(aug4).toMatchObject({ outTemp: null, outRh: null, outDew: null, affectedDew: null });
    expect(aug4).toMatchObject({ inTemp: 76, inRh: 50, inDew: 56 });
  });

  it("does not interpolate: the value either side of a gap is untouched", () => {
    const { rows } = fixture();
    expect(rows.map((r) => r.inDew)).toEqual([65, null, null, 56]);
    expect(rows.map((r) => r.outDew)).toEqual([63.5, 62.4, null, null]);
  });

  it("prints a missing figure as a dash in the tooltip, not as 0", () => {
    expect(formatChartFigure(null, "°F")).toBe("—");
    expect(formatChartFigure(null, "%")).toBe("—");
    expect(formatChartFigure(59.4, "°F")).toBe("59.4 °F");
    expect(formatChartFigure(0, "°F")).toBe("0 °F");
    expect(formatChartFigure(80, "%")).toBe("80%");
  });
});

describe("one line, one colour, per reading", () => {
  it("draws all seven readings: out/in temp, RH and dew, and affected dew", () => {
    expect(DRYING_CHART_SERIES.map((s) => s.key)).toEqual([
      "outTemp",
      "inTemp",
      "outDew",
      "inDew",
      "affectedDew",
      "outRh",
      "inRh",
    ]);
  });

  it("gives every series its own color", () => {
    const colours = DRYING_CHART_SERIES.map((s) => s.color);
    expect(new Set(colours).size).toBe(DRYING_CHART_SERIES.length);
  });

  it("keeps each outside/inside pair in one family: same hue, outside shaded and dashed", () => {
    for (const q of ["Temp", "Dew", "RH"] as const) {
      const out = DRYING_CHART_SERIES.find((s) => s.quantity === q && s.side === "Out")!;
      const inn = DRYING_CHART_SERIES.find((s) => s.quantity === q && s.side === "In")!;
      expect(out.dashed).toBe(true);
      expect(inn.dashed).toBe(false);
      // The inside hue is the token; the outside is that same token mixed.
      expect(inn.color).toMatch(/^var\(--viz-\d\)$/);
      expect(out.color).toContain(inn.color);
      expect(out.color).toMatch(/^color-mix\(/);
    }
  });

  it("uses the validated report palette, not the loss-type --chart-* colors", () => {
    for (const s of DRYING_CHART_SERIES) {
      expect(s.color).toContain("var(--viz-");
      expect(s.color).not.toContain("--chart-");
    }
  });

  it("draws affected dew solid and heaviest — it is the figure the claim turns on", () => {
    const affected = DRYING_CHART_SERIES.filter((s) => s.emphasis);
    expect(affected.map((s) => s.key)).toEqual(["affectedDew"]);
    expect(affected[0]!.dashed).toBe(false);
  });
});

describe("degrees and RH never share an axis", () => {
  it("puts temperature and dew on the degrees panel and RH on its own", () => {
    expect(seriesForPanel("degrees").map((s) => s.key)).toEqual([
      "outTemp",
      "inTemp",
      "outDew",
      "inDew",
      "affectedDew",
    ]);
    expect(seriesForPanel("rh").map((s) => s.key)).toEqual(["outRh", "inRh"]);
    for (const s of seriesForPanel("degrees")) expect(s.unit).toBe("°F");
    for (const s of seriesForPanel("rh")) expect(s.unit).toBe("%");
  });

  it("ranges each panel on its own readings, with air, on evenly spaced round ticks", () => {
    const { rows } = fixture();
    // Degrees run 56 … 78.
    expect(panelAxis(rows, "degrees")).toEqual({ domain: [50, 80], ticks: [50, 60, 70, 80] });
    // RH runs 50 … 82.
    expect(panelAxis(rows, "rh")).toEqual({ domain: [40, 100], ticks: [40, 60, 80, 100] });
  });

  it("never runs RH past 100% or below 0%", () => {
    const tiles = buildDryingDayTiles(
      buildDryingLog(
        [
          reading({ reading_date: TODAY, point: "interior", relative_humidity: 99 }),
          reading({ reading_date: TODAY, point: "exterior", relative_humidity: 1 }),
        ],
        { today: TODAY },
      ),
      TODAY,
    );
    expect(panelAxis(buildDryingChartRows(tiles), "rh")).toEqual({
      domain: [0, 100],
      ticks: [0, 50, 100],
    });
  });

  it("gives a panel with one flat reading a range, not a zero-height axis", () => {
    const tiles = buildDryingDayTiles(
      buildDryingLog([reading({ reading_date: TODAY, point: "interior", relative_humidity: 50 })], {
        today: TODAY,
      }),
      TODAY,
    );
    const axis = panelAxis(buildDryingChartRows(tiles), "rh")!;
    expect(axis.domain[1]).toBeGreaterThan(axis.domain[0]);
    expect(axis.ticks[0]).toBe(axis.domain[0]);
    expect(axis.ticks.at(-1)).toBe(axis.domain[1]);
  });
});
