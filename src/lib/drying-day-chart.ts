import type { DryingDayTile, DryingTileStatus } from "./drying-day-grid";

/**
 * The line chart beside the day squares.
 *
 * Mark, 2026-10-06, on a job's drying log, looking at the Days card: "shrink
 * this to 2/3 size and have the last 1/3 show a line graph, one line color for
 * each reading."
 *
 * The squares answer "what did we read on the 30th"; a line answers "is it
 * drying", which is a question about the shape of a week, not a day. So the
 * chart is built from the SAME tiles the squares are drawn from — same days,
 * same order, the same figure on each — and never from its own read of the log.
 * If the two ever disagreed, a carrier would be shown a chart and a square that
 * quote different numbers for the same day.
 *
 * GAPS ARE NULL, NEVER ZERO AND NEVER BRIDGED. A day nobody read the inside is
 * the day a carrier refuses to pay equipment for, and the strip already says
 * so in words. A line drawn straight across that day claims a reading nobody
 * took; a line that dives to 0° claims a reading that would have frozen the
 * pipes. Every value below is copied from the tile or left null.
 */

export type DryingChartSeriesKey =
  "outTemp" | "inTemp" | "outDew" | "inDew" | "affectedDew" | "outRh" | "inRh";

/**
 * Two panels, not two y-axes. Temperature and dew point are degrees; relative
 * humidity is a percentage. On one chart with a °F axis on the left and a %
 * axis on the right, the place where the RH line crosses the temperature line
 * looks like an event and means nothing — the two scales were lined up by
 * whoever picked the axis limits. Stacked panels over the same days keep each
 * line honest against its own unit, and the out/in comparison a crew actually
 * makes (inside dew falling towards outside dew) is within one panel.
 */
export type DryingChartPanel = "degrees" | "rh";

export type DryingChartSeries = {
  key: DryingChartSeriesKey;
  /** The figure's row on the square: Temp / RH / Dew, or Affected dew. */
  quantity: "Temp" | "RH" | "Dew" | "Affected dew";
  /** The column on the square, or null for affected dew, which has none. */
  side: "Out" | "In" | null;
  /** The whole name, for the tooltip and the accessible label. */
  label: string;
  panel: DryingChartPanel;
  unit: "°F" | "%";
  /** A CSS colour, built from the app's validated --viz-* tokens. */
  color: string;
  /** Outside is dashed: the second encoding, so the pair is not told apart by colour alone. */
  dashed: boolean;
  /** Affected dew is the figure the claim turns on, so it is drawn heaviest. */
  emphasis: boolean;
};

/*
 * One colour per reading, as asked, with each outside/inside pair visibly the
 * same family: the inside line is the hue itself, the outside line the same hue
 * mixed a third of the way towards the page's ink, AND dashed. Mixing towards
 * the ink rather than the paper keeps the outside line's contrast in every
 * theme — towards white it would fade in light mode, towards the dark card it
 * would vanish in dark mode.
 *
 * The hues are the report palette (--viz-*, styles.css), stepped separately for
 * light and dark and already checked for colour-vision deficiency — not the
 * --chart-* tokens, which are the loss-type colours, where an orange line would
 * read as "fire". Within the degrees panel the three hues (orange, blue, green)
 * pass the dataviz validator on every pair, both themes; RH is alone in its
 * panel, so its pink never has to be told apart from the orange.
 */
const HUE = {
  temp: "var(--viz-2)",
  dew: "var(--viz-1)",
  rh: "var(--viz-5)",
  affected: "var(--viz-3)",
} as const;

function outsideShade(hue: string): string {
  return `color-mix(in oklab, ${hue} 65%, var(--foreground))`;
}

/** Fixed order: the square's own reading order, Temp, Dew, then RH, then the chamber. */
export const DRYING_CHART_SERIES: readonly DryingChartSeries[] = [
  {
    key: "outTemp",
    quantity: "Temp",
    side: "Out",
    label: "Outside temp",
    panel: "degrees",
    unit: "°F",
    color: outsideShade(HUE.temp),
    dashed: true,
    emphasis: false,
  },
  {
    key: "inTemp",
    quantity: "Temp",
    side: "In",
    label: "Inside temp",
    panel: "degrees",
    unit: "°F",
    color: HUE.temp,
    dashed: false,
    emphasis: false,
  },
  {
    key: "outDew",
    quantity: "Dew",
    side: "Out",
    label: "Outside dew point",
    panel: "degrees",
    unit: "°F",
    color: outsideShade(HUE.dew),
    dashed: true,
    emphasis: false,
  },
  {
    key: "inDew",
    quantity: "Dew",
    side: "In",
    label: "Inside dew point",
    panel: "degrees",
    unit: "°F",
    color: HUE.dew,
    dashed: false,
    emphasis: false,
  },
  {
    key: "affectedDew",
    quantity: "Affected dew",
    side: null,
    label: "Affected dew point (wettest room)",
    panel: "degrees",
    unit: "°F",
    color: HUE.affected,
    dashed: false,
    emphasis: true,
  },
  {
    key: "outRh",
    quantity: "RH",
    side: "Out",
    label: "Outside RH",
    panel: "rh",
    unit: "%",
    color: outsideShade(HUE.rh),
    dashed: true,
    emphasis: false,
  },
  {
    key: "inRh",
    quantity: "RH",
    side: "In",
    label: "Inside RH",
    panel: "rh",
    unit: "%",
    color: HUE.rh,
    dashed: false,
    emphasis: false,
  },
];

export type DryingChartRow = {
  /** ISO date, the x value — the same key the square is drawn under. */
  date: string;
  isToday: boolean;
  status: DryingTileStatus;
  /** The outside figures came from the weather model, not a meter. Said in the tooltip. */
  outsideModelled: boolean;
  /** The NWS station when that automatic figure is a station measurement. */
  outsideStation: string | null;
} & Record<DryingChartSeriesKey, number | null>;

/**
 * One row per square, in the squares' order. Copies figures; never fills one.
 */
export function buildDryingChartRows(tiles: readonly DryingDayTile[]): DryingChartRow[] {
  return tiles.map((t) => ({
    date: t.date,
    isToday: t.isToday,
    status: t.status,
    outsideModelled: t.outsideModelled,
    outsideStation: t.outsideStation ?? null,
    outTemp: t.outsideTempF,
    inTemp: t.insideTempF,
    outDew: t.outsideDewPoint,
    inDew: t.insideDewPoint,
    affectedDew: t.affectedDewPoint,
    outRh: t.outsideRh,
    inRh: t.insideRh,
  }));
}

export function seriesForPanel(panel: DryingChartPanel): DryingChartSeries[] {
  return DRYING_CHART_SERIES.filter((s) => s.panel === panel);
}

function panelValues(rows: readonly DryingChartRow[], panel: DryingChartPanel): number[] {
  const keys = seriesForPanel(panel).map((s) => s.key);
  const out: number[] = [];
  for (const row of rows) {
    for (const k of keys) {
      const v = row[k];
      if (v != null && Number.isFinite(v)) out.push(v);
    }
  }
  return out;
}

export function panelHasData(rows: readonly DryingChartRow[], panel: DryingChartPanel): boolean {
  return panelValues(rows, panel).length > 0;
}

/**
 * The y axis for a panel: the readings with a little air, on a round step, and
 * the ticks on that step. Null when the panel has nothing to draw.
 *
 * Computed here rather than left to the chart library so the ticks are evenly
 * spaced numbers a person would say (the library, given a fixed range, will
 * happily print 45°, 60°, 85°), so it cannot drift between library versions,
 * and so RH stays inside 0–100 — an axis that runs to 105% invites the question
 * of how a room got wetter than water.
 */
const TICK_STEPS = [2, 5, 10, 20, 25, 50] as const;
/**
 * Ticks a panel has room for. The degrees panel is about 170px tall and takes
 * six; RH is about 115px, where six labels collide and the chart library
 * silently drops every other one — so it gets four.
 */
const MAX_INTERVALS: Record<DryingChartPanel, number> = { degrees: 5, rh: 3 };

export type PanelAxis = { domain: [number, number]; ticks: number[] };

export function panelAxis(
  rows: readonly DryingChartRow[],
  panel: DryingChartPanel,
): PanelAxis | null {
  const values = panelValues(rows, panel);
  if (values.length === 0) return null;
  let rawLo = Math.min(...values) - 2;
  let rawHi = Math.max(...values) + 2;
  if (panel === "rh") {
    rawLo = Math.max(0, rawLo);
    rawHi = Math.min(100, rawHi);
  }
  for (const step of TICK_STEPS) {
    const lo = Math.floor(rawLo / step) * step;
    let hi = Math.ceil(rawHi / step) * step;
    if (hi === lo) hi = lo + step;
    if ((hi - lo) / step > MAX_INTERVALS[panel]) continue;
    const ticks: number[] = [];
    for (let t = lo; t <= hi; t += step) ticks.push(t);
    return { domain: [lo, hi], ticks };
  }
  // Only reachable with a range wider than 250 units, which no reading is.
  return { domain: [Math.floor(rawLo), Math.ceil(rawHi)], ticks: [] };
}

/** "59.4 °F", "80%", or an em-dash for a day with no such reading. */
export function formatChartFigure(value: number | null, unit: "°F" | "%"): string {
  if (value == null) return "—";
  return unit === "%" ? `${value}%` : `${value} °F`;
}
