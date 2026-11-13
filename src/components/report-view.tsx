import { totalsColumns } from "@/lib/report-totals";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { delta } from "@/lib/period";
import { downloadCsv } from "@/lib/reports";
import { useExportGate } from "@/lib/export-guard";
import { ExportExcelButton } from "@/components/export-excel-button";
import type { ExportColumn, ExportValue } from "@/lib/export-table";
import type { Col, Fmt, Kpi, ReportDef, ReportResult } from "@/lib/reports-engine";
import { ArrowDownRight, ArrowRight, ArrowUpRight, Download, Info } from "lucide-react";
import { FitText } from "@/components/ui/fit-text";
import { presetChartKinds, type ChartKind } from "@/lib/report-charts";
import type { ChartSpec } from "@/lib/reports-engine";

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

const usd0 = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const usd2 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/**
 * The Excel export carries the report's own column typing: money stays a
 * number with a currency format, percentages stay fractions with a % format,
 * and counts stay counts — so the sheet sorts and sums the way the screen does.
 */
export function reportExportColumns(cols: Col[]): ExportColumn<Record<string, unknown>>[] {
  const typeOf = (fmt: Fmt | undefined) => {
    switch (fmt) {
      case "usd":
      case "usd0":
        return "money" as const;
      case "pct":
        return "percent" as const;
      case "int":
      case "days":
      case "mins":
        return "number" as const;
      default:
        return undefined;
    }
  };
  return cols.map((c) => ({
    key: c.key,
    label: c.label,
    type: typeOf(c.fmt),
    get: (r) => exportValue(c.get(r)),
  }));
}

function exportValue(v: unknown): ExportValue {
  if (v == null) return null;
  if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") return v;
  if (v instanceof Date) return v;
  return String(v);
}

export function fmtValue(v: unknown, fmt: Fmt = "text"): string {
  if (v == null || v === "") return "—";
  if (fmt === "text") return String(v);
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  switch (fmt) {
    case "usd":
      return usd2.format(n);
    case "usd0":
      return usd0.format(n);
    case "pct":
      return `${(n * 100).toFixed(n < 0.1 && n > 0 ? 1 : 0)}%`;
    case "days":
      return `${n.toFixed(n < 10 ? 1 : 0)} d`;
    case "mins":
      return `${Math.round(n)} min`;
    case "int":
    default:
      return Math.round(n).toLocaleString("en-US");
  }
}

/* ------------------------------------------------------------------ */
/* KPI strip — never a bare number                                     */
/* ------------------------------------------------------------------ */

function DeltaBadge({ kpi }: { kpi: Kpi }) {
  const d = delta(kpi.value, kpi.prev);
  if (d.direction === "none") {
    return (
      <span className="text-[11px] text-muted-foreground">
        {kpi.prev == null ? "no comparison" : "—"}
      </span>
    );
  }
  if (d.direction === "flat") {
    return (
      <span className="inline-flex items-center gap-0.5 text-[11px] text-muted-foreground">
        <ArrowRight className="h-3 w-3" />
        flat
      </span>
    );
  }
  const rising = d.direction === "up";
  const good = kpi.goodDown ? !rising : rising;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 text-[11px] tabular-nums",
        good ? "text-success" : "text-destructive",
      )}
      title={`Comparison period: ${fmtValue(kpi.prev, kpi.fmt)}`}
    >
      {rising ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
      {d.pct == null ? fmtValue(d.abs, kpi.fmt) : `${rising ? "+" : ""}${Math.round(d.pct * 100)}%`}
    </span>
  );
}

export function KpiStrip({ kpis }: { kpis: Kpi[] }) {
  if (!kpis.length) return null;
  return (
    <div className="metric-strip divide-x">
      {kpis.map((k) => (
        <div key={k.label} className="min-w-[132px] flex-1 px-3 py-2">
          <div className="label-caps text-muted-foreground">{k.label}</div>
          <div className="flex items-baseline gap-1.5">
            <FitText className="display-heavy text-[20px] leading-tight tabular-nums">
              {fmtValue(k.value, k.fmt)}
            </FitText>
            <DeltaBadge kpi={k} />
          </div>
          <div className="text-[11px] text-muted-foreground">
            {k.note ? k.note : k.prev != null ? `vs ${fmtValue(k.prev, k.fmt)}` : "\u00a0"}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Report body: chart on top, its own table beneath                    */
/* ------------------------------------------------------------------ */

function CellValue({ col, row }: { col: Col; row: Record<string, unknown> }) {
  const raw = col.get(row);
  const text = fmtValue(raw, col.fmt);
  const link = col.link?.(row) ?? null;
  if (!link) return <>{text}</>;
  return (
    <Link
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      to={link.to as any}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      params={link.params as any}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      search={link.search as any}
      className="text-primary underline-offset-2 hover:underline"
    >
      {text}
    </Link>
  );
}

export function ReportView({
  report,
  result,
  loading,
  selectionLabel,
}: {
  report: ReportDef;
  result: ReportResult | null;
  loading: boolean;
  selectionLabel: string;
}) {
  const exportGate = useExportGate();
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2 px-1">
        <div>
          <h2 className="text-[15px] font-semibold">
            {/* A custom report has no preset number. */}
            {report.num > 0 ? (
              <span className="mr-1.5 tabular-nums text-muted-foreground">{report.num}.</span>
            ) : null}
            {report.title}
          </h2>
          <p className="text-xs text-muted-foreground">{report.question}</p>
        </div>
        {result && result.rows.length > 0 && exportGate.allowed && (
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void exportGate.runExport({
                  surface: "reports",
                  entity: report.id,
                  recordCount: result.rows.length,
                  filters: { report: report.id },
                  download: () =>
                    downloadCsv(
                      `${report.id}-${new Date().toISOString().slice(0, 10)}.csv`,
                      // Totals first — the top of the file, as on screen.
                      result.totals ? [result.totals, ...result.rows] : result.rows,
                      result.columns.map((c) => ({
                        key: c.key,
                        label: c.label,
                        get: (r: Record<string, unknown>) => {
                          const v = r === result.totals ? r[c.key] : c.get(r);
                          return v == null ? "" : v;
                        },
                      })),
                    ),
                })
              }
            >
              <Download className="mr-1.5 h-3.5 w-3.5" />
              CSV
            </Button>
            <ExportExcelButton
              report={report.id}
              surface="reports"
              entity={report.id}
              filters={{ report: report.id }}
              sheets={[
                {
                  name: report.title,
                  rows: result.rows,
                  columns: reportExportColumns(result.columns),
                  totals: result.totals ?? null,
                  totalsColumns: result.totals
                    ? reportExportColumns(totalsColumns(result.columns))
                    : undefined,
                },
              ]}
            />
          </div>
        )}
        {result && result.rows.length > 0 && !exportGate.allowed && (
          <span className="max-w-[280px] text-right text-[11px] text-muted-foreground">
            {exportGate.reason}
          </span>
        )}
      </div>

      {loading && <div className="px-1 py-8 text-sm text-muted-foreground">Running report…</div>}

      {!loading && result?.empty && (
        <div className="flex items-start gap-2 rounded-md border border-dashed bg-muted/30 px-3 py-4">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="space-y-1">
            <p className="text-sm font-medium">No data for {selectionLabel}</p>
            <p className="text-xs text-muted-foreground">{result.empty}</p>
          </div>
        </div>
      )}

      {!loading && result && !result.empty && (
        <>
          <KpiStrip kpis={result.kpis} />

          {result.chart && result.chart.data.length > 0 ? (
            <ReportChart
              key={report.id}
              spec={result.chart}
              // A custom report picks its kind in its own controls.
              lockKind={report.num <= 0}
            />
          ) : result.chartNote ? (
            /* A chart was asked for and the data cannot honestly make one. */
            <div className="flex items-start gap-2 rounded-md border border-dashed bg-muted/30 px-3 py-3 text-xs text-muted-foreground">
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
              <p>{result.chartNote}</p>
            </div>
          ) : null}

          {/*
            Frozen header (David, 21 Oct): the table scrolls inside its own
            box, so the sticky TableHeader — and the totals row riding in it —
            stays put while the jobs scroll beneath. Below md the header is
            static (ui/table) and the page scrolls as before.
          */}
          <div className="overflow-x-auto rounded-md border bg-card md:max-h-[75svh] md:overflow-auto [--table-sticky-top:0px]">
            <Table>
              <TableHeader>
                <TableRow>
                  {result.columns.map((c) => (
                    <TableHead key={c.key} className={c.num ? "text-right" : undefined}>
                      {c.label}
                    </TableHead>
                  ))}
                </TableRow>
                {result.totals ? (
                  <TableRow className="bg-muted/70 font-semibold" data-report-totals>
                    {totalsColumns(result.columns).map((c) => (
                      <TableCell
                        key={c.key}
                        className={c.num ? "text-right tabular-nums" : undefined}
                      >
                        {result.totals![c.key] == null
                          ? ""
                          : fmtValue(result.totals![c.key], c.fmt)}
                      </TableCell>
                    ))}
                  </TableRow>
                ) : null}
              </TableHeader>
              <TableBody>
                {result.rows.map((row, i) => (
                  <TableRow key={String(row.id ?? row.userId ?? i)}>
                    {result.columns.map((c) => (
                      <TableCell
                        key={c.key}
                        className={c.num ? "text-right tabular-nums" : undefined}
                      >
                        <CellValue col={c} row={row} />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <p className="px-1 text-[11px] text-muted-foreground">{report.populatedBy}</p>
        </>
      )}
    </div>
  );
}

const tooltipStyle = {
  fontSize: 12,
  borderRadius: 3,
  border: "1px solid var(--border)",
  background: "var(--popover)",
  color: "var(--popover-foreground)",
};

/**
 * One chart, three shapes. David, 22 Sep: "can the reports be set in charts
 * also... different type of charts". A preset keeps the chart it always drew
 * and gains the kinds its shape allows (presetChartKinds); a custom report's
 * kind was chosen in the builder and arrives on the spec.
 *
 * Marks stay thin and recessive: 2px lines, bars with a surface gap, pie
 * slices ringed in the surface color, values in text ink — never the series
 * color. A pie always lists its slices with their values, because three of
 * the palette's light-mode slots sit under 3:1 against the card.
 */
function ReportChart({ spec, lockKind }: { spec: ChartSpec; lockKind?: boolean }) {
  const kinds: ChartKind[] =
    lockKind || spec.kind === "pie" || spec.kind === "line" ? [spec.kind] : presetChartKinds(spec);
  const [kind, setKind] = useState<ChartKind>(spec.kind);
  const shown: ChartKind = kinds.includes(kind) ? kind : spec.kind;
  const many = spec.data.length > 6;
  const fmt = (v: unknown) => fmtValue(v, spec.fmt);
  const oneSeries = spec.series.length === 1;

  const axes = (
    <>
      <CartesianGrid strokeDasharray="2 2" stroke="var(--border)" vertical={false} />
      <XAxis
        dataKey={spec.xKey}
        tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
        interval={0}
        angle={many ? -20 : 0}
        textAnchor={many ? "end" : "middle"}
        height={many ? 56 : 28}
        tickLine={false}
      />
      <YAxis
        tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
        tickFormatter={(v) => fmt(v)}
        width={72}
        tickLine={false}
        axisLine={false}
      />
      {/* recharts 3 sorts tooltip rows and legend items by name by default;
          keep them in the report's own series order. */}
      <Tooltip contentStyle={tooltipStyle} formatter={(v) => fmt(v)} itemSorter={() => 0} />
      {/* One series: the title names it, so no legend box. */}
      {oneSeries ? null : <Legend wrapperStyle={{ fontSize: 11 }} itemSorter={null} />}
    </>
  );

  return (
    <div className="rounded-md border bg-card p-2" data-report-chart={shown}>
      {kinds.length > 1 ? (
        <div className="mb-1 flex justify-end gap-1" role="group" aria-label="Chart type">
          {kinds.map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={shown === k}
              onClick={() => setKind(k)}
              className={cn(
                "min-h-9 rounded-md border px-2 text-xs capitalize",
                shown === k
                  ? "border-primary bg-primary text-primary-foreground"
                  : "hover:bg-accent",
              )}
            >
              {k}
            </button>
          ))}
        </div>
      ) : null}
      {shown === "pie" ? (
        <div className="grid items-center gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,14rem)]">
          <ResponsiveContainer width="100%" height={260}>
            <PieChart>
              <Tooltip contentStyle={tooltipStyle} formatter={(v) => fmt(v)} />
              <Pie
                data={spec.data}
                dataKey={spec.series[0]!.key}
                nameKey={spec.xKey}
                innerRadius="45%"
                outerRadius="80%"
                stroke="var(--card)"
                strokeWidth={2}
                isAnimationActive={false}
              >
                {spec.data.map((d, i) => (
                  <Cell key={i} fill={String(d.fill ?? spec.series[0]!.color)} />
                ))}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
          <ul className="space-y-1 text-xs" aria-label="Slices">
            {spec.data.map((d, i) => (
              <li key={i} className="flex items-center gap-2">
                <span
                  aria-hidden
                  className="size-2.5 shrink-0 rounded-sm"
                  style={{ background: String(d.fill ?? spec.series[0]!.color) }}
                />
                <span className="min-w-0 flex-1 truncate">{String(d[spec.xKey])}</span>
                <span className="tabular-nums text-muted-foreground">
                  {fmt(d[spec.series[0]!.key])}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={260}>
          {shown === "line" ? (
            <LineChart data={spec.data} margin={{ top: 8, right: 8, left: 0, bottom: 4 }}>
              {axes}
              {spec.series.map((s) => (
                <Line
                  key={s.key}
                  type="monotone"
                  dataKey={s.key}
                  name={s.label}
                  stroke={s.color}
                  strokeWidth={2}
                  dot={{ r: 4, strokeWidth: 2, stroke: "var(--card)" }}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          ) : (
            <BarChart data={spec.data} margin={{ top: 8, right: 8, left: 0, bottom: 4 }}>
              {axes}
              {spec.series.map((s) => (
                <Bar
                  key={s.key}
                  dataKey={s.key}
                  name={s.label}
                  fill={s.color}
                  stackId={spec.stacked ? "a" : undefined}
                  radius={[4, 4, 0, 0]}
                  maxBarSize={44}
                  stroke="var(--card)"
                  strokeWidth={2}
                />
              ))}
            </BarChart>
          )}
        </ResponsiveContainer>
      )}
    </div>
  );
}
