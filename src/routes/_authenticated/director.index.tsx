import * as React from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Brain } from "lucide-react";

import { PageHeader, EmptyLine, LoadError } from "@/components/ui-density";
import { MetricStrip } from "@/components/metric-strip";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { useCan } from "@/lib/permissions";
import { fetchDirectorKpis, fetchRepCost, money, totalCost } from "@/lib/director";
import { fetchGoals, attainmentFor, goalWindow, fetchNewAccounts } from "@/lib/goals";
import { fetchMetrics } from "@/lib/scorecard";
import { activityOf, fetchStandings } from "@/lib/leaderboard";
import { KpiTable } from "@/components/director/kpi-table";
import { TaskBoard } from "@/components/director/task-board";
import { RepCostTable } from "@/components/director/rep-cost-table";
import { AffiliatesPanel } from "@/components/director/affiliates-panel";
import { GoalAttainment, type TeamGoalRow } from "@/components/director/goal-attainment";
import { EmailMarketingHook } from "@/components/director/email-marketing-hook";

export const Route = createFileRoute("/_authenticated/director/")({
  head: () => ({
    meta: [
      { title: "Director dashboard · Recovery Hub" },
      {
        name: "description",
        content:
          "Team-wide view for the Sales Head and Owner: rep KPIs against goal and team median, task board, rep cost, goal attainment and affiliate reps.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: DirectorPage,
});

function DirectorPage() {
  const canView = useCan("director.view");
  const canCost = useCan("rep_cost.view");
  const canAffiliates = useCan("affiliates.manage");

  const month = React.useMemo(() => goalWindow("month"), []);
  const year = React.useMemo(() => goalWindow("year"), []);

  const kpis = useQuery({
    queryKey: ["director-kpis", month.startsOn],
    enabled: canView,
    queryFn: () => fetchDirectorKpis(month.from, month.to),
  });

  const cost = useQuery({
    queryKey: ["director-cost", month.startsOn],
    enabled: canCost,
    queryFn: () => fetchRepCost(month.from, month.to),
  });

  const goals = useQuery({
    queryKey: ["director-goals", month.startsOn],
    enabled: canView,
    queryFn: async () => {
      const [
        monthGoals,
        yearGoals,
        monthMetrics,
        yearMetrics,
        newAccMonth,
        newAccYear,
        monthStandings,
        yearStandings,
      ] = await Promise.all([
        fetchGoals({ period: "month", window: month }),
        fetchGoals({ period: "year", window: year }),
        fetchMetrics({ from: month.from, to: month.to, label: "month" }),
        fetchMetrics({ from: year.from, to: year.to, label: "year" }),
        fetchNewAccounts(month.from, month.to),
        fetchNewAccounts(year.from, year.to),
        // Mark's six activity goals read their actuals off the standings row.
        fetchStandings(month.from, month.to, null).catch(() => []),
        fetchStandings(year.from, year.to, null).catch(() => []),
      ]);
      const rows: TeamGoalRow[] = [];
      const ids = new Set(
        [...monthGoals, ...yearGoals].map((g) => g.subject_user_id).filter((x): x is string => !!x),
      );
      for (const id of ids) {
        const mm = monthMetrics.find((m) => m.user_id === id);
        const ym = yearMetrics.find((m) => m.user_id === id);
        const ms = monthStandings.find((s) => s.user_id === id);
        const ys = yearStandings.find((s) => s.user_id === id);
        const mine = monthGoals.filter((g) => g.subject_user_id === id);
        const yours = yearGoals.filter((g) => g.subject_user_id === id);
        rows.push({
          user_id: id,
          name: mm?.full_name ?? ym?.full_name ?? "Unnamed",
          monthly: mm
            ? attainmentFor(mine, mm, {
                newAccounts: newAccMonth[id] ?? 0,
                activity: ms ? activityOf(ms) : null,
              }).pct
            : null,
          annual: ym
            ? attainmentFor(yours, ym, {
                newAccounts: newAccYear[id] ?? 0,
                activity: ys ? activityOf(ys) : null,
              }).pct
            : null,
          why: mine.find((g) => g.why)?.why ?? yours.find((g) => g.why)?.why ?? null,
        });
      }
      return rows;
    },
  });

  // Without director.view (or while it is still loading) nothing is drawn;
  // the sidebar only offers this page to people who hold it.
  if (!canView) return null;

  const rows = kpis.data ?? [];
  const attainment: Record<string, number | null> = {};
  for (const g of goals.data ?? []) attainment[g.user_id] = g.monthly;

  const costRows = cost.data ?? [];
  const teamCost = costRows.reduce((a, r) => a + totalCost(r), 0);
  const teamRevenue = costRows.reduce((a, r) => a + r.revenue, 0);

  return (
    <div className="space-y-4 p-4">
      <PageHeader title="Director dashboard" count={`${month.label} · team-wide`}>
        <Button asChild size="sm" variant="outline">
          <Link to="/intelligence" search={{} as never}>
            <Brain className="size-3.5" /> Sales intelligence
          </Link>
        </Button>
      </PageHeader>

      <MetricStrip
        metrics={[
          { label: "Reps", value: rows.length },
          {
            label: "Calls this month",
            value: rows.reduce((a, r) => a + r.calls_made, 0).toLocaleString("en-US"),
          },
          {
            label: "Meetings held",
            value: rows.reduce((a, r) => a + r.meetings_held, 0).toLocaleString("en-US"),
          },
          {
            label: "Jobs signed",
            value: rows
              .reduce((a, r) => a + r.jobs_signed_insurance + r.jobs_signed_cash, 0)
              .toLocaleString("en-US"),
          },
          ...(canCost
            ? [
                { label: "Rep cost", value: money(teamCost) },
                { label: "Revenue", value: money(teamRevenue) },
              ]
            : []),
        ]}
      />

      <Tabs defaultValue="kpis">
        <TabsList>
          <TabsTrigger value="kpis">Rep KPIs</TabsTrigger>
          <TabsTrigger value="tasks">Task board</TabsTrigger>
          <TabsTrigger value="goals">Goal attainment</TabsTrigger>
          {canCost && <TabsTrigger value="cost">Rep cost</TabsTrigger>}
          {canAffiliates && <TabsTrigger value="affiliates">Affiliates</TabsTrigger>}
          <TabsTrigger value="marketing">Email marketing</TabsTrigger>
        </TabsList>

        <TabsContent value="kpis" className="pt-3">
          {kpis.isError ? (
            <LoadError what="rep KPIs" error={kpis.error} onRetry={() => void kpis.refetch()} />
          ) : kpis.isLoading ? (
            <EmptyLine>Loading…</EmptyLine>
          ) : (
            <KpiTable rows={rows} attainment={attainment} />
          )}
        </TabsContent>

        <TabsContent value="tasks" className="pt-3">
          <TaskBoard people={rows.map((r) => ({ user_id: r.user_id, full_name: r.full_name }))} />
        </TabsContent>

        <TabsContent value="goals" className="pt-3">
          {goals.isError ? (
            <LoadError what="goals" error={goals.error} onRetry={() => void goals.refetch()} />
          ) : goals.isLoading ? (
            <EmptyLine>Loading…</EmptyLine>
          ) : (
            <GoalAttainment rows={goals.data ?? []} />
          )}
        </TabsContent>

        {canCost && (
          <TabsContent value="cost" className="pt-3">
            {cost.isError ? (
              <LoadError what="rep cost" error={cost.error} onRetry={() => void cost.refetch()} />
            ) : cost.isLoading ? (
              <EmptyLine>Loading…</EmptyLine>
            ) : (
              <RepCostTable rows={costRows} />
            )}
          </TabsContent>
        )}

        {canAffiliates && (
          <TabsContent value="affiliates" className="pt-3">
            <AffiliatesPanel />
          </TabsContent>
        )}

        <TabsContent value="marketing" className="pt-3">
          <EmailMarketingHook />
        </TabsContent>
      </Tabs>
    </div>
  );
}
