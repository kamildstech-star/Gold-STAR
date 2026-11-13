import { useEffect, useMemo, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { CalendarDays, ChevronDown, ChevronUp, X } from "lucide-react";

import { useAppContext } from "@/components/app-context";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toastDbError } from "@/lib/db-errors";
import { money } from "@/lib/finance";
import { canSeeMoney } from "@/lib/roles";
import { GOAL_METRICS, goalWindow, type ActivityMetric, type GoalPeriod } from "@/lib/goals";
import {
  STATUS_LABEL,
  TEAM_ACTIVITY_METRICS,
  fetchTeamGoals,
  initialsOf,
  saveTeamGoals,
  type TeamGoalsData,
  type TeamRow,
  type TeamStatus,
} from "@/lib/team-goals";
import { cn } from "@/lib/utils";
import { FitText } from "@/components/ui/fit-text";

/**
 * Team Goals — the manager's side of My Goals.
 *
 * Every figure here comes from the same `goals` rows the rep sees on My Goals
 * and the dashboard card reads, so there is exactly one number for a target.
 * Status is pace, computed on the fly. Revenue obeys the money rule: a rep
 * never sees a dollar figure here, leadership does.
 */

export const Route = createFileRoute("/_authenticated/team-goals")({
  head: () => ({
    meta: [
      { title: "Team Goals · Recovery Hub" },
      {
        name: "description",
        content:
          "Set and track revenue, jobs won, conversion and activity targets for the sales team, with pace-based status for every rep.",
      },
      { name: "robots", content: "noindex,nofollow" },
      { property: "og:title", content: "Team Goals · Recovery Hub" },
      {
        property: "og:description",
        content: "Manager view of team targets, attainment and pace.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: TeamGoalsPage,
});

/* ------------------------------------------------------------------ */
/* Small pieces                                                        */
/* ------------------------------------------------------------------ */

const pctText = (r: number | null) => (r == null ? "—" : `${Math.round(r * 100)}%`);

function barTone(status: TeamStatus) {
  return status === "needs_attention" ? "bg-warning" : "bg-success";
}
function pctTone(status: TeamStatus) {
  return status === "needs_attention" ? "text-warning" : "text-success";
}

function Bar({
  ratio,
  tone,
  className,
}: {
  ratio: number | null;
  tone: string;
  className?: string;
}) {
  const w = ratio == null ? 0 : Math.max(0, Math.min(1, ratio));
  return (
    <div className={cn("h-2 w-full overflow-hidden rounded-full bg-muted", className)}>
      <div
        className={cn("h-full rounded-full transition-[width] duration-500", tone)}
        style={{ width: `${w * 100}%` }}
      />
    </div>
  );
}

function SummaryCard({
  title,
  value,
  target,
  ratio,
  tone,
  pctClass,
}: {
  title: string;
  value: string;
  target: string;
  ratio: number | null;
  tone: string;
  pctClass: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-[var(--shadow-card)]">
      <div className="text-[15px] font-semibold text-foreground">{title}</div>
      <div className="mt-2 flex items-baseline gap-1.5">
        <FitText className="font-display text-[30px] font-bold leading-none tracking-tight tabular-nums text-foreground">
          {value}
        </FitText>
        <span className="shrink-0 text-[15px] font-medium text-muted-foreground">/ {target}</span>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <Bar ratio={ratio} tone={tone} />
        <span
          className={cn(
            "w-10 shrink-0 text-right text-[13px] font-semibold tabular-nums",
            pctClass,
          )}
        >
          {pctText(ratio)}
        </span>
      </div>
    </div>
  );
}

const CHIP: Record<TeamStatus, string> = {
  ahead: "bg-success/12 text-success",
  on_track: "bg-success/12 text-success",
  needs_attention: "bg-warning/12 text-warning",
  no_goals: "bg-muted text-muted-foreground",
};

function StatusChip({ status }: { status: TeamStatus }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-2.5 py-1 text-[12px] font-semibold whitespace-nowrap",
        CHIP[status],
      )}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

type SortKey = "name" | "revenue" | "jobs" | "conversion" | "progress" | "status";

function TeamGoalsPage() {
  const app = useAppContext();
  const navigate = useNavigate();
  const showMoney = canSeeMoney(app.roles);

  const [period, setPeriod] = useState<GoalPeriod>("quarter");
  const [team, setTeam] = useState<string>("all");
  const [data, setData] = useState<TeamGoalsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({
    key: "progress",
    dir: "desc",
  });
  const [panel, setPanel] = useState<{ rows: TeamRow[]; bulk: boolean } | null>(null);

  const win = useMemo(() => goalWindow(period), [period]);
  const locationIds = useMemo(() => {
    if (team !== "all") return [team];
    if (app.currentLocationId) return [app.currentLocationId];
    return null;
  }, [team, app.currentLocationId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchTeamGoals(period, locationIds)
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && toastDbError(e, { action: "load team goals" }))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [period, locationIds?.join(","), reload]);

  const rows = useMemo(() => {
    const list = [...(data?.rows ?? [])];
    const dir = sort.dir === "asc" ? 1 : -1;
    const val = (r: TeamRow) => {
      switch (sort.key) {
        case "name":
          return r.name.toLowerCase();
        case "revenue":
          return r.revenue.actual ?? -1;
        case "jobs":
          return r.jobs.actual ?? -1;
        case "conversion":
          return r.conversion.actual ?? -1;
        case "status":
          return ["needs_attention", "no_goals", "on_track", "ahead"].indexOf(r.status);
        default:
          return r.progress ?? -1;
      }
    };
    return list.sort((a, b) => {
      const av = val(a);
      const bv = val(b);
      if (typeof av === "string" && typeof bv === "string") return av.localeCompare(bv) * dir;
      return ((av as number) - (bv as number)) * dir;
    });
  }, [data, sort]);

  const toggleSort = (key: SortKey) =>
    setSort((s) => ({ key, dir: s.key === key && s.dir === "desc" ? "asc" : "desc" }));

  const summary = data?.summary;

  return (
    <div className="mx-auto w-full max-w-[1180px] px-6 py-6">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="mr-auto font-display text-[28px] font-bold leading-none tracking-tight text-foreground">
          Team Goals
        </h1>

        <Select value={period} onValueChange={(v) => setPeriod(v as GoalPeriod)}>
          <SelectTrigger className="h-10 w-[150px] gap-2 rounded-lg text-[14px] font-medium">
            <CalendarDays className="size-4 text-muted-foreground" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="month">{goalWindow("month").label}</SelectItem>
            <SelectItem value="quarter">{goalWindow("quarter").label}</SelectItem>
            <SelectItem value="year">{goalWindow("year").label}</SelectItem>
          </SelectContent>
        </Select>

        <Select value={team} onValueChange={setTeam}>
          <SelectTrigger className="h-10 w-[150px] rounded-lg text-[14px] font-medium">
            <SelectValue placeholder="All Teams" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Teams</SelectItem>
            {app.visibleLocations.map((l) => (
              <SelectItem key={l.id} value={l.id}>
                {l.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button
          className="h-10 rounded-lg px-4 text-[14px] font-semibold"
          onClick={() => setPanel({ rows: data?.rows ?? [], bulk: true })}
        >
          Set Goals
        </Button>
      </div>

      {/* Summary */}
      <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <SummaryCard
          title="Revenue"
          value={
            showMoney
              ? money(summary?.revenue.actual ?? 0)
              : pctText(summary?.revenue.ratio ?? null)
          }
          target={showMoney ? money(summary?.revenue.target ?? 0) : "target"}
          ratio={summary?.revenue.ratio ?? null}
          tone="bg-success"
          pctClass="text-success"
        />
        <SummaryCard
          title="Jobs Won"
          value={String(summary?.jobs.actual ?? 0)}
          target={summary?.jobs.target == null ? "—" : String(Math.round(summary.jobs.target))}
          ratio={summary?.jobs.ratio ?? null}
          tone="bg-primary"
          pctClass="text-primary"
        />
        <SummaryCard
          title="Team On Track"
          value={String(summary?.onTrack ?? 0)}
          target={String(summary?.teamSize ?? 0)}
          ratio={summary && summary.teamSize > 0 ? summary.onTrack / summary.teamSize : null}
          tone="bg-success"
          pctClass="text-success"
        />
      </div>

      {/* Sales team */}
      <div className="mt-4 rounded-xl border border-border bg-card shadow-[var(--shadow-card)]">
        <div className="px-5 py-4">
          <h2 className="font-display text-[19px] font-bold tracking-tight text-foreground">
            Sales Team
          </h2>
        </div>

        <div className="overflow-x-auto md:max-h-[75svh] md:overflow-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-y border-border text-[13px] text-muted-foreground">
                <Th onClick={() => toggleSort("name")} sort={sort} k="name" align="left">
                  Salesperson
                </Th>
                <Th onClick={() => toggleSort("revenue")} sort={sort} k="revenue">
                  Revenue
                </Th>
                <Th onClick={() => toggleSort("jobs")} sort={sort} k="jobs">
                  Jobs Won
                </Th>
                <Th onClick={() => toggleSort("conversion")} sort={sort} k="conversion">
                  Conversion
                </Th>
                <th className="px-5 py-2.5 text-left font-medium">Activity</th>
                <Th onClick={() => toggleSort("progress")} sort={sort} k="progress" align="center">
                  Overall Progress
                </Th>
                <Th onClick={() => toggleSort("status")} sort={sort} k="status" align="center">
                  Status
                </Th>
                <th className="w-[92px] px-5 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={8}
                    className="px-5 py-10 text-center text-[13px] text-muted-foreground"
                  >
                    Loading the team…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={8}
                    className="px-5 py-10 text-center text-[13px] text-muted-foreground"
                  >
                    Nobody in this team yet.
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr
                    key={r.userId}
                    className="cursor-pointer border-b border-border last:border-0 hover:bg-hover"
                    onClick={() =>
                      navigate({ to: "/my-goals", search: { u: r.userId, p: period } })
                    }
                  >
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-3">
                        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-[12px] font-semibold text-muted-foreground">
                          {initialsOf(r.name)}
                        </span>
                        <span className="text-[15px] font-medium text-foreground">{r.name}</span>
                      </div>
                    </td>
                    <td className="px-5 py-3 text-right text-[14px] tabular-nums text-foreground">
                      {showMoney && r.moneyVisible
                        ? money(r.revenue.actual ?? 0)
                        : pctText(r.revenue.ratio)}
                    </td>
                    <td className="px-5 py-3 text-right text-[14px] tabular-nums text-foreground">
                      {r.jobs.actual ?? 0}
                    </td>
                    <td className="px-5 py-3 text-right text-[14px] tabular-nums text-foreground">
                      {r.conversion.actual == null
                        ? "—"
                        : `${Math.round(r.conversion.actual * 100)}%`}
                    </td>
                    <td className="px-5 py-3">
                      <ActivityCell row={r} />
                    </td>
                    <td className="px-5 py-3">
                      <div className="mx-auto flex w-[190px] items-center gap-3">
                        <Bar ratio={r.progress} tone={barTone(r.status)} />
                        <span
                          className={cn(
                            "w-9 shrink-0 text-right text-[13px] font-semibold tabular-nums",
                            pctTone(r.status),
                          )}
                        >
                          {pctText(r.progress)}
                        </span>
                      </div>
                    </td>
                    <td className="px-5 py-3 text-center">
                      <StatusChip status={r.status} />
                    </td>
                    <td className="px-5 py-3 text-right">
                      <Button
                        variant="outline"
                        className="h-8 rounded-lg px-4 text-[13px] font-medium text-primary"
                        onClick={(e) => {
                          e.stopPropagation();
                          setPanel({ rows: [r], bulk: false });
                        }}
                      >
                        Edit
                      </Button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {panel ? (
        <SetGoalsPanel
          rows={panel.rows}
          bulk={panel.bulk}
          period={period}
          defaultEndsOn={win.endsOn}
          startsOn={win.startsOn}
          showMoney={showMoney}
          setBy={app.userId}
          onClose={() => setPanel(null)}
          onSaved={() => {
            setPanel(null);
            setReload((n) => n + 1);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * The six activity goals, one line each, only for the metrics this rep has a
 * target on. Six more columns would push the table past any screen; a rep
 * with no activity goals shows a dash, exactly as an unset revenue goal does.
 */
function ActivityCell({ row }: { row: TeamRow }) {
  const set = TEAM_ACTIVITY_METRICS.filter((m) => row.activity[m].target != null);
  if (set.length === 0) return <span className="text-[13px] text-muted-foreground">—</span>;
  return (
    <div className="flex flex-col gap-0.5 text-[12px] tabular-nums">
      {set.map((m) => {
        const f = row.activity[m];
        return (
          <span key={m} className="whitespace-nowrap">
            <span className="text-muted-foreground">{GOAL_METRICS[m].label}</span>{" "}
            <span className="font-medium text-foreground">
              {GOAL_METRICS[m].format(f.actual)} / {GOAL_METRICS[m].format(f.target)}
            </span>
          </span>
        );
      })}
    </div>
  );
}

function Th({
  children,
  onClick,
  sort,
  k,
  align = "right",
}: {
  children: React.ReactNode;
  onClick: () => void;
  sort: { key: SortKey; dir: "asc" | "desc" };
  k: SortKey;
  align?: "left" | "right" | "center";
}) {
  const active = sort.key === k;
  return (
    <th
      className={cn(
        "select-none px-5 py-2.5 font-medium",
        align === "left" ? "text-left" : align === "center" ? "text-center" : "text-right",
      )}
    >
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "inline-flex items-center gap-1 hover:text-foreground",
          active && "text-foreground",
        )}
      >
        {children}
        {active ? (
          sort.dir === "desc" ? (
            <ChevronDown className="size-3.5" />
          ) : (
            <ChevronUp className="size-3.5" />
          )
        ) : null}
      </button>
    </th>
  );
}

/* ------------------------------------------------------------------ */
/* Set Goals panel                                                     */
/* ------------------------------------------------------------------ */

function SetGoalsPanel({
  rows,
  bulk,
  period,
  startsOn,
  defaultEndsOn,
  showMoney,
  setBy,
  onClose,
  onSaved,
}: {
  rows: TeamRow[];
  bulk: boolean;
  period: GoalPeriod;
  startsOn: string;
  defaultEndsOn: string;
  showMoney: boolean;
  setBy: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const single = !bulk && rows.length === 1 ? rows[0]! : null;
  const [selected, setSelected] = useState<string[]>(single ? [single.userId] : []);
  const [revenue, setRevenue] = useState(
    single?.revenue.target != null ? String(Math.round(single.revenue.target)) : "",
  );
  const [jobs, setJobs] = useState(
    single?.jobs.target != null ? String(Math.round(single.jobs.target)) : "",
  );
  const [conversion, setConversion] = useState(
    single?.conversion.target != null ? String(Math.round(single.conversion.target * 100)) : "",
  );
  // One string per activity goal, seeded from the rep's current target the
  // way the three above are. Blank means "leave this one alone" on save.
  const [activity, setActivity] = useState<Record<ActivityMetric, string>>(
    () =>
      Object.fromEntries(
        TEAM_ACTIVITY_METRICS.map((m) => {
          const t = single?.activity[m].target;
          return [m, t != null ? String(Math.round(t)) : ""];
        }),
      ) as Record<ActivityMetric, string>,
  );
  const [endsOn, setEndsOn] = useState(defaultEndsOn);
  const [saving, setSaving] = useState(false);

  const targets = single ? [single.userId] : selected;

  const num = (v: string) => {
    const n = Number(v.replace(/[^0-9.]/g, ""));
    return v.trim() === "" || Number.isNaN(n) ? null : n;
  };

  const save = async () => {
    if (targets.length === 0) {
      toast.error("Pick at least one rep.");
      return;
    }
    setSaving(true);
    try {
      const existing = new Map(rows.map((r) => [r.userId, r.goals]));
      await saveTeamGoals({
        userIds: targets,
        period,
        revenue: num(revenue),
        jobs: num(jobs),
        conversion: num(conversion),
        activity: Object.fromEntries(
          TEAM_ACTIVITY_METRICS.map((m) => [m, num(activity[m])]),
        ) as Partial<Record<ActivityMetric, number | null>>,
        startsOn,
        endsOn,
        setBy,
        existing,
        locationFor: (id) => rows.find((r) => r.userId === id)?.locationIds[0] ?? null,
      });
      toast.success(
        targets.length === 1
          ? "Goals saved and the rep was notified."
          : `Goals saved for ${targets.length} reps.`,
      );
      onSaved();
    } catch (e) {
      toastDbError(e, { action: "save goals" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-foreground/20"
        onClick={onClose}
      />
      <aside className="relative flex h-full w-full max-w-[420px] flex-col overflow-y-auto border-l border-border bg-card px-6 py-6 shadow-xl">
        <div className="flex items-start gap-3">
          <h2 className="mr-auto font-display text-[20px] font-bold tracking-tight text-foreground">
            Set Goals — {single ? single.name : `${targets.length || "0"} reps`}
          </h2>
          <button type="button" onClick={onClose} aria-label="Close panel">
            <X className="size-5 text-muted-foreground hover:text-foreground" />
          </button>
        </div>

        {!single ? (
          <div className="mt-5">
            <div className="text-[14px] font-semibold text-foreground">Apply to</div>
            <div className="mt-2 max-h-[184px] overflow-y-auto rounded-lg border border-border">
              {rows.map((r) => (
                <label
                  key={r.userId}
                  className="flex cursor-pointer items-center gap-2.5 border-b border-border px-3 py-2 last:border-0 hover:bg-hover"
                >
                  <Checkbox
                    checked={selected.includes(r.userId)}
                    onCheckedChange={(c) =>
                      setSelected((s) => (c ? [...s, r.userId] : s.filter((id) => id !== r.userId)))
                    }
                  />
                  <span className="text-[14px] text-foreground">{r.name}</span>
                </label>
              ))}
            </div>
          </div>
        ) : null}

        {/* Mark, from a screenshot of this panel reading "$ 100000": "add
            commas for thousands millions hundred thousands, etc". The two
            goals that can run into the thousands group as you type; the
            conversion percentage below never gets there, so it stays a plain
            box. The draft is still the clean digit string `num()` expects. */}
        <Field label="Revenue Goal">
          <div className="relative">
            <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[15px] text-muted-foreground">
              $
            </span>
            <NumberInput
              decimals={0}
              value={revenue}
              onValueChange={(_, clean) => setRevenue(clean)}
              placeholder={showMoney ? "180,000" : "—"}
              className="h-12 rounded-lg pl-8 text-[15px]"
            />
          </div>
        </Field>

        <Field label="Jobs Goal">
          <NumberInput
            decimals={0}
            value={jobs}
            onValueChange={(_, clean) => setJobs(clean)}
            placeholder="24"
            className="h-12 rounded-lg text-[15px]"
          />
        </Field>

        <Field label="Conversion Goal (%)">
          <Input
            inputMode="numeric"
            value={conversion}
            onChange={(e) => setConversion(e.target.value)}
            placeholder="38"
            className="h-12 rounded-lg text-[15px]"
          />
        </Field>

        {/*
          Mark, 16 Sep 2026: "add fires chased, cold leak converted, cold
          calls, new deals worked on, active client reach out ..., cold email
          outreach". Same input as the three above, one field per metric, in
          the catalogue's order: prospecting, then the client one, then fires.
        */}
        {TEAM_ACTIVITY_METRICS.map((m) => (
          <Field key={m} label={ACTIVITY_FIELD[m].label}>
            <Input
              inputMode="numeric"
              value={activity[m]}
              onChange={(e) => setActivity((a) => ({ ...a, [m]: e.target.value }))}
              placeholder={ACTIVITY_FIELD[m].placeholder}
              className="h-12 rounded-lg text-[15px]"
            />
          </Field>
        ))}

        <Field label="End Date">
          <div className="relative">
            <CalendarDays className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="date"
              value={endsOn}
              onChange={(e) => setEndsOn(e.target.value)}
              className="h-12 rounded-lg pl-10 text-[15px]"
            />
          </div>
        </Field>

        <div className="mt-auto space-y-3 pt-8">
          <Button
            className="h-13 w-full rounded-lg py-4 text-[16px] font-semibold"
            disabled={saving}
            onClick={save}
          >
            {saving ? "Saving…" : "Save Goals"}
          </Button>
          <Button
            variant="outline"
            className="h-13 w-full rounded-lg py-4 text-[16px] font-medium text-primary"
            onClick={onClose}
          >
            Cancel
          </Button>
        </div>
      </aside>
    </div>
  );
}

/**
 * Field titles in the panel's own style ("Revenue Goal", "Jobs Goal"), and an
 * example target the way "24" and "38" hint at the shape of a number above.
 */
const ACTIVITY_FIELD: Record<ActivityMetric, { label: string; placeholder: string }> = {
  cold_calls: { label: "Cold Calls Goal", placeholder: "100" },
  cold_emails: { label: "Cold Email Outreach Goal", placeholder: "60" },
  new_deals_worked: { label: "New Deals Worked On Goal", placeholder: "20" },
  cold_leads_converted: { label: "Cold Leads Converted Goal", placeholder: "5" },
  active_client_reach_outs: { label: "Active Client Reach-Out Goal", placeholder: "40" },
  fires_chased: { label: "Fires Chased Goal", placeholder: "10" },
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-5">
      <div className="mb-2 text-[14px] font-semibold text-foreground">{label}</div>
      {children}
    </div>
  );
}
