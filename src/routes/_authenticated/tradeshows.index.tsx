import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import type { SearchSchemaInput } from "@tanstack/react-router";
import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Archive,
  Briefcase,
  CalendarDays,
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  DollarSign,
  Plus,
  UserPlus,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";

import { useAppContext } from "@/components/app-context";
import { DateRangeDialog } from "@/components/date-range-dialog";
import { LocationPicker } from "@/components/location-picker";
import { ShowDialog } from "@/components/tradeshow-show-dialog";
import { RafflesBoard, type RaffleSection } from "@/components/raffles-board";
import { PageHeader } from "@/components/ui-density";
import { MetricStrip } from "@/components/metric-strip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toastDbError } from "@/lib/db-errors";
import { isDay } from "@/lib/leaderboard-window";
import { canManageTradeshows } from "@/lib/roles";
import {
  SHOW_PERIOD_PRESETS,
  isShowPeriod,
  periodTotals,
  previousPeriodLabel,
  showPeriodLabel,
  showWindowFor,
  showsInPeriod,
  showsInPreviousPeriod,
  type ShowPeriod,
} from "@/lib/tradeshow-period";
import {
  archiveTradeshow,
  costPerAccount,
  fetchTradeshowRoi,
  fetchTradeshows,
  formatShowDates,
  saveTradeshow,
  showMoney,
  tradeshowLeadCount,
  type Tradeshow,
} from "@/lib/tradeshows";

export const Route = createFileRoute("/_authenticated/tradeshows/")({
  head: () => ({
    meta: [
      { title: "Tradeshows · Recovery Hub" },
      {
        name: "description",
        content:
          "Track tradeshows as a source: cost, leads captured, accounts created and jobs won, so you know which shows are worth attending.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  /* The period rides the URL the way the pipeline's and leaderboard's do, so
     "how much did we spend in 2023" is a link someone can send:
     `?period=custom&from=2023-01-01&to=2023-12-31`. Absent means all time,
     which is what the page always showed. */
  validateSearch: (raw: Record<string, unknown> & SearchSchemaInput) => ({
    period: (isShowPeriod(raw.period) ? raw.period : "all") as ShowPeriod,
    from: isDay(raw.from) ? raw.from : "",
    to: isDay(raw.to) ? raw.to : "",
    /* Mark, 10 Nov: raffles are a view of this page, beside Calendar and List. */
    ...(raw.view === "raffles" ? { view: "raffles" as const } : {}),
    ...(raw.section === "prizes" || raw.section === "winners"
      ? { section: raw.section as RaffleSection }
      : {}),
  }),
  component: TradeshowsPage,
});

const money = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;

function TradeshowsPage() {
  const app = useAppContext();
  const qc = useQueryClient();
  const canManage = canManageTradeshows(app.roles);
  /** Money rule: spend and return are a leadership view, never a rep view
      (Melly, 29 Oct). The show page applies the same rule. */
  const canSeeMoney = canManage;

  const navigate = useNavigate({ from: Route.fullPath });
  const search = Route.useSearch();
  const update = (patch: Partial<typeof search>) =>
    navigate({ search: (prev) => ({ ...prev, ...patch }) });
  /* "custom" only counts once both days are in the URL; until Apply writes
     them the page stays on all time. */
  const customRange = React.useMemo(
    () => (search.from && search.to ? { from: search.from, to: search.to } : null),
    [search.from, search.to],
  );
  const period: ShowPeriod = search.period === "custom" && !customRange ? "all" : search.period;
  const periodWindow = React.useMemo(
    () => showWindowFor(period, customRange),
    [period, customRange],
  );
  const periodLabel = showPeriodLabel(period, periodWindow);
  const prevLabel = previousPeriodLabel(period, periodWindow);
  const [rangeOpen, setRangeOpen] = React.useState(false);

  const [editing, setEditing] = React.useState<Tradeshow | "new" | null>(null);
  const [baseView, setBaseView] = React.useState<"calendar" | "list">("calendar");
  const view: "calendar" | "list" | "raffles" = search.view ?? baseView;
  const setView = (v: "calendar" | "list" | "raffles") => {
    if (v !== "raffles") setBaseView(v);
    update({ view: v === "raffles" ? "raffles" : undefined, section: undefined });
  };
  const [month, setMonth] = React.useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });

  const showsQ = useQuery({ queryKey: ["tradeshows"], queryFn: fetchTradeshows });
  const roiQ = useQuery({ queryKey: ["tradeshow-roi"], queryFn: fetchTradeshowRoi });

  const roiById = new Map((roiQ.data ?? []).map((r) => [r.tradeshow_id, r]));
  const allShows = showsQ.data ?? [];
  /* Everything below the header that is about money or conversion — the
     strip, the list, "Best return" — reads from the period's shows. The
     calendar and "Upcoming Events" are about dates, not spend, and keep
     showing every show. */
  const shows = showsInPeriod(allShows, periodWindow);
  const totals = periodTotals(shows, roiById);
  const prevTotals = periodWindow
    ? periodTotals(showsInPreviousPeriod(allShows, periodWindow), roiById)
    : null;

  const todayIso = new Date().toISOString().slice(0, 10);
  const upcomingAll = allShows
    .filter((s) => (s.starts_on ?? "") >= todayIso)
    .sort((a, b) => (a.starts_on ?? "").localeCompare(b.starts_on ?? ""));
  const upcoming = upcomingAll.slice(0, 6);
  const bestRoi = shows
    .map((s) => roiById.get(s.id))
    .filter((r): r is NonNullable<typeof r> => !!r && r.accounts_created > 0)
    .sort((a, b) =>
      canSeeMoney
        ? (costPerAccount(a) ?? 0) - (costPerAccount(b) ?? 0)
        : b.accounts_created - a.accounts_created,
    )
    .slice(0, 5);

  const archive = useMutation({
    mutationFn: archiveTradeshow,
    onSuccess: () => {
      toast.success("Show archived");
      qc.invalidateQueries({ queryKey: ["tradeshows"] });
      qc.invalidateQueries({ queryKey: ["tradeshow-roi"] });
    },
    onError: (e) => toastDbError(e, { action: "archive show" }),
  });

  return (
    <div className="mx-auto max-w-[1400px] space-y-4 px-5 py-5">
      <PageHeader
        title="Tradeshows"
        subtitle="Manage industry events, track leads, and measure ROI."
      >
        <div className="flex items-center gap-1 rounded-lg border bg-card p-1">
          {(["calendar", "list", "raffles"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={cn(
                "rounded-md px-4 py-1.5 text-[13px] font-medium capitalize transition",
                view === v
                  ? "bg-secondary text-primary"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {v}
            </button>
          ))}
        </div>
        {canManage && view !== "raffles" && (
          <Button size="sm" disabled={app.writesDisabled} onClick={() => setEditing("new")}>
            <Plus className="mr-1 h-3.5 w-3.5" /> Add tradeshow
          </Button>
        )}
      </PageHeader>

      {view === "raffles" ? (
        <RafflesBoard
          section={search.section ?? "raffles"}
          onSection={(sec) => update({ section: sec === "raffles" ? undefined : sec })}
        />
      ) : (
        <>
          {/* Mark, from a screenshot of "$71,780 SPENT — $17,945 per account":
              "is this a running total? Is this all time, or should we put by
              quarter, year etc? Like how much did we spend in 2023 on shows etc
              etc". It was all time, and nothing said so. The period scopes the
              strip, the list and Best return by each show's start date; the
              caption on the right spells out what is being counted. */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap rounded-lg border border-border bg-card p-0.5">
              {SHOW_PERIOD_PRESETS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => update({ period: p.key, from: "", to: "" })}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-[12px] font-medium",
                    period === p.key
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {p.label}
                </button>
              ))}
              {/* Opening the picker applies nothing — Apply does. Re-opening
                  while a range is showing starts from that range. */}
              <button
                type="button"
                onClick={() => setRangeOpen(true)}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[12px] font-medium",
                  period === "custom"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <CalendarRange className="h-3.5 w-3.5" />
                Custom
              </button>
            </div>
            <p className="text-[12px] text-muted-foreground">
              {periodWindow
                ? `Shows starting in ${periodLabel} · vs ${prevLabel}`
                : "Every show, all time"}
            </p>
          </div>

          <MetricStrip
            metrics={[
              {
                label: "Upcoming Events",
                value: upcomingAll.length,
                note: "Next 90 days",
                icon: CalendarDays,
              },
              {
                label: "Shows Tracked",
                value: totals.shows,
                note: `${periodLabel} · not archived`,
                icon: Users,
              },
              {
                label: "Leads Captured",
                value: totals.leads,
                note: totals.usingLegacyLeadFallback
                  ? `Legacy estimate — ROI data unavailable · ${periodLabel}`
                  : `Attributed accounts · ${periodLabel}`,
                icon: UserPlus,
              },
              canSeeMoney
                ? {
                    /* The word "Spent" on its own was the ambiguity; the tile now
                       says what it covers, and against what. */
                    label: `Spent · ${periodLabel}`,
                    value: money(totals.cost),
                    note: (
                      <>
                        <span className="block">
                          {totals.costPerAccount != null
                            ? `${money(totals.costPerAccount)} per account`
                            : "No accounts yet"}
                        </span>
                        {prevTotals && prevLabel && (
                          <span className="block">
                            vs {prevLabel}: {money(prevTotals.cost)}
                          </span>
                        )}
                      </>
                    ),
                    icon: DollarSign,
                  }
                : {
                    /* A rep gets the outcome, not the bill. */
                    label: `Jobs won · ${periodLabel}`,
                    value: totals.jobs,
                    note: `${totals.accounts.toLocaleString("en-US")} accounts created`,
                    icon: Briefcase,
                  },
            ]}
          />

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_420px]">
            {view === "calendar" ? (
              <MonthCalendar
                month={month}
                shows={allShows}
                onMonth={setMonth}
                onSelect={(s) => void navigate({ to: "/tradeshows/$id", params: { id: s.id } })}
              />
            ) : (
              <div className="self-start overflow-x-auto md:max-h-[75svh] md:overflow-auto rounded-xl border bg-card shadow-sm">
                <table className="w-full text-left text-[13px]">
                  <thead className="bg-muted text-[11px] uppercase text-muted-foreground">
                    <tr>
                      <th className="px-3 py-1.5 text-left font-medium">Show</th>
                      <th className="px-3 py-1.5 text-left font-medium">Dates</th>
                      {canSeeMoney && <th className="px-3 py-1.5 text-right font-medium">Cost</th>}
                      <th className="px-3 py-1.5 text-right font-medium">Leads</th>
                      <th className="px-3 py-1.5 text-right font-medium">Accounts</th>
                      <th className="px-3 py-1.5 text-right font-medium">Jobs won</th>
                      {canSeeMoney && (
                        <th className="px-3 py-1.5 text-right font-medium">Cost / account</th>
                      )}
                      <th className="px-3 py-1.5" />
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {showsQ.isLoading && (
                      <tr>
                        <td
                          colSpan={canSeeMoney ? 8 : 6}
                          className="px-3 py-6 text-left text-muted-foreground"
                        >
                          Loading…
                        </td>
                      </tr>
                    )}
                    {!showsQ.isLoading && shows.length === 0 && (
                      <tr>
                        <td
                          colSpan={canSeeMoney ? 8 : 6}
                          className="px-3 py-6 text-left text-muted-foreground"
                        >
                          {periodWindow
                            ? `No shows starting in ${periodLabel}.`
                            : "No shows yet. Add one and attribute the accounts it produced."}
                        </td>
                      </tr>
                    )}
                    {shows.map((s) => {
                      const r = roiById.get(s.id);
                      const cpa = r ? costPerAccount(r) : null;
                      const leadCount = tradeshowLeadCount(s, r);
                      return (
                        <tr key={s.id} className="hover:bg-muted/30">
                          <td className="px-3 py-1.5 text-left align-top">
                            <Link
                              to="/tradeshows/$id"
                              params={{ id: s.id }}
                              className="entity-link font-semibold"
                            >
                              {s.name}
                            </Link>
                            <div className="text-[11px] text-muted-foreground">
                              {[s.city, s.state].filter(Boolean).join(", ") || "—"}
                            </div>
                          </td>
                          <td className="whitespace-nowrap px-3 py-1.5 text-left align-top text-muted-foreground">
                            {formatShowDates(s.starts_on, s.ends_on)}
                          </td>
                          {canSeeMoney && (
                            <td className="px-3 py-1.5 text-right align-top tabular-nums">
                              {showMoney(Number(s.cost))}
                            </td>
                          )}
                          <td className="px-3 py-1.5 text-right align-top tabular-nums">
                            <span
                              title={
                                leadCount.source === "legacy"
                                  ? "Legacy estimate shown because attributed-account ROI data is unavailable"
                                  : "Accounts attributed to this show"
                              }
                            >
                              {leadCount.count.toLocaleString("en-US")}
                              {leadCount.source === "legacy" ? "*" : ""}
                            </span>
                          </td>
                          <td className="px-3 py-1.5 text-right align-top tabular-nums">
                            {(r?.accounts_created ?? 0).toLocaleString("en-US")}
                          </td>
                          <td className="px-3 py-1.5 text-right align-top tabular-nums">
                            {(r?.jobs_won ?? 0).toLocaleString("en-US")}
                          </td>
                          {canSeeMoney && (
                            <td className="px-3 py-1.5 text-right align-top tabular-nums">
                              {cpa == null ? "—" : showMoney(cpa)}
                            </td>
                          )}
                          <td className="px-3 py-1.5 text-right align-top">
                            {canManage && (
                              <div className="flex justify-end gap-1">
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-8 px-2 text-xs"
                                  disabled={app.writesDisabled}
                                  onClick={() => setEditing(s)}
                                  aria-label={`Edit ${s.name}`}
                                >
                                  Edit
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-8 px-2 text-xs"
                                  disabled={app.writesDisabled}
                                  onClick={() => archive.mutate(s.id)}
                                  aria-label={`Archive ${s.name}`}
                                >
                                  <Archive className="h-3.5 w-3.5" />
                                </Button>
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            <aside className="space-y-4">
              <section className="rounded-xl border bg-card shadow-sm">
                <header className="flex items-center justify-between border-b px-4 py-3">
                  <h2 className="text-[15px] font-bold">Upcoming Events</h2>
                  <button
                    type="button"
                    onClick={() => setView("list")}
                    className="text-[12px] font-medium text-primary hover:underline"
                  >
                    View all
                  </button>
                </header>
                <div className="divide-y">
                  {upcoming.length === 0 && (
                    <p className="px-4 py-4 text-[12px] text-muted-foreground">
                      Nothing on the calendar.
                    </p>
                  )}
                  {upcoming.map((s) => {
                    const start = s.starts_on ? new Date(`${s.starts_on}T00:00:00`) : null;
                    const end = s.ends_on ? new Date(`${s.ends_on}T00:00:00`) : null;
                    const r = roiById.get(s.id);
                    const leadCount = tradeshowLeadCount(s, r);
                    const cpa = r ? costPerAccount(r) : null;
                    const roiBand =
                      cpa == null ? null : cpa <= 1500 ? "High" : cpa <= 4000 ? "Medium" : "Low";
                    return (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() =>
                          void navigate({ to: "/tradeshows/$id", params: { id: s.id } })
                        }
                        className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-hover"
                      >
                        <span className="w-14 shrink-0">
                          <span className="block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                            {start?.toLocaleDateString("en-US", { month: "short" }) ?? "—"}
                          </span>
                          <span className="block text-[15px] font-bold leading-tight">
                            {start?.getDate() ?? "?"}
                            {end && end.getDate() !== start?.getDate() ? `-${end.getDate()}` : ""}
                          </span>
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-semibold text-primary">
                            {s.name}
                          </span>
                          <span className="block truncate text-[12px] text-muted-foreground">
                            {[s.city, s.state].filter(Boolean).join(", ") || "Location TBC"}
                          </span>
                          <span className="mt-1.5 inline-flex rounded-md bg-accent px-2 py-0.5 text-[11px] font-medium text-accent-foreground">
                            {leadCount.count} {leadCount.source === "legacy" ? "estimated " : ""}
                            leads
                          </span>
                        </span>
                        {roiBand && (
                          <span className="shrink-0 text-right">
                            <span className="block text-[11px] text-muted-foreground">ROI</span>
                            <span
                              className={cn(
                                "block text-[12px] font-semibold",
                                roiBand === "High"
                                  ? "text-success"
                                  : roiBand === "Medium"
                                    ? "text-warning"
                                    : "text-muted-foreground",
                              )}
                            >
                              {roiBand}
                            </span>
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </section>

              <section className="rounded-xl border bg-card p-4 shadow-sm">
                <h2 className="mb-3 text-[15px] font-bold">
                  {canSeeMoney ? "Best return" : "Most accounts"}
                  {periodWindow ? ` · ${periodLabel}` : ""}
                </h2>
                <div className="space-y-2">
                  {bestRoi.length === 0 && (
                    <p className="text-[12px] text-muted-foreground">
                      {periodWindow
                        ? `No attributed accounts from shows starting in ${periodLabel}.`
                        : "No attributed accounts yet."}
                    </p>
                  )}
                  {bestRoi.map((r) => (
                    <div
                      key={r.tradeshow_id}
                      className="flex items-center justify-between text-[13px]"
                    >
                      <span className="min-w-0 truncate pr-2">
                        {shows.find((s) => s.id === r.tradeshow_id)?.name ?? "Show"}
                      </span>
                      <span className="shrink-0 font-mono tabular-nums text-muted-foreground">
                        {canSeeMoney
                          ? `${money(costPerAccount(r) ?? 0)} / account`
                          : `${r.accounts_created.toLocaleString("en-US")} accounts`}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            </aside>
          </div>
        </>
      )}

      <p className="text-[12px] text-muted-foreground">
        Accounts and jobs count here when they are attributed to the show on their own record.
      </p>

      {/* Custom date range — applied on confirm, never as you type. The same
          dialog the pipeline and leaderboard use. */}
      <DateRangeDialog
        open={rangeOpen}
        onOpenChange={setRangeOpen}
        initialFrom={customRange?.from ?? ""}
        initialTo={customRange?.to ?? ""}
        onApply={({ from, to }) => update({ period: "custom", from, to })}
      />

      {editing && (
        <ShowDialog
          show={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            qc.invalidateQueries({ queryKey: ["tradeshows"] });
            qc.invalidateQueries({ queryKey: ["tradeshow-roi"] });
          }}
        />
      )}
    </div>
  );
}

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const EVENT_TONES = [
  "bg-[color-mix(in_oklab,var(--kpi-3)_14%,var(--card))] text-[var(--kpi-3)]",
  "bg-[color-mix(in_oklab,var(--kpi-2)_14%,var(--card))] text-[var(--kpi-2)]",
  "bg-[color-mix(in_oklab,var(--kpi-1)_14%,var(--card))] text-[var(--kpi-1)]",
  "bg-[color-mix(in_oklab,var(--kpi-4)_16%,var(--card))] text-[var(--kpi-4)]",
];

function MonthCalendar({
  month,
  shows,
  onMonth,
  onSelect,
}: {
  month: Date;
  shows: Tradeshow[];
  onMonth: (d: Date) => void;
  onSelect: (s: Tradeshow) => void;
}) {
  const year = month.getFullYear();
  const mon = month.getMonth();
  const first = new Date(year, mon, 1);
  const start = new Date(year, mon, 1 - first.getDay());
  const days = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
  const todayIso = new Date().toISOString().slice(0, 10);
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  const toneFor = (id: string) =>
    EVENT_TONES[Math.abs(id.charCodeAt(0) + id.charCodeAt(id.length - 1)) % EVENT_TONES.length];

  const eventsOn = (d: Date) => {
    const key = iso(d);
    return shows.filter((s) => {
      const a = s.starts_on ?? "";
      const b = s.ends_on || s.starts_on || "";
      return a && key >= a && key <= b;
    });
  };

  return (
    <section className="rounded-xl border bg-card shadow-sm">
      <header className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="text-[15px] font-bold">
          {month.toLocaleDateString("en-US", { month: "long", year: "numeric" })}
        </h2>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={() => onMonth(new Date(year, mon - 1, 1))}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2.5 text-[12px]"
            onClick={() => {
              const n = new Date();
              onMonth(new Date(n.getFullYear(), n.getMonth(), 1));
            }}
          >
            Today
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={() => onMonth(new Date(year, mon + 1, 1))}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <div className="grid grid-cols-7 border-b bg-muted/30 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {DAY_LABELS.map((d) => (
          <div key={d} className="px-2 py-2 text-center">
            {d}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7">
        {days.map((d, i) => {
          const inMonth = d.getMonth() === mon;
          const isToday = iso(d) === todayIso;
          const evts = eventsOn(d);
          return (
            <div
              key={i}
              className={cn(
                "min-h-[92px] border-b border-r p-1.5",
                i % 7 === 6 && "border-r-0",
                !inMonth && "bg-muted/20",
              )}
            >
              <div
                className={cn(
                  "mb-1 flex h-5 w-5 items-center justify-center rounded-full text-[12px] font-medium",
                  isToday && "bg-primary text-primary-foreground",
                  !inMonth && "text-muted-foreground/60",
                )}
              >
                {d.getDate()}
              </div>
              <div className="space-y-1">
                {evts.slice(0, 2).map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => onSelect(s)}
                    className={cn(
                      "block w-full truncate rounded-md px-1.5 py-1 text-left text-[11px] font-medium",
                      toneFor(s.id),
                    )}
                  >
                    {s.name}
                  </button>
                ))}
                {evts.length > 2 && (
                  <span className="block px-1.5 text-[10px] text-muted-foreground">
                    +{evts.length - 2} more
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
