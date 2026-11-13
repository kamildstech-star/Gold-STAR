import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  DollarSign,
  Droplets,
  FileText,
  Flame,
  Image as ImageIcon,
  Navigation as NavIcon,
  Phone,
  Search,
  Wind,
  X,
} from "lucide-react";

import { useAppContext, useWritesDisabled } from "@/components/app-context";
import { LiveMap } from "@/components/live-map";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { supabase } from "@/integrations/supabase/client";
import { useJobStages } from "@/lib/job-stages";
import { mapsDeepLink } from "@/lib/incidents";
import { EXTERNAL_LINK_REL } from "@/lib/maps-links";
import { streetViewImage } from "@/lib/route-map.functions";
import {
  countdown,
  fetchChaseBoard,
  priorityOf,
  taskDueAt,
  timelineOf,
  type ChaseJob,
} from "@/lib/chase-jobs";
import { FitText } from "@/components/ui/fit-text";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
export const Route = createFileRoute("/_authenticated/chase/jobs")({
  head: () => ({
    meta: [
      { title: "Your Jobs · Recovery Hub" },
      {
        name: "description",
        content: "Your claimed jobs for the shift: stage, appointments, next task and conversion.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: ChaseJobsPage,
});

/* ---------------- tokens lifted from the mockup ---------------- */
const CARD =
  "rounded-[12px] border border-[var(--border)] bg-card shadow-[0_1px_2px_rgba(16,36,61,0.04)]";
const NAVY = "var(--foreground)";
const MUTED = "var(--muted-foreground)";
const BLUE = "var(--primary)";
const GREEN = "var(--success)";
const ORANGE = "#EA580C";
const PAGE_SIZE = 6;

const PRIORITY: Record<"high" | "med" | "low", { bg: string; fg: string; label: string }> = {
  high: {
    bg: "color-mix(in oklab, var(--destructive) 14%, var(--card))",
    fg: "var(--destructive)",
    label: "High",
  },
  med: { bg: "#FEF3DC", fg: "var(--warning)", label: "Medium" },
  low: {
    bg: "color-mix(in oklab, var(--success) 14%, var(--card))",
    fg: "var(--success)",
    label: "Low",
  },
};

/** Stage tint follows the mockup: inspection blue, estimate orange, follow-up purple. */
function stageChip(stage: string | null): { bg: string; fg: string } {
  const s = (stage ?? "").toLowerCase();
  if (/estimate|scope|proposal/.test(s))
    return { bg: "color-mix(in oklab, var(--warning) 14%, var(--card))", fg: "var(--warning)" };
  if (/follow|await|call back/.test(s)) return { bg: "#EFE9FE", fg: "#7C3AED" };
  if (/won|signed|complete|paid|closed/.test(s))
    return { bg: "color-mix(in oklab, var(--success) 14%, var(--card))", fg: "var(--success)" };
  return { bg: "var(--accent)", fg: "#1A5FD0" };
}

const LOSS_COLOR: Record<string, string> = {
  fire: "#F26522",
  smoke: "#F26522",
  water: "#2E86F0",
  sewer: "#2E86F0",
  storm: "#7C3AED",
  mold: "var(--success)",
  biohazard: "var(--destructive)",
  cleaning: "#0EA5A5",
};

function LossIcon({ type, size = 34 }: { type: string | null; size?: number }) {
  const color = LOSS_COLOR[type ?? ""] ?? "var(--muted-foreground)";
  const Icon = type === "water" || type === "sewer" ? Droplets : type === "storm" ? Wind : Flame;
  return (
    <span
      className="grid shrink-0 place-items-center rounded-full"
      style={{ width: size, height: size, background: `${color}1F` }}
    >
      <Icon style={{ width: size * 0.5, height: size * 0.5, color }} />
    </span>
  );
}

const money = (n: number | null | undefined) =>
  n == null || n === 0
    ? "—"
    : n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

const shortMoney = (n: number) =>
  n >= 1000
    ? `$${Math.round(n / 1000)}K`
    : n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

const timeAt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "—";

const dayAt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—";

const sameDay = (iso: string | null, d: Date) =>
  !!iso && new Date(iso).toDateString() === d.toDateString();

type Tab = "today" | "active" | "followup" | "closed";

const CLOSED = /(won|lost|closed|complete|paid)/i;
const FOLLOWUP = /(follow|estimate|proposal|await)/i;

/* ------------------------------------------------------------------ */

function ChaseJobsPage() {
  const app = useAppContext();
  const [tab, setTab] = useState<Tab>("today");
  const [page, setPage] = useState(0);
  const [selId, setSelId] = useState<string | null>(null);
  const [dayOffset, setDayOffset] = useState(0);
  const [tick, setTick] = useState(Date.now());

  /** Countdowns are live — one timer for the page, not one per row. */
  useEffect(() => {
    const t = setInterval(() => setTick(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const boardQ = useQuery({
    enabled: !!app.userId,
    queryKey: ["chase", "my-jobs", app.userId],
    queryFn: () => fetchChaseBoard(app.userId!),
  });

  const jobs = useMemo(() => boardQ.data?.jobs ?? [], [boardQ.data]);
  const tasks = boardQ.data?.tasks ?? [];
  const funnel = boardQ.data?.funnel;

  const day = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + dayOffset);
    return d;
  }, [dayOffset]);

  const counts = useMemo(() => {
    const closed = jobs.filter((j) => CLOSED.test(j.stage ?? "")).length;
    return {
      active: jobs.length - closed,
      closed,
      followup: jobs.filter((j) => FOLLOWUP.test(j.stage ?? "") && !CLOSED.test(j.stage ?? ""))
        .length,
      inspections: jobs.filter((j) => sameDay(j.appt_at, day)).length,
      signed: jobs
        .filter((j) => CLOSED.test(j.stage ?? ""))
        .reduce((s, j) => s + (j.est_value ?? 0), 0),
    };
  }, [jobs, day]);

  const rows = useMemo(() => {
    const open = jobs.filter((j) => !CLOSED.test(j.stage ?? ""));
    switch (tab) {
      case "today":
        // Today is what needs the chaser today: an appointment on this day,
        // an overdue one, an open task, or an active job with nothing booked.
        return open.filter(
          (j) =>
            sameDay(j.appt_at, day) ||
            j.open_tasks > 0 ||
            (j.appt_at != null && new Date(j.appt_at).getTime() < day.getTime()) ||
            j.appt_at == null,
        );
      case "followup":
        return open.filter((j) => FOLLOWUP.test(j.stage ?? ""));
      case "closed":
        return jobs.filter((j) => CLOSED.test(j.stage ?? ""));
      default:
        return open;
    }
  }, [jobs, tab, day]);

  useEffect(() => setPage(0), [tab]);

  // Nothing needing attention today (everything is booked ahead) — fall back to
  // the full active book so the board is never a dead end on first load.
  const [autoTabbed, setAutoTabbed] = useState(false);
  useEffect(() => {
    if (autoTabbed || boardQ.isLoading || jobs.length === 0) return;
    if (tab === "today" && rows.length === 0) setTab("active");
    setAutoTabbed(true);
  }, [autoTabbed, boardQ.isLoading, tab, rows.length, jobs.length]);

  const pageRows = rows.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  const selected = rows.find((r) => r.id === selId) ?? pageRows[0] ?? null;

  return (
    <div className="w-full bg-[var(--surface)] p-4 pb-10" style={{ color: NAVY }}>
      <div className="flex gap-4">
        <div className="min-w-0 flex-1 space-y-3">
          {/* Header */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h1 className="text-[26px] font-extrabold leading-tight tracking-[-0.01em]">
              Your Jobs {app.fullName ? <>— {app.fullName}</> : null}
            </h1>
            <div className="flex items-center gap-2">
              <div className={`flex h-12 items-center gap-1 px-2 lg:h-10 lg:gap-3 lg:px-3 ${CARD}`}>
                <button
                  type="button"
                  aria-label="Previous day"
                  onClick={() => setDayOffset((d) => d - 1)}
                  className="grid size-11 shrink-0 place-items-center lg:size-6"
                  style={{ color: MUTED }}
                >
                  <ChevronLeft className="size-4" />
                </button>
                <span className="text-[13px] font-semibold">
                  {dayOffset === 0 ? "Today, " : ""}
                  {day.toLocaleDateString(DATE_LOCALE, US_DATE)}
                </span>
                <button
                  type="button"
                  aria-label="Next day"
                  onClick={() => setDayOffset((d) => d + 1)}
                  className="grid size-11 shrink-0 place-items-center lg:size-6"
                  style={{ color: MUTED }}
                >
                  <ChevronRight className="size-4" />
                </button>
              </div>
              <ShiftSelector />
            </div>
          </div>

          {/* KPI row */}
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <Kpi
              icon={Flame}
              tint="#FDEAE0"
              color="#F26522"
              label="Active"
              value={String(counts.active)}
              delta={`${counts.followup} awaiting follow-up`}
              deltaColor={MUTED}
              noArrow
            />
            <Kpi
              icon={Droplets}
              tint="#E3EEFD"
              color="#2E86F0"
              label="Inspections Today"
              value={String(counts.inspections)}
              delta={`${jobs.filter((j) => j.appt_at).length} scheduled total`}
              deltaColor={MUTED}
              noArrow
            />
            <Kpi
              icon={ClipboardList}
              tint="#FDECE1"
              color="#F26522"
              label="Estimates Pending"
              value={String(funnel ? Math.max(0, funnel.estimates - funnel.won) : 0)}
              delta={`${funnel?.estimates ?? 0} sent this month`}
              deltaColor={MUTED}
              noArrow
            />
            <Kpi
              icon={DollarSign}
              tint="#E4F5E9"
              color={GREEN}
              label="Signed This Month"
              value={counts.signed ? shortMoney(counts.signed) : "$0"}
              delta={`${counts.closed} job${counts.closed === 1 ? "" : "s"} closed`}
              deltaColor={GREEN}
            />
          </div>

          {/* Tabs */}
          {/* Scrolls rather than wraps or crushes: four tabs do not fit 390px,
              and a wrapped tab strip stops reading as one row of choices. */}
          <div className="-mx-1 flex items-center gap-5 overflow-x-auto border-b border-[var(--border)] px-1 lg:mx-0 lg:gap-6 lg:px-0">
            {(
              [
                ["today", "Today", undefined],
                ["active", "Active", undefined],
                ["followup", "Awaiting Follow-up", counts.followup],
                ["closed", "Closed", undefined],
              ] as [Tab, string, number | undefined][]
            ).map(([key, label, badge]) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                className="-mb-px flex min-h-11 shrink-0 items-center gap-2 whitespace-nowrap border-b-2 pb-2.5 pt-1 text-[13px] font-semibold lg:min-h-0"
                style={{
                  borderColor: tab === key ? BLUE : "transparent",
                  color: tab === key ? BLUE : MUTED,
                }}
              >
                {label}
                {badge ? (
                  <span
                    className="grid size-[18px] place-items-center rounded-full text-[10px] font-bold text-white"
                    style={{ background: BLUE }}
                  >
                    {badge}
                  </span>
                ) : null}
              </button>
            ))}
          </div>

          {/* Jobs table */}
          <div className={CARD}>
            {/*
             * Nine columns at 980px is a sideways scroll through four screens
             * to read one job, and this board is used in a vehicle. Below lg
             * each row becomes a card that opens the job — the desktop row
             * selects into the side panel, which is hidden at this width and so
             * would leave the tap doing nothing.
             */}
            <div className="divide-y divide-[var(--border)] lg:hidden">
              {pageRows.map((j) => {
                const dueAt = taskDueAt(j.next_task);
                const prio = priorityOf(dueAt ?? j.appt_at, j.loss_type);
                const chip = stageChip(j.stage);
                return (
                  <Link
                    key={j.id}
                    to="/jobs/$id"
                    params={{ id: j.id }}
                    className="flex items-start gap-3 p-3"
                  >
                    <LossIcon type={j.loss_type} size={34} />
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <div className="flex items-start justify-between gap-2">
                        <span className="min-w-0 truncate text-[14px] font-bold">
                          {j.address ?? j.job_number ?? "Job"}
                        </span>
                        <span
                          className="shrink-0 rounded-[6px] px-2 py-1 text-[11px] font-semibold"
                          style={{ background: PRIORITY[prio].bg, color: PRIORITY[prio].fg }}
                        >
                          {PRIORITY[prio].label}
                        </span>
                      </div>
                      <div className="truncate text-[12px]" style={{ color: MUTED }}>
                        {j.cityLine || j.job_number || "—"}
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-[12px]">
                        <span
                          className="inline-flex rounded-[6px] px-2 py-1 font-semibold"
                          style={{ background: chip.bg, color: chip.fg }}
                        >
                          {j.stage ?? "No stage"}
                        </span>
                        <span style={{ color: MUTED }}>
                          {j.appt_at
                            ? sameDay(j.appt_at, new Date())
                              ? `Today ${timeAt(j.appt_at)}`
                              : `${dayAt(j.appt_at)} ${timeAt(j.appt_at)}`
                            : "Unscheduled"}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-baseline justify-between gap-2 text-[12px]">
                        <span className="min-w-0 truncate">
                          {j.next_task?.title ?? "Nothing due"}
                        </span>
                        <span
                          className="shrink-0 font-semibold"
                          style={{ color: prio === "low" ? BLUE : ORANGE }}
                        >
                          {countdown(dueAt ?? j.appt_at, tick)}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-baseline justify-between gap-2 text-[12px]">
                        <span className="min-w-0 truncate" style={{ color: MUTED }}>
                          {j.owner_name ?? "—"}
                          {j.owner_phone ? ` · ${j.owner_phone}` : " · no phone"}
                        </span>
                        <span className="shrink-0 text-[13px] font-semibold">
                          {money(j.est_value)}
                        </span>
                      </div>
                    </div>
                  </Link>
                );
              })}
              {pageRows.length === 0 && (
                <p className="py-10 text-center text-[13px]" style={{ color: MUTED }}>
                  {boardQ.isLoading ? "Loading…" : "Nothing in this view."}
                </p>
              )}
            </div>
            <div className="hidden overflow-x-auto md:max-h-[75svh] md:overflow-auto lg:block">
              <table className="w-full min-w-[980px] border-collapse text-[13px]">
                <thead>
                  <tr
                    className="border-b border-[var(--border)] text-left text-[11px] font-semibold uppercase tracking-[0.04em]"
                    style={{ color: MUTED }}
                  >
                    <th className="py-2.5 pl-4 pr-3 font-semibold">Property / Address</th>
                    <th className="px-3 font-semibold">Incident Time</th>
                    <th className="px-3 font-semibold">Stage</th>
                    <th className="px-3 font-semibold">Owner Contact</th>
                    <th className="px-3 font-semibold">Appt. / Window</th>
                    <th className="px-3 font-semibold">Est. Value</th>
                    <th className="px-3 font-semibold">Next Task</th>
                    <th className="px-3 font-semibold">ETA / Due</th>
                    <th className="px-3 pr-4 font-semibold">Priority</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((j) => {
                    const dueAt = taskDueAt(j.next_task);
                    const prio = priorityOf(dueAt ?? j.appt_at, j.loss_type);
                    const chip = stageChip(j.stage);
                    const isSel = selected?.id === j.id;
                    return (
                      <tr
                        key={j.id}
                        onClick={() => setSelId(j.id)}
                        className="cursor-pointer border-b border-[var(--surface)] last:border-0"
                        style={isSel ? { background: "#F3F8FF" } : undefined}
                      >
                        <td className="py-3 pl-4 pr-3">
                          <div className="flex items-center gap-2.5">
                            <LossIcon type={j.loss_type} size={30} />
                            <div className="min-w-0">
                              <div className="truncate text-[13px] font-bold">
                                {j.address ?? j.job_number ?? "Job"}
                              </div>
                              <div className="truncate text-[12px]" style={{ color: MUTED }}>
                                {j.cityLine || j.job_number || "—"}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="px-3">
                          <div className="text-[13px] font-semibold">{dayAt(j.incident_at)}</div>
                          <div className="text-[12px]" style={{ color: MUTED }}>
                            {timeAt(j.incident_at)}
                          </div>
                        </td>
                        <td className="px-3">
                          <span
                            className="inline-flex rounded-[6px] px-2 py-1 text-[12px] font-semibold"
                            style={{ background: chip.bg, color: chip.fg }}
                          >
                            {j.stage ?? "No stage"}
                          </span>
                        </td>
                        <td className="px-3">
                          <div className="text-[13px] font-semibold">{j.owner_name ?? "—"}</div>
                          <div
                            className="flex items-center gap-1.5 text-[12px]"
                            style={{ color: MUTED }}
                          >
                            {j.owner_phone ? (
                              <span
                                className="size-[7px] rounded-full"
                                style={{ background: GREEN }}
                                aria-label="Reachable"
                              />
                            ) : null}
                            {j.owner_phone ?? "No phone"}
                          </div>
                        </td>
                        <td className="px-3">
                          <div className="text-[13px] font-semibold">
                            {j.appt_at
                              ? sameDay(j.appt_at, new Date())
                                ? "Today"
                                : dayAt(j.appt_at)
                              : "Unscheduled"}
                          </div>
                          <div className="text-[12px]" style={{ color: MUTED }}>
                            {timeAt(j.appt_at)}
                          </div>
                        </td>
                        <td className="px-3 text-[13px] font-semibold">{money(j.est_value)}</td>
                        <td className="px-3 text-[13px]">{j.next_task?.title ?? "Nothing due"}</td>
                        <td
                          className="px-3 text-[13px] font-semibold"
                          style={{ color: prio === "low" ? BLUE : ORANGE }}
                        >
                          {countdown(dueAt ?? j.appt_at, tick)}
                        </td>
                        <td className="px-3 pr-4">
                          <span
                            className="inline-flex rounded-[6px] px-2 py-1 text-[12px] font-semibold"
                            style={{ background: PRIORITY[prio].bg, color: PRIORITY[prio].fg }}
                          >
                            {PRIORITY[prio].label}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                  {pageRows.length === 0 && (
                    <tr>
                      <td
                        colSpan={9}
                        className="py-10 text-center text-[13px]"
                        style={{ color: MUTED }}
                      >
                        {boardQ.isLoading ? "Loading…" : "Nothing in this view."}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div
            className="flex items-center justify-between px-1 text-[12px]"
            style={{ color: MUTED }}
          >
            <span>
              Showing {rows.length === 0 ? 0 : page * PAGE_SIZE + 1} to{" "}
              {Math.min(rows.length, (page + 1) * PAGE_SIZE)} of {jobs.length} jobs
            </span>
            <div className="flex items-center gap-3">
              {rows.length > PAGE_SIZE ? (
                <span className="flex items-center gap-1">
                  <button
                    type="button"
                    aria-label="Previous page"
                    disabled={page === 0}
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    className="grid size-11 place-items-center disabled:opacity-40 lg:size-6"
                  >
                    <ChevronLeft className="size-4" />
                  </button>
                  <button
                    type="button"
                    aria-label="Next page"
                    disabled={(page + 1) * PAGE_SIZE >= rows.length}
                    onClick={() => setPage((p) => p + 1)}
                    className="grid size-11 place-items-center disabled:opacity-40 lg:size-6"
                  >
                    <ChevronRight className="size-4" />
                  </button>
                </span>
              ) : null}
              <Link to="/jobs" className="font-semibold" style={{ color: BLUE }}>
                View all
              </Link>
            </div>
          </div>

          {/* Bottom rail */}
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <RouteCard jobs={rows} />
            <ChecklistCard tasks={tasks} />
            <ScheduleCard jobs={rows} tick={tick} onSelect={setSelId} />
            <FunnelCard funnel={funnel} />
          </div>
        </div>

        {/* Right panel */}
        {selected ? <JobPanel job={selected} onClose={() => setSelId("__none__")} /> : null}
      </div>
    </div>
  );
}

/* ---------------- header pieces ---------------- */

const SHIFTS = ["7:00 AM – 7:00 PM", "7:00 PM – 7:00 AM", "9:00 AM – 5:00 PM"];

function ShiftSelector() {
  const [shift, setShift] = useState(SHIFTS[0]!);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={`flex h-10 items-center gap-2.5 px-3 text-left ${CARD}`}>
          <CalendarDays className="size-4" style={{ color: MUTED }} />
          <span className="leading-tight">
            <span className="block text-[12px] font-semibold">My Shift</span>
            <span className="block text-[11px]" style={{ color: MUTED }}>
              {shift}
            </span>
          </span>
          <ChevronDown className="size-4" style={{ color: MUTED }} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {SHIFTS.map((s) => (
          <DropdownMenuItem key={s} onSelect={() => setShift(s)}>
            {s}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Kpi({
  icon: Icon,
  tint,
  color,
  label,
  value,
  delta,
  deltaColor,
  noArrow,
}: {
  icon: typeof Flame;
  tint: string;
  color: string;
  label: string;
  value: string;
  delta: string;
  deltaColor: string;
  noArrow?: boolean;
}) {
  return (
    <div className={`${CARD} px-4 py-3.5`}>
      <div className="flex items-start gap-3">
        <span
          className="grid size-10 shrink-0 place-items-center rounded-[10px]"
          style={{ background: tint }}
        >
          <Icon className="size-5" style={{ color }} />
        </span>
        <div className="min-w-0">
          <div className="text-[13px] font-medium" style={{ color: MUTED }}>
            {label}
          </div>
          <FitText className="mt-0.5 text-[26px] font-extrabold leading-none tabular-nums">
            {value}
          </FitText>
          <div className="mt-1.5 text-[11px] font-semibold" style={{ color: deltaColor }}>
            {noArrow ? "" : "▲ "}
            {delta}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------- bottom rail ---------------- */

function RouteCard({ jobs }: { jobs: ChaseJob[] }) {
  const stops = jobs.filter((j) => j.lat != null && j.lon != null).slice(0, 6);
  const miles = useMemo(() => {
    let m = 0;
    for (let i = 1; i < stops.length; i++) {
      const a = stops[i - 1]!;
      const b = stops[i]!;
      const dLat = ((b.lat! - a.lat!) * Math.PI) / 180;
      const dLon = ((b.lon! - a.lon!) * Math.PI) / 180;
      const h =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((a.lat! * Math.PI) / 180) *
          Math.cos((b.lat! * Math.PI) / 180) *
          Math.sin(dLon / 2) ** 2;
      m += 7917.5 * Math.asin(Math.sqrt(h));
    }
    return m;
  }, [stops]);

  return (
    <div className={`${CARD} flex flex-col p-3.5`}>
      <h2 className="text-[14px] font-bold">Today&apos;s Route</h2>
      <p className="mt-0.5 text-[12px]" style={{ color: MUTED }}>
        {stops.length} appointment{stops.length === 1 ? "" : "s"} · {miles.toFixed(1)} miles
      </p>
      <LiveMap
        className="mt-2.5 !rounded-[10px] border-[var(--border)]"
        height={132}
        markers={stops.map((s, i) => ({
          id: s.id,
          lat: s.lat!,
          lon: s.lon!,
          label: `${i + 1}. ${s.address ?? ""}`,
          color: LOSS_COLOR[s.loss_type ?? ""] ?? "#F26522",
        }))}
        emptyMessage="No mapped stops today"
      />
      <a
        href={
          stops.length
            ? mapsDeepLink(stops[0]!.address ?? "", stops[0]!.lat, stops[0]!.lon)
            : "https://maps.google.com"
        }
        target="_blank"
        rel={EXTERNAL_LINK_REL}
        className="mt-2.5 grid h-9 place-items-center rounded-[8px] border border-[var(--border)] text-[12px] font-semibold"
      >
        Open in Maps
      </a>
    </div>
  );
}

function ChecklistCard({ tasks }: { tasks: { id: string; title: string; status: string }[] }) {
  const qc = useQueryClient();
  const { disabled } = useWritesDisabled();
  const done = tasks.filter((t) => t.status === "done").length;
  const shown = tasks.slice(0, 7);

  const toggle = async (id: string, status: string) => {
    const next = status === "done" ? "open" : "done";
    const { error } = await supabase
      .from("tasks")
      .update({ status: next, completed_at: next === "done" ? new Date().toISOString() : null })
      .eq("id", id);
    if (error) toast.error(error.message);
    else qc.invalidateQueries({ queryKey: ["chase"] });
  };

  return (
    <div className={`${CARD} p-3.5`}>
      <h2 className="text-[14px] font-bold">Task Checklist</h2>
      <p className="mt-0.5 text-[12px]" style={{ color: MUTED }}>
        {done} of {tasks.length} completed
      </p>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--border)]">
        <div
          className="h-full rounded-full"
          style={{ width: `${tasks.length ? (done / tasks.length) * 100 : 0}%`, background: BLUE }}
        />
      </div>
      <ul className="mt-2.5 space-y-1.5">
        {shown.map((t) => {
          const isDone = t.status === "done";
          return (
            <li key={t.id} className="flex items-center gap-2 text-[12.5px]">
              <button
                type="button"
                disabled={disabled}
                onClick={() => void toggle(t.id, t.status)}
                className="grid size-[16px] shrink-0 place-items-center rounded-[4px] border"
                style={
                  isDone
                    ? { background: GREEN, borderColor: GREEN }
                    : { borderColor: "var(--border)", background: "#fff" }
                }
                aria-label={isDone ? "Mark not done" : "Mark done"}
              >
                {isDone ? <Check className="size-3 text-white" /> : null}
              </button>
              <span className="truncate" style={isDone ? { color: MUTED } : undefined}>
                {t.title}
              </span>
            </li>
          );
        })}
        {tasks.length === 0 && (
          <li className="text-[12.5px]" style={{ color: MUTED }}>
            Nothing assigned to you.
          </li>
        )}
      </ul>
      <Link
        to="/tasks"
        className="mt-2.5 block text-center text-[12px] font-semibold"
        style={{ color: BLUE }}
      >
        View all tasks
      </Link>
    </div>
  );
}

function ScheduleCard({
  jobs,
  tick,
  onSelect,
}: {
  jobs: ChaseJob[];
  tick: number;
  onSelect: (id: string) => void;
}) {
  const stops = jobs
    .filter((j) => j.appt_at)
    .sort((a, b) => (a.appt_at! < b.appt_at! ? -1 : 1))
    .slice(0, 4);
  const nowIdx = stops.findIndex((s) => new Date(s.appt_at!).getTime() >= tick);

  return (
    <div className={`${CARD} p-3.5`}>
      <h2 className="text-[14px] font-bold">Upcoming Schedule</h2>
      <p className="mt-0.5 text-[12px]" style={{ color: MUTED }}>
        Today
      </p>
      <ul className="mt-2 space-y-2.5 border-l border-[#E3E8F0] pl-3">
        {stops.map((s, i) => (
          <li key={s.id} className="relative">
            <span
              className="absolute -left-[17px] top-1.5 size-[7px] rounded-full"
              style={{ background: i === nowIdx ? "var(--destructive)" : BLUE }}
            />
            <button
              type="button"
              onClick={() => onSelect(s.id)}
              className="flex w-full items-start justify-between gap-2 text-left"
            >
              <span className="min-w-0">
                <span className="block text-[12px] font-semibold">{timeAt(s.appt_at)}</span>
                <span className="block truncate text-[12.5px] font-semibold">
                  {s.address ?? s.job_number}
                </span>
                <span className="block truncate text-[11.5px]" style={{ color: MUTED }}>
                  {s.cityLine}
                </span>
              </span>
              <span
                className="shrink-0 text-[11px] font-bold"
                style={{ color: i === nowIdx ? "var(--destructive)" : MUTED }}
              >
                {i === nowIdx && new Date(s.appt_at!).getTime() - tick < 3_600_000
                  ? "Now"
                  : countdown(s.appt_at, tick)}
              </span>
            </button>
          </li>
        ))}
        {stops.length === 0 && (
          <li className="text-[12.5px]" style={{ color: MUTED }}>
            Nothing scheduled.
          </li>
        )}
      </ul>
      <Link
        to="/routes"
        className="mt-2.5 block text-center text-[12px] font-semibold"
        style={{ color: BLUE }}
      >
        Full schedule
      </Link>
    </div>
  );
}

function FunnelCard({
  funnel,
}: {
  funnel:
    | { leads: number; inspections: number; estimates: number; won: number; revenue: number }
    | undefined;
}) {
  const f = funnel ?? { leads: 0, inspections: 0, estimates: 0, won: 0, revenue: 0 };
  const steps: { label: string; value: number; color: string }[] = [
    { label: "Leads", value: f.leads, color: "#CFE2FB" },
    { label: "Inspections", value: f.inspections, color: "#AFD1F8" },
    { label: "Estimates", value: f.estimates, color: "#8DBEF4" },
    { label: "Won", value: f.won, color: "#34A853" },
  ];
  const max = Math.max(1, ...steps.map((s) => s.value));

  return (
    <div className={`${CARD} p-3.5`}>
      <h2 className="text-[14px] font-bold">My Conversion Funnel</h2>
      <p className="mt-0.5 text-[12px]" style={{ color: MUTED }}>
        This Month
      </p>
      <div className="mt-2 space-y-1">
        {steps.map((s, i) => {
          const pct = i === 0 ? null : Math.round((s.value / Math.max(1, steps[0]!.value)) * 100);
          const width = 100 - i * 12;
          return (
            <div key={s.label} className="flex items-center gap-2">
              <div className="flex-1">
                <div
                  className="mx-auto flex h-[26px] items-center justify-between rounded-[4px] px-2.5 text-[11.5px] font-semibold"
                  style={{
                    width: `${Math.max(40, width * Math.max(0.35, s.value / max))}%`,
                    background: s.color,
                    color: i === 3 ? "#fff" : NAVY,
                  }}
                >
                  <span>{s.label}</span>
                  <span>{s.value}</span>
                </div>
              </div>
              <span className="w-8 shrink-0 text-right text-[11px]" style={{ color: MUTED }}>
                {pct == null ? "" : `${pct}%`}
              </span>
            </div>
          );
        })}
      </div>
      <div className="mt-2.5 text-center">
        <div className="text-[11.5px]" style={{ color: MUTED }}>
          Closed Revenue
        </div>
        <div className="text-[17px] font-extrabold">{money(f.revenue)}</div>
      </div>
      <Link
        to="/chase/performance"
        className="mt-1.5 block text-center text-[12px] font-semibold"
        style={{ color: BLUE }}
      >
        View performance
      </Link>
    </div>
  );
}

/* ---------------- right panel ---------------- */

function JobPanel({ job, onClose }: { job: ChaseJob; onClose: () => void }) {
  const qc = useQueryClient();
  const { disabled } = useWritesDisabled();
  const { stages } = useJobStages(null);
  const prio = priorityOf(taskDueAt(job.next_task) ?? job.appt_at, job.loss_type);
  const steps = timelineOf(job);

  // The photo comes from the server as a data URL (server key, see
  // route-map.functions.ts) rather than a Google URL built here with the
  // public browser key. Keyed on the job so flipping between jobs never shows
  // the previous house, and never re-fetched for the session: every fetch is
  // a billed call, and the street does not change between clicks. Not under
  // the "chase" key on purpose -- a stage change invalidates that whole
  // prefix, and a stage change must not buy another photo.
  const streetView = useQuery({
    queryKey: ["street-view", job.id],
    queryFn: () => streetViewImage({ data: { lat: job.lat!, lon: job.lon! } }),
    enabled: job.lat != null && job.lon != null,
    staleTime: Infinity,
    retry: false,
  });
  const photo = streetView.data?.dataUrl ?? null;

  const setStage = async (stageId: string) => {
    const { error } = await supabase
      .from("jobs")
      .update({ stage_id: stageId, stage_entered_at: new Date().toISOString() })
      .eq("id", job.id);
    if (error) toast.error(error.message);
    else {
      toast.success("Stage updated");
      qc.invalidateQueries({ queryKey: ["chase"] });
    }
  };

  return (
    <aside
      className={`${CARD} sticky top-3 hidden h-[calc(100vh-6rem)] w-[350px] shrink-0 flex-col xl:flex`}
    >
      <div className="flex items-start gap-2.5 border-b border-[var(--border)] px-3.5 py-3">
        <LossIcon type={job.loss_type} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-bold">{job.address ?? job.job_number}</div>
          <div className="truncate text-[12px]" style={{ color: MUTED }}>
            {job.cityLine || "—"}
          </div>
        </div>
        <span
          className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold"
          style={{ background: PRIORITY[prio].bg, color: PRIORITY[prio].fg }}
        >
          {PRIORITY[prio].label} Priority
        </span>
        <button type="button" onClick={onClose} aria-label="Close panel" style={{ color: MUTED }}>
          <X className="size-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3.5 py-3">
        {photo ? (
          <img
            src={photo}
            alt={`Property at ${job.address ?? "the job address"}`}
            className="h-[150px] w-full rounded-[10px] object-cover"
          />
        ) : streetView.isPending && streetView.fetchStatus === "fetching" ? (
          // Same 150px box while the server fetches, so the panel below does
          // not jump when the photo lands (or does not).
          <div
            role="img"
            aria-label="Loading property photo"
            className="h-[150px] w-full animate-pulse rounded-[10px] bg-[var(--surface)]"
          />
        ) : (
          <div
            className="grid h-[150px] w-full place-items-center rounded-[10px] bg-[var(--surface)] text-[12px]"
            style={{ color: MUTED }}
          >
            <span className="flex items-center gap-1.5">
              <ImageIcon className="size-4" /> No property photo yet
            </span>
          </div>
        )}

        <div className="grid grid-cols-3 gap-2 border-b border-[var(--border)] pb-3">
          <Stat label="Stage" value={job.stage ?? "—"} valueColor={BLUE} />
          <Stat label="Est. Value" value={money(job.est_value)} />
          <Stat label="Claim Type" value={job.claim_type ?? "—"} />
        </div>

        <Section title="Owner & Insurance" action="Edit" to={`/jobs/${job.id}`}>
          <div className="grid grid-cols-2 gap-y-0.5 text-[12px]">
            <div className="font-semibold">{job.owner_name ?? "—"}</div>
            <div className="font-semibold">{job.carrier ?? "No carrier"}</div>
            <div style={{ color: MUTED }}>{job.owner_phone ?? "—"}</div>
            <div style={{ color: MUTED }}>
              {job.policy_number ? `Policy # ${job.policy_number}` : "No policy #"}
            </div>
            <div className="truncate" style={{ color: BLUE }}>
              {job.owner_email ?? ""}
            </div>
            <div style={{ color: MUTED }}>
              {job.adjuster_name ? `Adjuster: ${job.adjuster_name}` : "No adjuster"}
            </div>
            <div />
            <div style={{ color: MUTED }}>{job.adjuster_phone ?? ""}</div>
          </div>
        </Section>

        <Section title="Scanner Origin">
          <div className="flex items-start gap-2">
            <span className="grid size-7 shrink-0 place-items-center rounded-[6px] bg-[#EEF3FA] dark:bg-muted">
              <Search className="size-3.5" style={{ color: MUTED }} />
            </span>
            <div className="min-w-0 flex-1 text-[12px]">
              <div className="font-semibold capitalize">
                {(job.incident_source ?? "Manual entry").replace(/_/g, " ")}
              </div>
              <div style={{ color: MUTED }}>Incident feed</div>
            </div>
            <div className="shrink-0 text-[11px]" style={{ color: MUTED }}>
              {dayAt(job.incident_at)} · {timeAt(job.incident_at)}
            </div>
          </div>
        </Section>

        <Section title="Activity Timeline" action="View all" to={`/jobs/${job.id}`}>
          <ul className="space-y-2 border-l border-[#E3E8F0] pl-3">
            {steps.map((s) => (
              <li key={s.key} className="relative text-[12px]">
                <span
                  className="absolute -left-[15px] top-1 grid size-[9px] place-items-center rounded-full border-2"
                  style={{
                    borderColor: s.done ? GREEN : "var(--border)",
                    background: s.done ? GREEN : "#fff",
                  }}
                />
                <div className="font-semibold">{s.label}</div>
                <div style={{ color: MUTED }}>
                  {s.at ? `${dayAt(s.at)}, ${timeAt(s.at)}` : "Pending"}
                </div>
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Notes" action="Edit" to={`/jobs/${job.id}`}>
          <p className="text-[12px] leading-snug" style={{ color: job.note ? undefined : MUTED }}>
            {job.note ?? "No notes on this job yet."}
          </p>
        </Section>

        <Section title="Documents" action="View all" to={`/jobs/${job.id}`}>
          <ul className="space-y-1.5">
            {job.documents.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-2 text-[12px]">
                <span className="flex min-w-0 items-center gap-1.5">
                  <FileText className="size-3.5 shrink-0" style={{ color: BLUE }} />
                  <span className="truncate">{d.name}</span>
                </span>
                <span className="shrink-0 text-[11px]" style={{ color: MUTED }}>
                  {dayAt(d.at)}
                </span>
              </li>
            ))}
            {job.documents.length === 0 && (
              <li className="text-[12px]" style={{ color: MUTED }}>
                No documents yet.
              </li>
            )}
          </ul>
        </Section>
      </div>

      <div className="flex items-center gap-2 border-t border-[var(--border)] px-3.5 py-3">
        <a
          href={job.owner_phone ? `tel:${job.owner_phone}` : undefined}
          className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-[8px] border border-[var(--border)] text-[12px] font-semibold"
          style={{ color: NAVY, opacity: job.owner_phone ? 1 : 0.5 }}
        >
          <Phone className="size-3.5" style={{ color: BLUE }} /> Call Owner
        </a>
        <a
          href={mapsDeepLink(job.address ?? "", job.lat, job.lon)}
          target="_blank"
          rel="noreferrer"
          className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-[8px] border border-[var(--border)] text-[12px] font-semibold"
        >
          <NavIcon className="size-3.5" style={{ color: BLUE }} /> Navigate
        </a>
        <DropdownMenu>
          <DropdownMenuTrigger asChild disabled={disabled}>
            <button
              type="button"
              className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-[8px] text-[12px] font-semibold text-white"
              style={{ background: BLUE }}
            >
              Update Stage <ChevronDown className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {stages.map((s) => (
              <DropdownMenuItem key={s.id} onSelect={() => void setStage(s.id)}>
                {s.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </aside>
  );
}

function Stat({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px]" style={{ color: MUTED }}>
        {label}
      </div>
      <FitText className="text-[12.5px] font-bold" style={{ color: valueColor }}>
        {value}
      </FitText>
    </div>
  );
}

function Section({
  title,
  action,
  to,
  children,
}: {
  title: string;
  action?: string;
  to?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-b border-[var(--border)] pb-3 last:border-0">
      <div className="mb-1.5 flex items-center justify-between">
        <h3 className="text-[11px] font-bold uppercase tracking-[0.06em]">{title}</h3>
        {action && to ? (
          <Link to={to} className="text-[11px] font-semibold" style={{ color: BLUE }}>
            {action}
          </Link>
        ) : null}
      </div>
      {children}
    </section>
  );
}
