import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { MetricStrip } from "@/components/metric-strip";
import { Button } from "@/components/ui/button";
import { toastDbError } from "@/lib/db-errors";
import { ROLE_LABELS, primaryRole, type AppRole } from "@/lib/roles";
import {
  fetchGoals,
  goalWindow,
  elapsedShare,
  type Goal,
  type GoalPeriod,
  type Motion,
} from "@/lib/goals";
import {
  fetchStandings,
  initialsOf,
  num,
  pct,
  rankStandings,
  usd,
  type Ranked,
  type Standing,
} from "@/lib/leaderboard";
import { carryPeriodSearch } from "@/lib/report-search";
import { cn } from "@/lib/utils";

type TeamFilter = Motion | "all";

const TEAMS: { key: TeamFilter; label: string; note: string }[] = [
  { key: "relationship", label: "Relationship", note: "reps working property managers" },
  { key: "chase", label: "Chase", note: "field chasers working live incidents" },
  { key: "all", label: "All", note: "both motions, ranked within their own goals" },
];

const PERIODS: { key: GoalPeriod; label: string }[] = [
  { key: "month", label: "Month" },
  { key: "quarter", label: "Quarter" },
  { key: "year", label: "Year" },
];

function Toggle<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { key: T; label: string }[];
  label: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="label-caps text-muted-foreground">{label}</span>
      <div className="inline-flex rounded-md border" role="group" aria-label={label}>
        {options.map((o) => (
          <button
            key={o.key}
            type="button"
            aria-pressed={value === o.key}
            onClick={() => onChange(o.key)}
            className={cn(
              "h-7 border-r px-2.5 text-[12px] last:border-r-0",
              value === o.key ? "bg-primary text-primary-foreground font-medium" : "hover:bg-muted",
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Avatar({ name, size = 28 }: { name: string; size?: number }) {
  return (
    <span
      style={{ width: size, height: size }}
      className="flex shrink-0 items-center justify-center rounded-md border bg-muted text-[11px] font-semibold tracking-wide"
    >
      {initialsOf(name)}
    </span>
  );
}

function PersonName({ r, canDrill }: { r: Ranked; canDrill: boolean }) {
  if (!canDrill) return <span className="text-[13px] font-medium">{r.name}</span>;
  return (
    <Link
      to="/intelligence/$userId"
      params={{ userId: r.standing.user_id }}
      search={carryPeriodSearch}
      className="text-[13px] font-medium hover:underline"
    >
      {r.name}
    </Link>
  );
}

function headlineFigures(r: Ranked): { label: string; value: string }[] {
  const s = r.standing;
  if (r.motion === "chase") {
    return [
      { label: "Signed", value: num(s.contracts_signed) },
      { label: "Accepted", value: num(s.incidents_accepted) },
      {
        label: "Median TTA",
        value: s.median_tta_minutes == null ? "—" : `${Math.round(s.median_tta_minutes)}m`,
      },
    ];
  }
  return [
    { label: "Meetings", value: num(s.meetings_held) },
    { label: "Touches", value: num(s.touchpoints) },
    s.money_visible
      ? { label: "Billed", value: usd(s.billed_value) }
      : { label: "Jobs won", value: num(s.jobs_won) },
  ];
}

const MEDAL = ["bg-brand-gold text-brand-gold-foreground", "bg-muted-foreground/20", "bg-muted"];

function PodiumCard({ r, place, canDrill }: { r: Ranked; place: number; canDrill: boolean }) {
  const figs = headlineFigures(r);
  const first = place === 0;
  return (
    <div
      className={cn(
        "flex flex-1 flex-col gap-2 border p-3",
        first ? "border-brand-gold bg-card sm:-mt-3 sm:pb-5" : "bg-card",
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "flex h-5 w-5 items-center justify-center rounded-sm text-[11px] font-bold tabular-nums",
            MEDAL[place],
          )}
        >
          {place + 1}
        </span>
        <Avatar name={r.name} size={first ? 34 : 28} />
        <div className="min-w-0">
          <div className="truncate">
            <PersonName r={r} canDrill={canDrill} />
          </div>
          <div className="truncate text-[11px] text-muted-foreground">
            {primaryRole(r.standing.roles)
              ? ROLE_LABELS[primaryRole(r.standing.roles)!]
              : "No role"}
          </div>
        </div>
      </div>
      <div
        className={cn(
          "display-heavy tabular-nums leading-none",
          first ? "text-[30px]" : "text-[22px]",
        )}
      >
        {pct(r.attainment)}
        <span className="ml-1 text-[11px] font-normal text-muted-foreground">attainment</span>
      </div>
      <div className="flex gap-4 border-t pt-2">
        {figs.map((f) => (
          <div key={f.label}>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {f.label}
            </div>
            <div className="font-mono text-[12px] tabular-nums">{f.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Leaderboard({
  locationIds,
  canDrill,
  canManageGoals,
  period,
  team,
  onPeriodChange,
  onTeamChange,
  showTeamAll,
}: {
  locationIds: string[] | null;
  /** Managers and above may open a peer's full scorecard; peers may not. */
  canDrill: boolean;
  canManageGoals: boolean;
  period: GoalPeriod;
  team: TeamFilter;
  onPeriodChange: (p: GoalPeriod) => void;
  onTeamChange: (t: TeamFilter) => void;
  showTeamAll: boolean;
}) {
  const [standings, setStandings] = useState<Standing[] | null>(null);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const win = useMemo(() => goalWindow(period), [period]);
  const locKey = (locationIds ?? []).join(",");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      fetchStandings(win.from, win.to, locationIds),
      fetchGoals({ period, window: win }),
    ])
      .then(([s, g]) => {
        if (cancelled) return;
        setStandings(s);
        setGoals(g);
      })
      .catch((e) => {
        if (cancelled) return;
        toastDbError(e, { action: "load leaderboard" });
        setError(e?.message ?? "Could not load standings.");
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [period, win.from.getTime(), win.to.getTime(), locKey]);

  const ranked = useMemo(() => {
    const all = rankStandings(standings ?? [], goals);
    return team === "all" ? all : all.filter((r) => r.motion === team);
  }, [standings, goals, team]);

  const withGoals = ranked.filter((r) => r.attainment != null);
  const moneyVisible = (standings ?? []).some((s) => s.money_visible);
  const teamAttainment = withGoals.length
    ? withGoals.reduce((s, r) => s + (r.attainment ?? 0), 0) / withGoals.length
    : null;

  const headlineTotal =
    team === "chase"
      ? ranked.reduce((s, r) => s + r.standing.contracts_signed, 0)
      : moneyVisible
        ? ranked.reduce((s, r) => s + (r.standing.billed_value ?? 0), 0)
        : ranked.reduce((s, r) => s + r.standing.jobs_won, 0);

  const elapsed = elapsedShare(period);

  return (
    <div className="space-y-3">
      {/* Header band */}
      <div className="rounded-md border bg-card px-3 py-2.5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <div className="display-heavy text-[17px] leading-tight">
              {team === "chase"
                ? "Chase standings"
                : team === "relationship"
                  ? "Relationship standings"
                  : "Company standings"}
            </div>
            <div className="text-[11px] opacity-80">
              {win.label} · {Math.round(elapsed * 100)}% of the period elapsed · ranked by goal
              attainment
            </div>
          </div>
          <div className="display-heavy text-[22px] tabular-nums text-brand-gold">
            {pct(teamAttainment)}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <Toggle
          label="Team"
          value={team}
          onChange={onTeamChange}
          options={TEAMS.filter((t) => t.key !== "all" || showTeamAll)}
        />
        <Toggle label="Period" value={period} onChange={onPeriodChange} options={PERIODS} />
      </div>

      <MetricStrip
        metrics={[
          {
            label: "Reps competing",
            value: withGoals.length,
            note: `of ${ranked.length} in scope`,
          },
          { label: "Team attainment", value: pct(teamAttainment), note: "mean of goal ratios" },
          {
            label: team === "chase" ? "Contracts signed" : moneyVisible ? "Billed" : "Jobs won",
            value: team === "chase" || !moneyVisible ? num(headlineTotal) : usd(headlineTotal),
            note: win.label.toLowerCase(),
          },
          {
            label: team === "chase" ? "Incidents accepted" : "Meetings held",
            value: num(
              ranked.reduce(
                (s, r) =>
                  s + (team === "chase" ? r.standing.incidents_accepted : r.standing.meetings_held),
                0,
              ),
            ),
            note: "across the standings",
          },
        ]}
      />

      {/* Honesty: no goals means no competition. Do not draw a podium of zeros. */}
      {!loading && withGoals.length === 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning bg-warning/10 px-3 py-2 text-[12px]">
          <span>
            <strong className="font-semibold">No competition is running.</strong> Nobody in this
            scope has an active {period} goal, so there is no attainment to rank and no podium to
            show. The standings below list activity only.
          </span>
          {canManageGoals && (
            <Button asChild size="sm" variant="outline">
              <Link to="/goals" search={{ tab: "manage" } as never}>
                Set goals
              </Link>
            </Button>
          )}
        </div>
      )}

      {loading ? (
        <div className="px-1 py-6 text-sm text-muted-foreground">Loading standings…</div>
      ) : error ? (
        <div className="px-1 py-6 text-sm text-destructive">{error}</div>
      ) : ranked.length === 0 ? (
        <div className="rounded-md border px-3 py-6 text-sm text-muted-foreground">
          Nobody is in this team scope. Assign roles and locations in Admin → Users.
        </div>
      ) : (
        <>
          {withGoals.length >= 3 && (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <PodiumCard r={withGoals[1]!} place={1} canDrill={canDrill} />
              <PodiumCard r={withGoals[0]!} place={0} canDrill={canDrill} />
              <PodiumCard r={withGoals[2]!} place={2} canDrill={canDrill} />
            </div>
          )}

          <div className="overflow-x-auto md:max-h-[75svh] md:overflow-auto rounded-md border">
            <table className="w-full text-[12px]">
              <thead className="bg-muted">
                <tr className="text-left">
                  <th className="w-10 px-2 py-1.5 font-medium">#</th>
                  <th className="px-2 py-1.5 font-medium">Rep</th>
                  <th className="px-2 py-1.5 text-right font-medium">Attainment</th>
                  {team === "chase" ? (
                    <>
                      <th className="px-2 py-1.5 text-right font-medium">Signed</th>
                      <th className="px-2 py-1.5 text-right font-medium">Accepted</th>
                      <th className="px-2 py-1.5 text-right font-medium">Median TTA</th>
                      <th className="px-2 py-1.5 text-right font-medium">Accept rate</th>
                    </>
                  ) : (
                    <>
                      <th className="px-2 py-1.5 text-right font-medium">Meetings</th>
                      <th className="px-2 py-1.5 text-right font-medium">Touches</th>
                      <th className="px-2 py-1.5 text-right font-medium">
                        {moneyVisible ? "Billed" : "Jobs won"}
                      </th>
                      <th className="px-2 py-1.5 text-right font-medium">Close rate</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y">
                {ranked.map((r, i) => {
                  const s = r.standing;
                  const closeRate = s.accounts_owned > 0 ? s.jobs_won / s.accounts_owned : null;
                  return (
                    <tr key={s.user_id} className="hover:bg-muted/40">
                      <td className="px-2 py-1.5 font-mono tabular-nums text-muted-foreground">
                        {r.attainment == null ? "—" : i + 1}
                      </td>
                      <td className="px-2 py-1.5">
                        <div className="flex items-center gap-2">
                          <Avatar name={r.name} size={22} />
                          <div className="min-w-0">
                            <PersonName r={r} canDrill={canDrill} />
                            <div className="truncate text-[10px] text-muted-foreground">
                              {primaryRole(s.roles)
                                ? ROLE_LABELS[primaryRole(s.roles) as AppRole]
                                : "No role"}
                              {team === "all" ? ` · ${r.motion}` : ""}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono tabular-nums">
                        {r.attainment == null ? (
                          <span className="text-[11px] text-muted-foreground">no active goals</span>
                        ) : (
                          pct(r.attainment)
                        )}
                      </td>
                      {r.motion === "chase" ? (
                        <>
                          <td className="px-2 py-1.5 text-right font-mono tabular-nums">
                            {num(s.contracts_signed)}
                          </td>
                          <td className="px-2 py-1.5 text-right font-mono tabular-nums">
                            {num(s.incidents_accepted)}
                          </td>
                          <td className="px-2 py-1.5 text-right font-mono tabular-nums">
                            {s.median_tta_minutes == null
                              ? "—"
                              : `${Math.round(s.median_tta_minutes)}m`}
                          </td>
                          <td className="px-2 py-1.5 text-right font-mono tabular-nums">
                            {pct(s.chase_acceptance)}
                          </td>
                        </>
                      ) : (
                        <>
                          <td className="px-2 py-1.5 text-right font-mono tabular-nums">
                            {num(s.meetings_held)}
                          </td>
                          <td className="px-2 py-1.5 text-right font-mono tabular-nums">
                            {num(s.touchpoints)}
                          </td>
                          <td className="px-2 py-1.5 text-right font-mono tabular-nums">
                            {moneyVisible ? usd(s.billed_value) : num(s.jobs_won)}
                          </td>
                          <td className="px-2 py-1.5 text-right font-mono tabular-nums">
                            {pct(closeRate)}
                          </td>
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      <p className="text-[11px] text-muted-foreground">
        Ranked by goal attainment (actual ÷ target for the period), tie-broken by{" "}
        {team === "chase" ? "contracts signed" : moneyVisible ? "billed value" : "jobs won"}. People
        with no goal set are listed without a rank, not at zero.
      </p>
    </div>
  );
}
