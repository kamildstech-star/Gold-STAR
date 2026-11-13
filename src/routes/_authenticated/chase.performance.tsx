import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  CalendarDays,
  ChevronDown,
  Clock,
  DollarSign,
  Download,
  Filter,
  Headphones,
  Info,
  Percent,
  Phone,
  SlidersHorizontal,
  UserPlus,
} from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { useAppContext, usePreviewOfficeScope } from "@/components/app-context";
import { CompetitorActivitySnapshot } from "@/components/chase/competitor-activity-snapshot";
import { useCan } from "@/lib/permissions";
import { ExportExcelButton } from "@/components/export-excel-button";
import type { ExportColumn } from "@/lib/export-table";
import { LiveMap, type LiveMapMarker } from "@/components/live-map";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { INCIDENT_TYPE_LABEL } from "@/lib/incidents";
import {
  byDayOfWeek,
  byHour,
  byKey,
  coachingInsights,
  dailyResponse,
  deltaPct,
  fetchPerformance,
  fmtMinutes,
  isSigned,
  perChaser,
  shortMoney,
  summary,
  weeklyResponse,
  type PerfIncident,
  exposureSplit,
  type ExposureSplit,
  fetchDispatchResponses,
  isChronicNoAction,
  type DispatchResponseRow,
} from "@/lib/chase-performance";
import { useChaseSettings } from "@/lib/chase-settings";
import { FitText } from "@/components/ui/fit-text";

export const Route = createFileRoute("/_authenticated/chase/performance")({
  head: () => ({
    meta: [
      { title: "Chase Performance · Recovery Hub" },
      {
        name: "description",
        content:
          "Chase operation performance: response time, competitor activity, channels and coaching.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: PerformancePage,
});

/* ---------------- tokens lifted from the mockup ---------------- */
const CARD =
  "rounded-[12px] border border-[var(--border)] bg-card shadow-[0_1px_2px_rgba(16,36,61,0.04)]";
const NAVY = "var(--foreground)";
const MUTED = "var(--muted-foreground)";
const BLUE = "var(--primary)";
const GREEN = "var(--success)";
const RED = "var(--destructive)";
const GRID = "var(--border)";

const RANGES = { "7d": 7, "14d": 14, "30d": 30, "90d": 90 } as const;
type RangeKey = keyof typeof RANGES;

const rangeLabel = (from: Date, to: Date) => {
  const f = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const end = new Date(to.getTime() - 86_400_000);
  return `${f(from)} – ${f(end)}, ${end.getFullYear()}`;
};

/* --------------------------------------------------------------- */

function PerformancePage() {
  // Management-only screen. Chasers never see response breakdowns or named
  // comparisons — they are sent to their own funnel instead.
  const office = useCan("chase.view_tracking");
  if (!office) return <Navigate to="/chase/my-performance" replace />;
  return <OfficePerformance />;
}

function OfficePerformance() {
  const app = useAppContext();
  /*
   * Both capabilities are read unconditionally. Written as
   * `useCan(a) || useCan(b)`, the second hook was skipped on every render
   * where the first returned true, so the hook order changed the moment a
   * user gained or lost commission.view — which is exactly when React
   * mismatches the hook state of this component.
   */
  const canViewCommission = useCan("commission.view");
  const canViewMargin = useCan("job.view_margin");
  const canMoney = canViewCommission || canViewMargin;
  const canExport = useCan("data.export");
  // View as person: "All Branches" means all of THEIR offices.
  const previewOffices = usePreviewOfficeScope();

  const [range, setRange] = useState<RangeKey>("7d");
  const [locId, setLocId] = useState("all");
  const [repId, setRepId] = useState("all");
  const [sourceKey, setSourceKey] = useState("all");
  const [trendMode, setTrendMode] = useState<"daily" | "weekly">("daily");
  const [channelMode, setChannelMode] = useState<"channel" | "department">("channel");
  const [hourMode, setHourMode] = useState<"hour" | "dow">("hour");

  const { from, to } = useMemo(() => {
    const end = new Date();
    end.setHours(0, 0, 0, 0);
    end.setDate(end.getDate() + 1);
    const start = new Date(end.getTime() - RANGES[range] * 86_400_000);
    return { from: start, to: end };
  }, [range]);

  const q = useQuery({
    queryKey: ["chase-perf", range, locId],
    queryFn: () => fetchPerformance(from, to, locId === "all" ? null : locId),
  });

  const { settings } = useChaseSettings();
  const responsesQ = useQuery({
    queryKey: ["chase-dispatch-responses", range, locId],
    queryFn: () => fetchDispatchResponses(from, to, locId === "all" ? null : locId),
  });
  const responses = useMemo(
    () => (responsesQ.data ?? []).filter((r) => repId === "all" || r.userId === repId),
    [responsesQ.data, repId],
  );

  const bundle = q.data;
  const rowsAll = bundle?.current ?? [];
  const rows = useMemo(
    () =>
      rowsAll.filter(
        (r) =>
          (repId === "all" || r.accepted_by === repId) &&
          (sourceKey === "all" || r.source === sourceKey),
      ),
    [rowsAll, repId, sourceKey],
  );
  const prev = bundle?.previous ?? [];

  const cur = summary(rows);
  const before = summary(prev);
  const chasers = perChaser(rows, bundle?.names ?? new Map());
  const sources = [...new Set(rowsAll.map((r) => r.source))];

  const prevLabel = `vs ${rangeLabel(
    new Date(from.getTime() - (to.getTime() - from.getTime())),
    from,
  ).replace(/,.*$/, "")}`;

  const kpis = [
    {
      label: "Incidents Heard",
      value: String(cur.heard),
      icon: Headphones,
      color: BLUE,
      delta: deltaPct(cur.heard, before.heard),
    },
    {
      label: "Leads Claimed",
      value: String(cur.claimed),
      icon: UserPlus,
      color: "#7C3AED",
      delta: deltaPct(cur.claimed, before.claimed),
    },
    {
      label: "Avg Response",
      value: fmtMinutes(cur.avgResponse),
      icon: Clock,
      color: "#0EA5A5",
      delta:
        cur.avgResponse != null && before.avgResponse != null
          ? -deltaPct(cur.avgResponse, before.avgResponse)!
          : null,
      deltaText:
        cur.avgResponse != null && before.avgResponse != null
          ? `${cur.avgResponse <= before.avgResponse ? "-" : "+"}${fmtMinutes(
              Math.abs(cur.avgResponse - before.avgResponse),
            )}`
          : null,
    },
    {
      label: "Inspections Booked",
      value: String(cur.inspections),
      icon: CalendarDays,
      color: "#1D4ED8",
      delta: deltaPct(cur.inspections, before.inspections),
    },
    ...(canMoney
      ? [
          {
            label: "Signed Revenue",
            value: shortMoney(bundle?.revenue ?? 0),
            icon: DollarSign,
            color: GREEN,
            delta: null as number | null,
          },
        ]
      : []),
    {
      label: "Conversion",
      value: `${(cur.conversion * 100).toFixed(1)}%`,
      icon: Percent,
      color: "#EA580C",
      delta: before.heard > 0 ? (cur.conversion - before.signed / before.heard) * 100 : null,
      deltaUnit: "pp",
    },
  ];

  const trend =
    trendMode === "daily" ? dailyResponse(rows, from, to) : weeklyResponse(rows, from, to);
  const channelRows = byKey(rows, channelMode === "channel" ? "incident_type" : "source");
  const hours = hourMode === "hour" ? byHour(rows) : byDayOfWeek(rows);
  const insights = coachingInsights(rows);

  const won = rows.filter(isSigned);
  const lost = rows.filter((r) => r.lifecycle === "dead");
  const markers: LiveMapMarker[] = [...won, ...lost]
    .filter((r) => r.lat != null && r.lon != null)
    .map((r) => ({
      id: r.id,
      lat: r.lat!,
      lon: r.lon!,
      label: r.locality ?? undefined,
      color: isSigned(r) ? "#22C55E" : "#F97316",
    }));

  const exportCsv = () => {
    const header = "reported_at,type,source,claimed,inspected,signed\n";
    const body = rows
      .map(
        (r) =>
          `${r.reported_at},${r.incident_type},${r.source},${r.accepted_by ? 1 : 0},${
            r.arrived_at ? 1 : 0
          },${isSigned(r) ? 1 : 0}`,
      )
      .join("\n");
    const url = URL.createObjectURL(new Blob([header + body], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `chase-performance-${from.toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  /** Same fields as the CSV, typed, plus the city. */
  const incidentColumns: ExportColumn<(typeof rows)[number]>[] = [
    { key: "reported_at", label: "Reported", get: (r) => r.reported_at, type: "datetime" },
    {
      key: "type",
      label: "Type",
      get: (r) => INCIDENT_TYPE_LABEL[r.incident_type] ?? r.incident_type,
    },
    { key: "locality", label: "City", get: (r) => r.locality },
    { key: "source", label: "Source", get: (r) => r.source },
    { key: "claimed", label: "Claimed", get: (r) => Boolean(r.accepted_by) },
    { key: "inspected", label: "Inspected", get: (r) => Boolean(r.arrived_at) },
    { key: "signed", label: "Signed", get: (r) => isSigned(r) },
  ];

  return (
    <div className="min-h-full bg-[var(--surface)] p-4">
      {/* Header */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-[26px] font-bold leading-none" style={{ color: NAVY }}>
          Chase performance
        </h1>
        <Pick
          icon={<CalendarDays className="h-4 w-4" style={{ color: MUTED }} />}
          value={range}
          onChange={(v) => setRange(v as RangeKey)}
          width="w-[190px]"
          options={(Object.keys(RANGES) as RangeKey[]).map((k) => ({
            value: k,
            label: k === range ? rangeLabel(from, to) : `Last ${RANGES[k]} days`,
          }))}
        />
        <Pick
          value={locId}
          onChange={setLocId}
          width="w-[150px]"
          options={[
            { value: "all", label: "All Branches" },
            ...app.visibleLocations.map((l) => ({ value: l.id, label: l.name })),
          ]}
        />
        <Pick
          value={repId}
          onChange={setRepId}
          width="w-[130px]"
          options={[
            { value: "all", label: "All Reps" },
            ...chasers.map((c) => ({ value: c.userId, label: c.name })),
          ]}
        />
        <Pick
          value={sourceKey}
          onChange={setSourceKey}
          width="w-[180px]"
          options={[
            { value: "all", label: "All Incident Sources" },
            ...sources.map((s) => ({ value: s, label: s })),
          ]}
        />
        <button
          className="inline-flex h-9 items-center gap-2 rounded-[8px] border border-[var(--border)] bg-card px-3 text-[13px] font-medium"
          style={{ color: NAVY }}
          onClick={() => setRepId("all")}
        >
          <Filter className="h-4 w-4" style={{ color: MUTED }} /> Filters
        </button>
        {canExport ? (
          <button
            className="inline-flex h-9 items-center gap-2 rounded-[8px] border border-[var(--border)] bg-card px-3 text-[13px] font-medium"
            style={{ color: NAVY }}
            onClick={exportCsv}
          >
            <Download className="h-4 w-4" style={{ color: MUTED }} /> CSV
          </button>
        ) : null}
        <ExportExcelButton
          report="chase-performance"
          surface="chase"
          entity="chase_performance"
          size="default"
          filters={{ rep: repId }}
          sheets={[{ name: "Incidents", rows, columns: incidentColumns }]}
        />
      </div>

      {/* KPI row */}
      <div className="mb-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {kpis.map((k) => (
          <div key={k.label} className={`${CARD} px-4 py-3`}>
            <div className="flex items-center gap-3">
              <span
                className="grid h-11 w-11 shrink-0 place-items-center rounded-full"
                style={{ background: `${k.color}14`, border: `1.5px solid ${k.color}33` }}
              >
                <k.icon className="h-5 w-5" strokeWidth={1.75} style={{ color: k.color }} />
              </span>
              <div className="min-w-0">
                <div className="truncate text-[12px] font-medium" style={{ color: MUTED }}>
                  {k.label}
                </div>
                <FitText
                  className="text-[26px] font-bold leading-tight tabular-nums"
                  style={{ color: NAVY }}
                >
                  {k.value}
                </FitText>
              </div>
            </div>
            <div className="mt-2 text-[11px]">
              {k.delta == null && !("deltaText" in k && k.deltaText) ? (
                <span style={{ color: MUTED }}>No prior-period data</span>
              ) : (
                <>
                  <span
                    className="font-semibold"
                    style={{ color: (k.delta ?? 0) >= 0 ? GREEN : RED }}
                  >
                    {"deltaText" in k && k.deltaText
                      ? k.deltaText
                      : `${(k.delta ?? 0) >= 0 ? "+" : ""}${(k.delta ?? 0).toFixed(1)}${
                          "deltaUnit" in k && k.deltaUnit ? " pp" : "%"
                        }`}
                  </span>{" "}
                  <span style={{ color: MUTED }}>{prevLabel}</span>
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Alert response by chaser — manager view only */}
      <div className="mb-3">
        <ResponseBreakdownPanel rows={responses} thresholdPct={settings.chronic_no_action_pct} />
      </div>

      {/* Fires vs the neighbours taken off them */}
      <div className="mb-3">
        <ExposurePanel
          split={exposureSplit(rows, bundle?.revenueByIncident ?? new Map())}
          canMoney={canMoney}
        />
      </div>

      {/* Row 2 */}
      <div className="mb-3 grid gap-3 lg:grid-cols-12">
        <div className={`${CARD} p-4 lg:col-span-4`}>
          <PanelHead title="Average response time trend">
            <MiniSelect
              value={trendMode}
              onChange={(v) => setTrendMode(v as "daily" | "weekly")}
              options={[
                { value: "daily", label: "Daily" },
                { value: "weekly", label: "Weekly" },
              ]}
            />
          </PanelHead>
          <TrendChart points={trend} goal={10} />
          <div className="mt-2 text-[12px]" style={{ color: MUTED }}>
            Goal: Under 10 minutes
          </div>
        </div>

        {/* Competitor activity — took the lead funnel's slot (owner request). */}
        <div className={`${CARD} p-4 lg:col-span-4`}>
          <CompetitorActivitySnapshot
            from={from}
            to={to}
            officeIds={locId === "all" ? previewOffices : [locId]}
            periodLabel={`Last ${RANGES[range]} days`}
          />
        </div>

        <div className={`${CARD} overflow-hidden p-4 lg:col-span-4`}>
          <PanelHead title="Geographic performance (Won vs Lost fires)">
            <MiniSelect
              value="county"
              onChange={() => undefined}
              options={[{ value: "county", label: "By County" }]}
            />
          </PanelHead>
          <div className="relative overflow-hidden rounded-[8px]">
            <LiveMap markers={markers} height={250} emptyMessage="No located incidents in range" />
            <div className="absolute bottom-3 left-3 w-[150px] rounded-[8px] border border-[var(--border)] bg-card/95 p-2 text-[12px] shadow">
              <Legend color="#22C55E" label="Won Fires" value={won.length} />
              <Legend color="#F97316" label="Lost Fires" value={lost.length} />
              <div
                className="mt-1 flex justify-between border-t border-[var(--border)] pt-1 font-semibold"
                style={{ color: NAVY }}
              >
                <span>Total</span>
                <span>{won.length + lost.length}</span>
              </div>
              <div className="mt-2 flex items-center gap-1 text-[10px]" style={{ color: MUTED }}>
                <span>Low</span>
                <span className="h-2 flex-1 rounded-full bg-gradient-to-r from-[color-mix(in_oklab,var(--warning)_14%,var(--card))] via-[#F97316] to-[var(--destructive)]" />
                <span>High</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Row 3 */}
      <div className="mb-3 grid gap-3 lg:grid-cols-12">
        <div className={`${CARD} flex flex-col p-4 lg:col-span-3`}>
          <PanelHead title="Performance by radio channel & department" />
          <Toggle
            value={channelMode}
            onChange={(v) => setChannelMode(v as "channel" | "department")}
            options={[
              { value: "channel", label: "Radio Channel" },
              { value: "department", label: "Department" },
            ]}
          />
          <table className="mt-2 w-full text-[11px]">
            <thead>
              <tr className="border-b" style={{ borderColor: GRID, color: MUTED }}>
                <th className="px-1 py-1 text-left font-semibold">Channel</th>
                <th className="whitespace-nowrap px-1 py-1 text-right font-semibold">Heard</th>
                <th className="whitespace-nowrap px-1 py-1 text-right font-semibold">
                  Inspections
                </th>
                <th className="whitespace-nowrap px-1 py-1 text-right font-semibold">Signed</th>
                <th className="whitespace-nowrap px-1 py-1 text-right font-semibold">Conversion</th>
              </tr>
            </thead>
            <tbody>
              {channelRows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-4 text-center" style={{ color: MUTED }}>
                    No incidents in range
                  </td>
                </tr>
              ) : (
                channelRows.map((r) => (
                  <tr key={r.key} className="border-b last:border-0" style={{ borderColor: GRID }}>
                    <td className="px-1 py-1.5" style={{ color: NAVY }}>
                      {INCIDENT_TYPE_LABEL[r.key as keyof typeof INCIDENT_TYPE_LABEL] ?? r.key}
                    </td>
                    <td className="px-1 py-1.5 text-right tabular-nums" style={{ color: NAVY }}>
                      {r.heard}
                    </td>
                    <td className="px-1 py-1.5 text-right tabular-nums" style={{ color: NAVY }}>
                      {r.inspections}
                    </td>
                    <td className="px-1 py-1.5 text-right tabular-nums" style={{ color: NAVY }}>
                      {r.signed}
                    </td>
                    <td className="px-1 py-1.5">
                      <div className="flex items-center justify-end gap-1">
                        <span className="h-1.5 w-9 rounded-full bg-[#E7EDF6] dark:bg-muted">
                          <span
                            className="block h-1.5 rounded-full"
                            style={{
                              width: `${Math.min(100, r.conversion * 100)}%`,
                              background: BLUE,
                            }}
                          />
                        </span>
                        <span className="w-9 text-right tabular-nums" style={{ color: NAVY }}>
                          {(r.conversion * 100).toFixed(1)}%
                        </span>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          <LinkRow label="View full channel report" />
        </div>

        <div className={`${CARD} flex flex-col p-4 lg:col-span-3`}>
          <PanelHead title="Effectiveness by hour of day" />
          <Toggle
            value={hourMode}
            onChange={(v) => setHourMode(v as "hour" | "dow")}
            options={[
              { value: "hour", label: "By Hour" },
              { value: "dow", label: "By Day of Week" },
            ]}
          />
          <div className="mt-2 flex items-center gap-3 text-[11px]" style={{ color: MUTED }}>
            <LegendDot color={BLUE} label="Heard" />
            <LegendDot color="#F97316" label="Inspections" />
            <LegendDot color={GREEN} label="Signed" />
          </div>
          <HourChart data={hours} mode={hourMode} />
          <LinkRow label={hourMode === "hour" ? "View by day of week" : "View by hour"} />
        </div>

        <div className={`${CARD} flex flex-col p-4 lg:col-span-3`}>
          <PanelHead title="Top performers">
            <MiniSelect
              value="week"
              onChange={() => undefined}
              options={[{ value: "week", label: "This range" }]}
            />
          </PanelHead>
          <table className="mt-1 w-full text-[11px]">
            <thead>
              <tr className="border-b" style={{ borderColor: GRID, color: MUTED }}>
                <th className="px-1 py-1 text-left font-semibold">Rep</th>
                <th className="whitespace-nowrap px-1 py-1 text-right font-semibold">Heard</th>
                <th className="whitespace-nowrap px-1 py-1 text-right font-semibold">
                  Inspections
                </th>
                <th className="whitespace-nowrap px-1 py-1 text-right font-semibold">Signed</th>
                <th className="whitespace-nowrap px-1 py-1 text-right font-semibold">Conversion</th>
              </tr>
            </thead>
            <tbody>
              {chasers.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-4 text-center" style={{ color: MUTED }}>
                    No claims in range
                  </td>
                </tr>
              ) : (
                chasers.slice(0, 5).map((c, i) => (
                  <tr
                    key={c.userId}
                    className="border-b last:border-0"
                    style={{ borderColor: GRID }}
                  >
                    <td className="flex items-center gap-2 px-1 py-1.5">
                      <Medal rank={i + 1} />
                      <span
                        className="grid h-6 w-6 place-items-center rounded-full bg-[#E7EDF6] dark:bg-muted text-[10px] font-semibold"
                        style={{ color: NAVY }}
                      >
                        {c.name.slice(0, 1)}
                      </span>
                      <span className="truncate" style={{ color: NAVY }}>
                        {c.name}
                      </span>
                    </td>
                    <td className="px-1 py-1.5 text-right tabular-nums" style={{ color: NAVY }}>
                      {c.heard}
                    </td>
                    <td className="px-1 py-1.5 text-right tabular-nums" style={{ color: NAVY }}>
                      {c.inspections}
                    </td>
                    <td className="px-1 py-1.5 text-right tabular-nums" style={{ color: NAVY }}>
                      {c.signed}
                    </td>
                    <td className="px-1 py-1.5 text-right tabular-nums" style={{ color: NAVY }}>
                      {(c.conversion * 100).toFixed(1)}%
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          <LinkRow label="View full leaderboard" />
        </div>

        <div className={`${CARD} flex flex-col p-4 lg:col-span-3`}>
          <PanelHead title="Top lost reasons">
            <MiniSelect
              value="week"
              onChange={() => undefined}
              options={[{ value: "week", label: "This range" }]}
            />
          </PanelHead>
          <Donut reasons={bundle?.lostReasons ?? []} />
          <LinkRow label="View full lost reason report" />
        </div>
      </div>

      {/* Bottom row */}
      <div className="grid gap-3 lg:grid-cols-12">
        <div className={`${CARD} flex flex-col p-4 lg:col-span-7`}>
          <PanelHead title="Benchmark comparison" />
          <Benchmark
            rows={rows}
            all={bundle?.allBranches ?? []}
            revenue={bundle?.revenue ?? 0}
            revenueAll={bundle?.revenueAll ?? 0}
            canMoney={canMoney}
          />
          <LinkRow label="View benchmark details" />
        </div>

        <div className={`${CARD} flex flex-col p-4 lg:col-span-5`}>
          <PanelHead title="Coaching insights" />
          <div className="mt-1 grid gap-3 sm:grid-cols-2">
            {insights.map((ins) => (
              <div key={ins.title} className="flex gap-2">
                <span
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-full"
                  style={{
                    background:
                      ins.tone === "good"
                        ? "color-mix(in oklab, var(--success) 14%, var(--card))"
                        : ins.tone === "warn"
                          ? "#FEF3DC"
                          : "var(--accent)",
                  }}
                >
                  {ins.tone === "good" ? (
                    <Clock className="h-4 w-4" style={{ color: GREEN }} strokeWidth={1.75} />
                  ) : ins.tone === "warn" ? (
                    <SlidersHorizontal
                      className="h-4 w-4"
                      style={{ color: "var(--warning)" }}
                      strokeWidth={1.75}
                    />
                  ) : (
                    <Phone className="h-4 w-4" style={{ color: BLUE }} strokeWidth={1.75} />
                  )}
                </span>
                <div className="min-w-0">
                  <div className="text-[12.5px] font-semibold" style={{ color: NAVY }}>
                    {ins.title}
                  </div>
                  <div className="text-[11.5px]" style={{ color: MUTED }}>
                    {ins.body}
                  </div>
                </div>
              </div>
            ))}
            {insights.length === 0 ? (
              <div className="text-[12px]" style={{ color: MUTED }}>
                Insights appear once incidents are recorded in this range.
              </div>
            ) : null}
          </div>
          <LinkRow label="View all insights & coaching tips" />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ pieces ------------------------------ */

function PanelHead({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <h2 className="text-[14px] font-bold" style={{ color: NAVY }}>
        {title}
      </h2>
      <Info className="h-3.5 w-3.5" style={{ color: "#B6C1D0" }} />
      <div className="ml-auto">{children}</div>
    </div>
  );
}

function Pick({
  value,
  onChange,
  options,
  width,
  icon,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  width: string;
  icon?: React.ReactNode;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        className={`${width} h-9 rounded-[8px] border-[var(--border)] bg-card text-[13px]`}
        style={{ color: NAVY }}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2 whitespace-nowrap">
          {icon && <span className="shrink-0">{icon}</span>}
          <SelectValue className="truncate" />
        </div>
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function MiniSelect({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        className="h-7 w-auto gap-1 rounded-[6px] border-[var(--border)] bg-card px-2 text-[12px]"
        style={{ color: NAVY }}
      >
        <SelectValue />
        <ChevronDown className="h-3 w-3 opacity-0" />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function Toggle({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="flex rounded-[6px] bg-[#F1F4F9] dark:bg-muted p-[2px]">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className="flex-1 rounded-[5px] py-1 text-[12px] font-semibold"
          style={
            value === o.value
              ? { background: BLUE, color: "var(--primary-foreground)" }
              : { color: MUTED }
          }
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function LinkRow({ label }: { label: string }) {
  return (
    <div className="mt-auto border-t border-[var(--border)] pt-2 text-center">
      <span className="text-[12px] font-medium" style={{ color: BLUE }}>
        {label}
      </span>
    </div>
  );
}

function Legend({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <div className="flex items-center justify-between py-[1px]">
      <span className="flex items-center gap-1.5" style={{ color: MUTED }}>
        <span className="h-2 w-2 rounded-full" style={{ background: color }} />
        {label}
      </span>
      <span className="font-semibold tabular-nums" style={{ color: NAVY }}>
        {value}
      </span>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className="h-2 w-2 rounded-[2px]" style={{ background: color }} />
      {label}
    </span>
  );
}

function Medal({ rank }: { rank: number }) {
  const tone = rank === 1 ? "#F5B301" : rank === 2 ? "#A8B4C4" : rank === 3 ? "#CD7F32" : null;
  if (!tone)
    return (
      <span className="w-4 text-center text-[11px]" style={{ color: MUTED }}>
        {rank}
      </span>
    );
  return (
    <span
      className="grid h-4 w-4 place-items-center rounded-full text-[9px] font-bold text-white"
      style={{ background: tone }}
    >
      {rank}
    </span>
  );
}

function TrendChart({
  points,
  goal,
}: {
  points: { key: string; date: Date; minutes: number | null }[];
  goal: number;
}) {
  const w = 320;
  const h = 150;
  const pad = { l: 30, r: 8, t: 12, b: 22 };
  const vals = points.map((p) => p.minutes ?? 0);
  const max = Math.max(15, ...vals) * 1.1;
  const step = points.length > 1 ? (w - pad.l - pad.r) / (points.length - 1) : 0;
  const x = (i: number) => pad.l + i * step;
  const y = (v: number) => pad.t + (1 - v / max) * (h - pad.t - pad.b);
  const withVals = points.map((p, i) => ({ ...p, i })).filter((p) => p.minutes != null);
  const path = withVals.map((p, n) => `${n === 0 ? "M" : "L"}${x(p.i)},${y(p.minutes!)}`).join(" ");
  const area =
    withVals.length > 1
      ? `${path} L${x(withVals[withVals.length - 1]!.i)},${h - pad.b} L${x(withVals[0]!.i)},${h - pad.b} Z`
      : "";

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-[150px] w-full">
      {[0, max / 3, (2 * max) / 3, max].map((v) => (
        <g key={v}>
          <line x1={pad.l} x2={w - pad.r} y1={y(v)} y2={y(v)} stroke={GRID} />
          <text x={0} y={y(v) + 3} fontSize="8" fill={MUTED}>
            {Math.round(v)}m
          </text>
        </g>
      ))}
      <line
        x1={pad.l}
        x2={w - pad.r}
        y1={y(goal)}
        y2={y(goal)}
        stroke="var(--foreground)"
        strokeDasharray="4 3"
        strokeWidth="1"
      />
      {area ? <path d={area} fill={`${BLUE}14`} /> : null}
      {path ? <path d={path} fill="none" stroke={BLUE} strokeWidth="2" /> : null}
      {withVals.map((p) => (
        <g key={p.key}>
          <circle cx={x(p.i)} cy={y(p.minutes!)} r="3" fill={BLUE} />
          <text x={x(p.i)} y={y(p.minutes!) - 6} fontSize="7.5" fill={NAVY} textAnchor="middle">
            {fmtMinutes(p.minutes)}
          </text>
        </g>
      ))}
      {points.map((p, i) => (
        <text key={p.key} x={x(i)} y={h - 6} fontSize="7.5" fill={MUTED} textAnchor="middle">
          {p.date.toLocaleDateString("en-US", { month: "numeric", day: "numeric" })}
        </text>
      ))}
    </svg>
  );
}

function HourChart({
  data,
  mode,
}: {
  data: { hour: number; label?: string; heard: number; inspections: number; signed: number }[];
  mode: "hour" | "dow";
}) {
  const w = 320;
  const h = 150;
  const pad = { l: 22, r: 4, t: 8, b: 18 };
  const max = Math.max(1, ...data.map((d) => d.heard));
  const slot = (w - pad.l - pad.r) / data.length;
  const bw = Math.max(1.5, slot / 3.6);
  const y = (v: number) => pad.t + (1 - v / max) * (h - pad.t - pad.b);

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="mt-1 h-[150px] w-full">
      {[0, max / 2, max].map((v) => (
        <g key={v}>
          <line x1={pad.l} x2={w - pad.r} y1={y(v)} y2={y(v)} stroke={GRID} />
          <text x={0} y={y(v) + 3} fontSize="8" fill={MUTED}>
            {Math.round(v)}
          </text>
        </g>
      ))}
      {data.map((d, i) => {
        const x0 = pad.l + i * slot + slot / 2 - bw * 1.5;
        const bars: [number, string][] = [
          [d.heard, BLUE],
          [d.inspections, "#F97316"],
          [d.signed, GREEN],
        ];
        return (
          <g key={d.hour}>
            {bars.map(([v, c], n) => (
              <rect
                key={c}
                x={x0 + n * bw}
                y={y(v)}
                width={bw - 0.6}
                height={Math.max(0, h - pad.b - y(v))}
                fill={c}
                rx="0.8"
              />
            ))}
            {(mode === "dow" || i % 3 === 0) && (
              <text x={x0 + bw * 1.5} y={h - 5} fontSize="7" fill={MUTED} textAnchor="middle">
                {mode === "dow"
                  ? d.label
                  : `${d.hour === 0 ? 12 : d.hour % 12 || 12}${d.hour < 12 ? "AM" : "PM"}`}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

const DONUT_COLORS = [
  "var(--primary)",
  "#7C3AED",
  "#F97316",
  "#14B8A6",
  "var(--muted-foreground)",
  "var(--border)",
];

function Donut({ reasons }: { reasons: { label: string; count: number }[] }) {
  const top = reasons.slice(0, 6);
  const total = top.reduce((s, r) => s + r.count, 0);
  const r = 42;
  const c = 2 * Math.PI * r;
  let offset = 0;

  return (
    <div className="flex items-center gap-3">
      <svg viewBox="0 0 110 110" className="h-[110px] w-[110px] shrink-0 -rotate-90">
        <circle cx="55" cy="55" r={r} fill="none" stroke="var(--border)" strokeWidth="16" />
        {total > 0 &&
          top.map((x, i) => {
            const frac = x.count / total;
            const el = (
              <circle
                key={x.label}
                cx="55"
                cy="55"
                r={r}
                fill="none"
                stroke={DONUT_COLORS[i % DONUT_COLORS.length]}
                strokeWidth="16"
                strokeDasharray={`${frac * c} ${c}`}
                strokeDashoffset={-offset}
              />
            );
            offset += frac * c;
            return el;
          })}
      </svg>
      <div className="relative -ml-[125px] mr-[15px] grid h-[110px] w-[110px] shrink-0 place-items-center text-center">
        <div>
          <div className="text-[20px] font-bold leading-none" style={{ color: NAVY }}>
            {total}
          </div>
          <div className="text-[10px]" style={{ color: MUTED }}>
            Total Lost
          </div>
        </div>
      </div>
      <div className="min-w-0 flex-1 space-y-1 text-[11.5px]">
        {top.length === 0 ? (
          <span style={{ color: MUTED }}>No lost outcomes logged in range</span>
        ) : (
          top.map((x, i) => (
            <div key={x.label} className="flex items-center gap-2">
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: DONUT_COLORS[i % DONUT_COLORS.length] }}
              />
              <span className="truncate" style={{ color: NAVY }}>
                {x.label}
              </span>
              <span className="ml-auto shrink-0 tabular-nums" style={{ color: MUTED }}>
                {((x.count / total) * 100).toFixed(1)}% ({x.count})
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function Benchmark({
  rows,
  all,
  revenue,
  revenueAll,
  canMoney,
}: {
  rows: PerfIncident[];
  all: PerfIncident[];
  revenue: number;
  revenueAll: number;
  canMoney: boolean;
}) {
  const mine = summary(rows);
  const net = summary(all);
  const items = [
    {
      label: "Avg Response Time",
      value: fmtMinutes(mine.avgResponse),
      other: fmtMinutes(net.avgResponse),
      better:
        mine.avgResponse != null && net.avgResponse != null
          ? mine.avgResponse <= net.avgResponse
          : null,
    },
    {
      label: "Conversion Rate",
      value: `${(mine.conversion * 100).toFixed(1)}%`,
      other: `${(net.conversion * 100).toFixed(1)}%`,
      better: mine.conversion >= net.conversion,
    },
    {
      label: "Inspections / Heard",
      value: `${mine.heard ? ((mine.inspections / mine.heard) * 100).toFixed(1) : "0.0"}%`,
      other: `${net.heard ? ((net.inspections / net.heard) * 100).toFixed(1) : "0.0"}%`,
      better:
        (mine.heard ? mine.inspections / mine.heard : 0) >=
        (net.heard ? net.inspections / net.heard : 0),
    },
    ...(canMoney
      ? [
          {
            label: "Signed Revenue",
            value: shortMoney(revenue),
            other: shortMoney(revenueAll),
            better: revenue >= revenueAll,
          },
        ]
      : []),
  ];

  return (
    <div
      className="mt-1 grid gap-3"
      style={{ gridTemplateColumns: `160px repeat(${items.length}, minmax(0,1fr))` }}
    >
      <div className="self-center">
        <div className="text-[13px] font-semibold" style={{ color: NAVY }}>
          How you compare
        </div>
        <div className="text-[11px]" style={{ color: MUTED }}>
          vs all branches
        </div>
      </div>
      {items.map((it) => (
        <div
          key={it.label}
          className="rounded-[8px] border border-[var(--border)] px-3 py-2 text-center"
        >
          <div className="text-[11px]" style={{ color: MUTED }}>
            {it.label}
          </div>
          <FitText
            className="text-[20px] font-bold leading-tight tabular-nums"
            style={{ color: NAVY }}
          >
            {it.value}
          </FitText>
          <div
            className="text-[12px] font-semibold"
            style={{ color: it.better === false ? RED : GREEN }}
          >
            {it.better === false ? "Worse" : "Better"}
          </div>
          <div className="text-[11px]" style={{ color: MUTED }}>
            vs {it.other}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---------------- chaser's own view (unchanged behaviour) ---------------- */

/**
 * Origin fires versus the neighbouring buildings taken off them. Average
 * exposures per fire is how the office judges whether the block is worked.
 */
function ExposurePanel({ split, canMoney }: { split: ExposureSplit; canMoney: boolean }) {
  const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
  const sides = [
    { label: "Origin fires", s: split.fires, color: RED },
    { label: "Exposures", s: split.exposures, color: BLUE },
  ];

  return (
    <div className={`${CARD} p-4`}>
      <PanelHead title="Origin fires vs exposures" />
      <div className="grid gap-3 md:grid-cols-3">
        {sides.map((side) => (
          <div key={side.label} className="rounded-[8px] border border-[var(--border)] p-3">
            <div className="text-[12px] font-semibold" style={{ color: side.color }}>
              {side.label}
            </div>
            <div
              className="mt-2 grid grid-cols-3 gap-2 text-[13px] tabular-nums"
              style={{ color: NAVY }}
            >
              <Stat label="Leads" value={String(side.s.leads)} />
              <Stat label="Signed" value={String(side.s.signed)} />
              <Stat label="Conv." value={`${(side.s.conversion * 100).toFixed(1)}%`} />
            </div>
            {canMoney && (
              <div
                className="mt-2 border-t border-[var(--border)] pt-2 text-[13px]"
                style={{ color: NAVY }}
              >
                <span style={{ color: MUTED }}>Revenue signed </span>
                <span className="font-bold">{money(side.s.revenue)}</span>
              </div>
            )}
          </div>
        ))}
        <div className="rounded-[8px] border border-[var(--border)] p-3">
          <div className="text-[12px] font-semibold" style={{ color: MUTED }}>
            Average exposures per fire
          </div>
          <div className="mt-1 text-[30px] font-bold leading-none" style={{ color: NAVY }}>
            {split.avgExposuresPerFire.toFixed(2)}
          </div>
          <div className="mt-2 text-[12px]" style={{ color: MUTED }}>
            {split.firesWithExposures} of {split.firesWorked} fire
            {split.firesWorked === 1 ? "" : "s"} produced at least one neighbor lead
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px]" style={{ color: MUTED }}>
        {label}
      </div>
      <div className="font-bold">{value}</div>
    </div>
  );
}

/**
 * Alerts sent versus accepted, declined and no action, per chaser. No action is
 * tracked apart from declined on purpose: ignoring an alert and declining it
 * with a reason are different behaviours and a single response rate hides that.
 */
function ResponseBreakdownPanel({
  rows,
  thresholdPct,
}: {
  rows: DispatchResponseRow[];
  thresholdPct: number;
}) {
  const total = rows.reduce(
    (a, r) => ({
      sent: a.sent + r.sent,
      accepted: a.accepted + r.accepted,
      declined: a.declined + r.declined,
      noAction: a.noAction + r.noAction,
      pending: a.pending + r.pending,
    }),
    { sent: 0, accepted: 0, declined: 0, noAction: 0, pending: 0 },
  );
  const flagged = rows.filter((r) => isChronicNoAction(r, thresholdPct));

  return (
    <div className={`${CARD} p-4`}>
      <PanelHead title="Alert response by chaser">
        <span className="text-[11px]" style={{ color: MUTED }}>
          No action tracked separately from declined
        </span>
      </PanelHead>

      {rows.length === 0 ? (
        <div className="py-6 text-center text-[13px]" style={{ color: MUTED }}>
          No alerts sent in this range.
        </div>
      ) : (
        <>
          <div className="mb-3 grid gap-2 sm:grid-cols-4">
            {[
              { label: "Alerts sent", value: total.sent, color: NAVY },
              { label: "Accepted", value: total.accepted, color: GREEN },
              { label: "Declined with reason", value: total.declined, color: "#EA580C" },
              { label: "No action", value: total.noAction, color: RED },
            ].map((t) => (
              <div key={t.label} className="rounded-[8px] border border-[var(--border)] p-3">
                <div className="text-[11px]" style={{ color: MUTED }}>
                  {t.label}
                </div>
                <div className="text-[24px] font-bold leading-tight" style={{ color: t.color }}>
                  {t.value}
                </div>
              </div>
            ))}
          </div>

          {flagged.length > 0 && (
            <div
              className="mb-3 rounded-[8px] border px-3 py-2 text-[12px]"
              style={{ borderColor: `${RED}55`, background: `${RED}0F`, color: NAVY }}
            >
              <span className="font-semibold">Chronic no-action — manager review:</span>{" "}
              {flagged
                .map(
                  (r) =>
                    `${r.name} (${r.noAction} of ${r.sent} ignored, ${(r.noActionRate * 100).toFixed(0)}%)`,
                )
                .join(" · ")}{" "}
              <span style={{ color: MUTED }}>Threshold {thresholdPct}%</span>
            </div>
          )}

          <div className="overflow-x-auto md:max-h-[75svh] md:overflow-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr
                  className="text-left text-[11px] font-semibold uppercase tracking-wide"
                  style={{ color: MUTED }}
                >
                  <th className="py-2">Chaser</th>
                  <th className="py-2 text-right">Sent</th>
                  <th className="py-2 text-right">Accepted</th>
                  <th className="py-2 text-right">Declined</th>
                  <th className="py-2 text-right">No action</th>
                  <th className="py-2 text-right">Awaiting</th>
                  <th className="py-2 text-right">Accept rate</th>
                  <th className="py-2 text-right">No-action rate</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const chronic = isChronicNoAction(r, thresholdPct);
                  return (
                    <tr key={r.userId} className="border-t border-[var(--border)] tabular-nums">
                      <td className="py-2 font-medium" style={{ color: NAVY }}>
                        {r.name}
                        {chronic && (
                          <span
                            className="ml-2 rounded-full px-2 py-0.5 text-[10px] font-semibold"
                            style={{ background: `${RED}18`, color: RED }}
                          >
                            Chronic no-action
                          </span>
                        )}
                      </td>
                      <td className="py-2 text-right" style={{ color: NAVY }}>
                        {r.sent}
                      </td>
                      <td className="py-2 text-right" style={{ color: GREEN }}>
                        {r.accepted}
                      </td>
                      <td className="py-2 text-right text-orange-700 dark:text-orange-400">
                        {r.declined}
                      </td>
                      <td className="py-2 text-right font-semibold" style={{ color: RED }}>
                        {r.noAction}
                      </td>
                      <td className="py-2 text-right" style={{ color: MUTED }}>
                        {r.pending}
                      </td>
                      <td className="py-2 text-right" style={{ color: NAVY }}>
                        {(r.acceptRate * 100).toFixed(0)}%
                      </td>
                      <td className="py-2 text-right" style={{ color: NAVY }}>
                        {(r.noActionRate * 100).toFixed(0)}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
