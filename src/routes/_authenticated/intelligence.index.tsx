import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useAppContext } from "@/components/app-context";
import { useOwnLocationId } from "@/lib/use-own-location";
import { MetricStrip } from "@/components/metric-strip";
import { ScoreBadge, ScoreBar } from "@/components/score-breakdown";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ReportControls } from "@/components/report-controls";
import {
  carryPeriodSearch,
  parsePeriodSearch,
  periodSearchOf,
  resolveSelection,
  type PeriodSearch,
} from "@/lib/report-search";
import { Button } from "@/components/ui/button";
import { toastDbError } from "@/lib/db-errors";
import { ROLE_LABELS, isPrivileged, primaryRole } from "@/lib/roles";
import {
  computeScore,
  displayName,
  fetchMetrics,
  fetchMinActivity,
  fetchTimeline,
  fetchWeights,
  initialsFor,
  median,
  roleGroupFor,
  trendBetween,
  weightsFor,
  type PersonMetrics,
  type Range,
  type Score,
  type TimelineEntry,
  type Weight,
} from "@/lib/scorecard";
import { Leaderboard } from "@/components/leaderboard";
import type { GoalPeriod } from "@/lib/goals";
import { ArrowDownRight, ArrowRight, ArrowUpRight, Minus, Search } from "lucide-react";
import { PageHeader } from "@/components/ui-density";

/** The leaderboard view state rides alongside the shared period selection, so
 * switching between scorecards and standings never resets the window. */
type IntelSearch = PeriodSearch & {
  view: "scorecards" | "leaderboard";
  team: "relationship" | "chase" | "all";
  gp: GoalPeriod;
};

export const Route = createFileRoute("/_authenticated/intelligence/")({
  head: () => ({
    meta: [
      { title: "Sales Intelligence · Recovery Hub" },
      {
        name: "description",
        content:
          "Rep scorecards and the goal-attainment leaderboard: touchpoints, meetings, cadence health, accounts advanced and chase performance, with a transparent, configurable score.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  validateSearch: (raw: Record<string, unknown>): IntelSearch => ({
    ...parsePeriodSearch(raw),
    view: raw.view === "leaderboard" ? "leaderboard" : "scorecards",
    team: raw.team === "chase" ? "chase" : raw.team === "all" ? "all" : "relationship",
    gp: raw.gp === "month" || raw.gp === "year" ? raw.gp : "quarter",
  }),
  component: SalesIntelligencePage,
});

type Loaded = {
  current: PersonMetrics[];
  previous: PersonMetrics[];
  weights: Weight[];
  minActivity: number;
};

function TrendArrow({ delta }: { delta: number | null }) {
  if (delta == null)
    return (
      <span className="inline-flex items-center gap-0.5 text-[11px] text-muted-foreground">
        <Minus className="h-3 w-3" />
        <span className="sr-only">No comparable previous period</span>
      </span>
    );
  if (Math.abs(delta) < 1)
    return (
      <span className="inline-flex items-center gap-0.5 text-[11px] text-muted-foreground">
        <ArrowRight className="h-3 w-3" />
        flat
      </span>
    );
  const up = delta > 0;
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-[11px] tabular-nums ${
        up ? "text-success" : "text-destructive"
      }`}
    >
      {up ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
      {up ? "+" : ""}
      {Math.round(delta)}
    </span>
  );
}

function Initials({ name, email }: { name: string | null; email: string | null }) {
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border bg-muted text-[10px] font-semibold tracking-wide">
      {initialsFor(name, email)}
    </span>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-[72px]">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="font-mono text-[13px] tabular-nums">{value}</div>
    </div>
  );
}

function SalesIntelligencePage() {
  const app = useAppContext();
  const ownLocationId = useOwnLocationId();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const [q, setQ] = useState("");
  const [data, setData] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const resolved = useMemo(
    () =>
      resolveSelection(search, {
        locations: app.visibleLocations,
        regions: app.regions,
        defaultLocationId: ownLocationId,
      }),
    [search, app.visibleLocations, app.regions, ownLocationId],
  );
  // Reports and scorecards read the same window, so the two can never disagree.
  const range: Range = useMemo(
    () => ({ ...resolved.range, label: "Selected period" }),
    [resolved.range],
  );
  const prev: Range | null = useMemo(
    () => (resolved.compare ? { ...resolved.compare, label: "Comparison period" } : null),
    [resolved.compare],
  );
  const locationId =
    resolved.locationIds && resolved.locationIds.length === 1 ? resolved.locationIds[0] : null;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      fetchMetrics(range),
      prev ? fetchMetrics(prev) : Promise.resolve([] as PersonMetrics[]),
      fetchWeights(),
      fetchMinActivity(locationId),
    ])
      .then(([current, previous, weights, minActivity]) => {
        if (cancelled) return;
        setData({ current, previous, weights, minActivity });
      })
      .catch((e) => {
        if (cancelled) return;
        toastDbError(e, { action: "load sales intelligence" });
        setError(e?.message ?? "Could not load scorecards.");
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [
    range.from.getTime(),
    range.to.getTime(),
    prev?.from.getTime(),
    prev?.to.getTime(),
    locationId,
  ]);

  const rows = useMemo(() => {
    if (!data) return [];
    const prevById = new Map(data.previous.map((m) => [m.user_id, m]));
    return data.current
      .filter((m) => {
        if (resolved.onlyMine && app.userId) return m.user_id === app.userId;
        if (resolved.locationIds) {
          const set = new Set(resolved.locationIds);
          return m.location_ids.length === 0 || m.location_ids.some((l) => set.has(l));
        }
        if (!locationId) return true;
        // The location switcher narrows presentation only; the database has
        // already decided which people may be seen at all.
        return m.location_ids.length === 0 || m.location_ids.includes(locationId);
      })
      .map((m) => {
        const group = roleGroupFor(m.roles);
        const w = weightsFor(data.weights, group, locationId);
        const score = computeScore(m, w, data.minActivity);
        const before = prevById.get(m.user_id);
        const prevScore = before ? computeScore(before, w, data.minActivity) : null;
        return {
          m,
          score,
          group,
          trend: trendBetween(score.value, prevScore?.value ?? null),
          name: displayName(m),
          role: primaryRole(m.roles),
        };
      })
      .filter((r) => (q ? r.name.toLowerCase().includes(q.toLowerCase()) : true))
      .sort(
        (a, b) => (b.score.value ?? -1) - (a.score.value ?? -1) || a.name.localeCompare(b.name),
      );
  }, [data, q, locationId, resolved.locationIds, resolved.onlyMine, app.userId]);

  const teamMedian = useMemo(() => {
    const scored = rows.map((r) => r.score.value).filter((v): v is number => v != null);
    return scored.length >= 3 ? median(scored) : null;
  }, [rows]);

  const totals = useMemo(() => {
    const t = {
      people: rows.length,
      activePeople: rows.filter((r) => r.m.activity_events > 0).length,
      accounts: rows.reduce((s, r) => s + r.m.accounts_owned, 0),
      jobs: rows.reduce((s, r) => s + r.m.jobs_won, 0),
      events: rows.reduce((s, r) => s + r.m.activity_events, 0),
    };
    return {
      ...t,
      conversion: t.accounts > 0 ? t.jobs / t.accounts : null,
    };
  }, [rows]);

  const noActivity = !loading && rows.length > 0 && totals.events === 0;

  const isLeaderboard = search.view === "leaderboard";
  const canDrill =
    isPrivileged(app.roles) ||
    app.roles.includes("regional") ||
    app.roles.includes("location_manager") ||
    app.roles.includes("sales_manager");

  return (
    <div className="mx-auto max-w-6xl space-y-3 px-4 py-4">
      <PageHeader
        title="Sales Intelligence"
        subtitle={
          <>
            Scoped to what you are permitted to see · scores weighted per office —{" "}
            <Link to="/admin/scorecard" className="underline underline-offset-2">
              edit the scorecard
            </Link>
          </>
        }
      >
        {!isLeaderboard && (
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search people"
              className="h-8 w-[180px] pl-7 text-[13px]"
            />
          </div>
        )}
        <Button asChild variant="outline" size="sm">
          <Link to="/goals" search={{ tab: "mine", gp: search.gp }}>
            Goals
          </Link>
        </Button>
        <Button asChild variant="outline" size="sm">
          <Link to="/reports" search={periodSearchOf(search)}>
            Reports
          </Link>
        </Button>
      </PageHeader>

      {/* View toggle — period and comparison below it are shared, so switching
          views never resets the window. */}
      <div className="segmented" role="group" aria-label="View">
        {(["scorecards", "leaderboard"] as const).map((v) => (
          <button
            key={v}
            type="button"
            aria-pressed={search.view === v}
            onClick={() => navigate({ search: (p: IntelSearch) => ({ ...p, view: v }) })}
            data-active={search.view === v}
            className="segmented-item capitalize"
          >
            {v}
          </button>
        ))}
      </div>

      <div className="-mx-4 border-y">
        <ReportControls
          search={search}
          resolved={resolved}
          locations={app.visibleLocations}
          regions={app.regions}
        />
      </div>

      {isLeaderboard ? (
        <Leaderboard
          locationIds={resolved.locationIds}
          canDrill={canDrill}
          canManageGoals={canDrill}
          period={search.gp}
          team={search.team}
          showTeamAll={canDrill}
          onPeriodChange={(gp) => navigate({ search: (p: IntelSearch) => ({ ...p, gp }) })}
          onTeamChange={(team) => navigate({ search: (p: IntelSearch) => ({ ...p, team }) })}
        />
      ) : (
        <>
          <MetricStrip
            metrics={[
              {
                label: "Active reps",
                value: totals.activePeople,
                note: `of ${totals.people} visible`,
              },
              { label: "Accounts in pipeline", value: totals.accounts, note: "assigned to them" },
              { label: "Jobs won", value: totals.jobs, note: range.label.toLowerCase() },
              {
                label: "Conversion rate",
                value: totals.conversion == null ? "—" : `${Math.round(totals.conversion * 100)}%`,
                note: "jobs per account owned",
              },
            ]}
          />

          {noActivity && (
            <div className="rounded-md border border-warning bg-warning/10 px-3 py-2 text-[12px]">
              <strong className="font-semibold">Nothing has been logged yet.</strong> There are no
              touchpoints, contact attempts or stage changes in this period, so no one can be
              scored. The zeros below reflect an unused system, not performance. Scores will appear
              once reps start logging activity.
            </div>
          )}

          <Tabs defaultValue="scorecards">
            <TabsList>
              <TabsTrigger value="scorecards" className="text-[12px]">
                Rep scorecards
              </TabsTrigger>
              <TabsTrigger value="activity" className="text-[12px]">
                Activity
              </TabsTrigger>
            </TabsList>

            <TabsContent value="scorecards" className="mt-2">
              {loading ? (
                <div className="px-1 py-6 text-sm text-muted-foreground">Loading scorecards…</div>
              ) : error ? (
                <div className="px-1 py-6 text-sm text-destructive">{error}</div>
              ) : rows.length === 0 ? (
                <div className="rounded-md border px-3 py-6 text-sm text-muted-foreground">
                  No scorecards to show.
                </div>
              ) : (
                <div className="divide-y rounded-md border">
                  {rows.map(({ m, score, group, trend, name, role }) => (
                    <div key={m.user_id} className="flex items-center gap-3 px-3 py-2">
                      <Initials name={m.full_name} email={m.email} />

                      <div className="min-w-[150px] flex-1">
                        <Link
                          to="/intelligence/$userId"
                          params={{ userId: m.user_id }}
                          search={carryPeriodSearch}
                          className="text-[13px] font-medium hover:underline"
                        >
                          {name}
                        </Link>
                        <div className="text-[11px] text-muted-foreground">
                          {role ? ROLE_LABELS[role] : "No role assigned"}
                          {" · "}
                          <Link
                            to="/reports"
                            search={{
                              ...periodSearchOf(search),
                              r: "sales-by-rep",
                              rep: m.user_id,
                            }}
                            className="text-primary underline-offset-2 hover:underline"
                          >
                            reports
                          </Link>
                        </div>
                      </div>

                      <div className="w-[130px]">
                        <ScoreBadge score={score} teamMedian={teamMedian} name={name} />
                      </div>
                      <div className="w-[52px]">
                        <TrendArrow delta={trend.delta} />
                      </div>

                      {group === "chase" ? (
                        <div className="hidden gap-4 sm:flex">
                          <Figure
                            label="Accept"
                            value={
                              m.chase_acceptance == null
                                ? "—"
                                : `${Math.round(m.chase_acceptance * 100)}%`
                            }
                          />
                          <Figure
                            label="Median TTA"
                            value={
                              m.median_tta_minutes == null
                                ? "—"
                                : `${Math.round(m.median_tta_minutes)}m`
                            }
                          />
                          <Figure label="Signed" value={String(m.contracts_signed)} />
                        </div>
                      ) : (
                        <div className="hidden gap-4 sm:flex">
                          <Figure label="Touches" value={String(m.touchpoints)} />
                          <Figure
                            label="Meet h/b"
                            value={`${m.meetings_held}/${m.meetings_booked}`}
                          />
                          <Figure
                            label="Overdue"
                            value={`${m.accounts_overdue}/${m.accounts_owned}`}
                          />
                        </div>
                      )}

                      <div className="w-[110px]">
                        <ScoreBar score={score} />
                        {score.value == null && (
                          <div className="mt-0.5 text-[10px] text-muted-foreground">unscored</div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </TabsContent>

            <TabsContent value="activity" className="mt-2">
              <ActivityFeed userIds={rows.map((r) => r.m.user_id)} range={range} rows={rows} />
            </TabsContent>
          </Tabs>

          <p className="text-[11px] text-muted-foreground">
            Team median is only shown when at least three people are in the cohort, so a median can
            never be used to work out one colleague&apos;s figures.
          </p>
        </>
      )}
    </div>
  );
}

function ActivityFeed({
  userIds,
  range,
  rows,
}: {
  userIds: string[];
  range: Range;
  rows: { m: PersonMetrics; name: string; score: Score }[];
}) {
  const [entries, setEntries] = useState<(TimelineEntry & { who: string })[]>([]);
  const [loading, setLoading] = useState(true);
  const nameById = useMemo(
    () => Object.fromEntries(rows.map((r) => [r.m.user_id, r.name])),
    [rows],
  );
  const key = userIds.join(",");

  useEffect(() => {
    let cancelled = false;
    if (userIds.length === 0) {
      setEntries([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    Promise.all(
      userIds.slice(0, 20).map((id) =>
        fetchTimeline(id, range, 40)
          .then((es) => es.map((e) => ({ ...e, who: nameById[id] ?? "Removed user" })))
          .catch(() => []),
      ),
    )
      .then((lists) => {
        if (cancelled) return;
        const merged = lists
          .flat()
          .sort((a, b) => (b.occurred_at ?? "").localeCompare(a.occurred_at ?? ""))
          .slice(0, 200);
        setEntries(merged);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [key, range.from.getTime()]);

  if (loading) return <div className="px-1 py-6 text-sm text-muted-foreground">Loading…</div>;
  if (entries.length === 0)
    return (
      <div className="rounded-md border px-3 py-6 text-sm text-muted-foreground">
        No activity has been logged in this period by anyone you can see. This is an empty log, not
        a performance result.
      </div>
    );

  return (
    <div className="divide-y rounded-md border">
      {entries.map((e) => (
        <div key={`${e.kind}-${e.link_id}`} className="flex items-baseline gap-3 px-3 py-1.5">
          <span className="w-[110px] shrink-0 font-mono text-[11px] text-muted-foreground">
            {e.occurred_at ? new Date(e.occurred_at).toLocaleString("en-US") : "—"}
          </span>
          <Badge variant="outline" className="shrink-0 text-[10px] font-normal">
            {e.kind.replace(/_/g, " ")}
          </Badge>
          <span className="w-[130px] shrink-0 truncate text-[12px]">{e.who}</span>
          <span className="truncate text-[12px]">{e.title}</span>
          <span className="truncate text-[11px] text-muted-foreground">{e.detail}</span>
        </div>
      ))}
    </div>
  );
}
