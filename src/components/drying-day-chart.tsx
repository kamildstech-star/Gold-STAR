import { useMemo } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  DRYING_CHART_SERIES,
  buildDryingChartRows,
  formatChartFigure,
  panelAxis,
  seriesForPanel,
  type DryingChartPanel,
  type DryingChartRow,
  type DryingChartSeries,
} from "@/lib/drying-day-chart";
import type { DryingDayTile } from "@/lib/drying-day-grid";

/**
 * The line chart in the right third of the Days card. Mark, 2026-10-06:
 * "shrink this to 2/3 size and have the last 1/3 show a line graph, one line
 * color for each reading."
 *
 * Fed the squares' own tiles, so it covers the same days in the same order and
 * quotes the same figure for each; the series, colours, gaps and axis ranges
 * are decided in src/lib/drying-day-chart.ts and tested there. This file only
 * draws them.
 *
 * Two stacked panels over the same days — degrees above, RH below — rather
 * than one chart with a °F axis on the left and a % axis on the right. On a
 * dual-axis chart the point where the RH line crosses a temperature line is an
 * artefact of the axis limits that reads like an event, and a crew comparing
 * inside dew to outside dew should not have to work out which axis a line
 * belongs to. The reasoning is written out beside DryingChartPanel.
 */

/** "Sep 28" — the squares' own format, so the axis and the strip match. */
function dayLabel(iso: string, isToday: boolean): string {
  if (isToday) return "Today";
  const d = new Date(`${iso}T12:00:00Z`);
  return d.toLocaleDateString("en-US", { day: "numeric", month: "short", timeZone: "UTC" });
}

const PANELS: { panel: DryingChartPanel; title: string; tickUnit: string; height: number }[] = [
  // Five lines live in the degrees panel and two in RH, so it gets the room.
  { panel: "degrees", title: "Temp & dew, °F", tickUnit: "°", height: 168 },
  { panel: "rh", title: "Relative humidity, %", tickUnit: "%", height: 116 },
];

/** Short names, the square's own words: "Out temp", "In RH", "Affected dew". */
function shortName(s: DryingChartSeries): string {
  return s.side == null
    ? s.quantity
    : `${s.side} ${s.quantity === "Temp" ? "temp" : s.quantity === "Dew" ? "dew" : "RH"}`;
}

function Swatch({ series }: { series: DryingChartSeries }) {
  return (
    <svg width="18" height="8" viewBox="0 0 18 8" aria-hidden className="shrink-0">
      <line
        x1="1"
        y1="4"
        x2="17"
        y2="4"
        stroke={series.color}
        strokeWidth={series.emphasis ? 3 : 2}
        strokeDasharray={series.dashed ? "4 2.5" : undefined}
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * The day's figures, exactly, with units. The same Out/In × Temp/RH/Dew table
 * the square prints, so hovering a day on the chart reads like tapping its
 * square. Text stays in text colours; the swatch beside each figure carries
 * which line it is.
 */
function DayReadout({ row }: { row: DryingChartRow }) {
  const by = (key: DryingChartSeries["key"]) => DRYING_CHART_SERIES.find((s) => s.key === key)!;
  const state =
    row.status === "entered"
      ? "logged"
      : row.status === "weather_only"
        ? "outside only — no crew reading"
        : "nothing logged";
  const cell = (key: DryingChartSeries["key"]) => {
    const s = by(key);
    return (
      <span className="flex items-center justify-end gap-1">
        <Swatch series={s} />
        <span className="font-medium text-foreground">{formatChartFigure(row[key], s.unit)}</span>
      </span>
    );
  };
  return (
    <div className="min-w-44 rounded-md border bg-popover px-2.5 py-2 text-[11px] leading-snug text-popover-foreground shadow-md">
      <p className="mb-1 font-medium">
        {dayLabel(row.date, row.isToday)}
        <span className="ml-1.5 font-normal text-muted-foreground">{state}</span>
      </p>
      <div className="grid grid-cols-[auto_1fr_1fr] items-center gap-x-2 gap-y-0.5 whitespace-nowrap tabular-nums text-muted-foreground">
        <span />
        <span className="text-right">Out</span>
        <span className="text-right">In</span>
        <span>Temp</span>
        {cell("outTemp")}
        {cell("inTemp")}
        <span>RH</span>
        {cell("outRh")}
        {cell("inRh")}
        <span>Dew</span>
        {cell("outDew")}
        {cell("inDew")}
        <span className="col-span-2">Affected dew</span>
        {cell("affectedDew")}
      </div>
      {row.outsideModelled && (
        <p className="mt-1 text-[10px] text-muted-foreground">
          {row.outsideStation
            ? `Outside figures were measured at NWS station ${row.outsideStation}, not on site.`
            : "Outside figures are from the weather model, not a meter."}
        </p>
      )}
    </div>
  );
}

function ChartPanel({
  rows,
  panel,
  title,
  tickUnit,
  height,
}: {
  rows: DryingChartRow[];
  panel: DryingChartPanel;
  title: string;
  tickUnit: string;
  height: number;
}) {
  const series = seriesForPanel(panel);
  const axis = panelAxis(rows, panel);
  const byDate = useMemo(() => new Map(rows.map((r) => [r.date, r])), [rows]);
  return (
    <div className="min-w-0 space-y-1">
      <p className="text-[11px] font-medium text-muted-foreground">{title}</p>
      {/* The legend names every line in the square's own words. Outside is
          dashed and inside solid, so a pair is told apart by more than its
          shade — on a printout or to a colour-blind reader. */}
      <ul className="flex flex-wrap gap-x-2.5 gap-y-0.5 text-[10px] text-muted-foreground">
        {series.map((s) => (
          <li key={s.key} className="flex items-center gap-1 whitespace-nowrap">
            <Swatch series={s} />
            <span className={s.emphasis ? "font-medium text-foreground" : undefined}>
              {shortName(s)}
            </span>
          </li>
        ))}
      </ul>
      {axis == null ? (
        <p
          className="flex items-center justify-center rounded-md border border-dashed text-[11px] text-muted-foreground"
          style={{ height }}
        >
          No readings to draw yet
        </p>
      ) : (
        <ResponsiveContainer width="100%" height={height}>
          <LineChart data={rows} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="2 2" stroke="var(--border)" vertical={false} />
            <XAxis
              dataKey="date"
              tickFormatter={(d: string) => dayLabel(d, byDate.get(d)?.isToday ?? false)}
              tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
              tickLine={false}
              axisLine={{ stroke: "var(--border)" }}
              interval="preserveStartEnd"
              minTickGap={6}
            />
            <YAxis
              domain={axis.domain}
              ticks={axis.ticks}
              tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
              tickFormatter={(v: number) => `${v}${tickUnit}`}
              width={34}
              tickLine={false}
              axisLine={false}
            />
            <Tooltip
              cursor={{ stroke: "var(--muted-foreground)", strokeDasharray: "2 2" }}
              content={({ active, label }) => {
                const row = active ? byDate.get(String(label ?? "")) : undefined;
                return row ? <DayReadout row={row} /> : null;
              }}
            />
            {series.map((s) => (
              <Line
                key={s.key}
                type="linear"
                dataKey={s.key}
                name={s.label}
                stroke={s.color}
                strokeWidth={s.emphasis ? 2.75 : 2}
                strokeDasharray={s.dashed ? "5 3" : undefined}
                /* A dot on every reading: with the line broken at a gap, a
                   reading with a missing day on each side would otherwise be
                   drawn as nothing at all. */
                dot={{
                  r: s.emphasis ? 3 : 2.5,
                  fill: s.color,
                  stroke: "var(--card)",
                  strokeWidth: 1,
                }}
                activeDot={{ r: 4, fill: s.color, stroke: "var(--card)", strokeWidth: 1.5 }}
                /* Left broken on purpose. A day nobody read is the day a
                   carrier refuses equipment for; a line drawn across it claims
                   a reading that was never taken. */
                connectNulls={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

export function DryingDayChart({ tiles }: { tiles: DryingDayTile[] }) {
  const rows = useMemo(() => buildDryingChartRows(tiles), [tiles]);
  return (
    <figure
      className="min-w-0 space-y-3"
      aria-label="The readings on the day squares, as lines over the same days. Every figure is also printed on its square."
    >
      {PANELS.map((p) => (
        <ChartPanel key={p.panel} rows={rows} {...p} />
      ))}
    </figure>
  );
}
