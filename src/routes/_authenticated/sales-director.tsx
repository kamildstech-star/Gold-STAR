import * as React from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowUpRight,
  Handshake,
  Mail,
  Phone,
  Plus,
  Sparkles,
  TrendingUp,
} from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { PageHeader, EmptyLine, LoadError } from "@/components/ui-density";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCan } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import {
  buildInsights,
  conversionOf,
  fetchDirectorReps,
  initialsOf,
  money,
  moneyFull,
  statusFor,
  sum,
  type DirectorRepRow,
  type Insight,
} from "@/lib/sales-director";
import { fetchAffiliates, fetchAffiliateReferrals } from "@/lib/director";
import { RepDiagnostic } from "@/components/sales-director/rep-diagnostic";
import { DirectorTaskBoard } from "@/components/sales-director/director-task-board";
import { FitText } from "@/components/ui/fit-text";

export const Route = createFileRoute("/_authenticated/sales-director")({
  validateSearch: (s: Record<string, unknown>) => ({
    rep: typeof s.rep === "string" ? s.rep : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Sales Director Dashboard · Recovery Hub" },
      {
        name: "description",
        content:
          "Team revenue, jobs won, call volume and conversion against goal, with per-rep diagnostics, auto-generated sales intelligence, a task board and affiliate performance.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: SalesDirectorPage,
});

/* ------------------------------------------------------------------ */

function monthOptions(count = 6) {
  const out: { value: string; label: string }[] = [];
  const now = new Date();
  for (let i = 0; i < count; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push({
      value: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
      label: d.toLocaleString("en-US", { month: "long", year: "numeric" }),
    });
  }
  return out;
}

function monthWindow(value: string) {
  const [y, m] = value.split("-").map(Number);
  const from = new Date(y!, m! - 1, 1);
  const to = new Date(y!, m!, 0);
  const prevFrom = new Date(y!, m! - 2, 1);
  const prevTo = new Date(y!, m! - 1, 0);
  const now = new Date();
  const isCurrent = now >= from && now <= to;
  const elapsed = isCurrent ? now.getDate() / to.getDate() : now > to ? 1 : 0.05;
  return { from, to, prevFrom, prevTo, elapsed };
}

function KpiCard({
  label,
  value,
  sub,
  pct,
  trend,
  icon: Icon,
}: {
  label: string;
  value: string;
  sub?: string;
  pct?: number | null;
  trend?: string | null;
  icon: React.ElementType;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-[0_1px_2px_rgba(16,36,61,0.04)]">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-medium text-muted-foreground">{label}</span>
        <Icon className="size-4 text-muted-foreground" />
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <FitText className="text-[26px] font-semibold leading-none tabular-nums">{value}</FitText>
        {trend ? (
          <span className="shrink-0 text-[12px] font-medium text-[var(--success)]">{trend}</span>
        ) : null}
      </div>
      {sub ? <div className="mt-1 text-[12px] text-muted-foreground">{sub}</div> : null}
      {pct !== null && pct !== undefined ? (
        <Progress value={Math.min(100, pct)} className="mt-3 h-1.5" />
      ) : null}
    </div>
  );
}

function InsightRow({ insight }: { insight: Insight }) {
  const Icon =
    insight.kind === "rep"
      ? AlertTriangle
      : insight.kind === "channel"
        ? Handshake
        : insight.kind === "campaign"
          ? Mail
          : TrendingUp;
  const tone =
    insight.severity === "warn"
      ? "text-[var(--warning)]"
      : insight.severity === "good"
        ? "text-[var(--success)]"
        : "text-muted-foreground";
  return (
    <div className="flex items-start gap-3 border-b border-border py-3 last:border-b-0">
      <Icon className={cn("mt-0.5 size-4 shrink-0", tone)} />
      <p className="min-w-0 flex-1 text-[13px]">
        {insight.parts.map((p, i) =>
          p.bold ? (
            <strong key={i} className="font-semibold">
              {p.text}
            </strong>
          ) : (
            <span key={i}>{p.text}</span>
          ),
        )}
      </p>
      <Link
        to={insight.action.to as never}
        search={(insight.action.search ?? {}) as never}
        className="shrink-0 text-[13px] font-medium text-primary hover:underline"
      >
        {insight.actionLabel}
      </Link>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function SalesDirectorPage() {
  const canView = useCan("sales_director.view");
  const navigate = useNavigate();
  const search = Route.useSearch();

  const months = React.useMemo(() => monthOptions(), []);
  const [month, setMonth] = React.useState(months[0]!.value);
  const [team, setTeam] = React.useState("all");
  const [showAllInsights, setShowAllInsights] = React.useState(false);
  const [assignSignal, setAssignSignal] = React.useState(0);
  const win = React.useMemo(() => monthWindow(month), [month]);

  const locations = useQuery({
    queryKey: ["sd-locations"],
    enabled: canView,
    queryFn: async () => {
      const { data, error } = await supabase.from("locations").select("id,name").order("name");
      if (error) throw error;
      return (data ?? []) as { id: string; name: string }[];
    },
  });

  const reps = useQuery({
    queryKey: ["sd-reps", month],
    enabled: canView,
    queryFn: () => fetchDirectorReps(win.from, win.to),
  });

  const prior = useQuery({
    queryKey: ["sd-reps-prior", month],
    enabled: canView,
    queryFn: () => fetchDirectorReps(win.prevFrom, win.prevTo),
  });

  const affiliates = useQuery({
    queryKey: ["sd-affiliates"],
    enabled: canView,
    queryFn: fetchAffiliates,
  });
  const referrals = useQuery({
    queryKey: ["sd-referrals"],
    enabled: canView,
    queryFn: fetchAffiliateReferrals,
  });

  const emailConn = useQuery({
    queryKey: ["sd-email-integration"],
    enabled: canView,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("integration_connections")
        .select("provider,status")
        .limit(50);
      if (error) throw error;
      return (data ?? []) as { provider: string; status: string }[];
    },
  });

  // Without sales_director.view (or while it is still loading) nothing is
  // drawn; the sidebar only offers this page to people who hold it.
  if (!canView) return null;

  if (reps.error) return <LoadError what="the director dashboard" error={reps.error} />;

  const allRows = reps.data ?? [];
  const rows = team === "all" ? allRows : allRows.filter((r) => r.location_id === team);
  const priorRows = prior.data ?? [];
  const priorScoped = team === "all" ? priorRows : priorRows.filter((r) => r.location_id === team);

  const revenue = sum(rows, "revenue");
  const revenueTarget = sum(rows, "revenue_target");
  const jobs = sum(rows, "jobs_won");
  const jobsTarget = sum(rows, "jobs_target");
  const calls = sum(rows, "calls");
  const priorCalls = sum(priorScoped, "calls");
  const appts = sum(rows, "appointments");
  const conversion = appts > 0 ? (jobs / appts) * 100 : 0;
  const callTrend = priorCalls > 0 ? Math.round(((calls - priorCalls) / priorCalls) * 100) : null;

  const refRows = referrals.data ?? [];
  const monthRefs = refRows.filter((r) => {
    const d = new Date(`${r.referred_on}T00:00:00`);
    return d >= win.from && d <= win.to;
  });
  const affJobsWon = monthRefs.filter((r) => r.status === "won").length;
  const affRevenue = monthRefs.reduce((a, r) => a + Number(r.amount_owed ?? 0), 0);
  const affConversion = monthRefs.length ? (affJobsWon / monthRefs.length) * 100 : 0;
  const activeAffiliates = (affiliates.data ?? []).filter((a) => a.status === "active");

  const campaignConnected = (emailConn.data ?? []).some(
    (c) => c.status === "connected" && /mail|brevo|campaign|customer/i.test(c.provider),
  );

  const insights = buildInsights({
    rows,
    prior: priorScoped,
    elapsed: win.elapsed,
    affiliate: monthRefs.length
      ? { leads: monthRefs.length, jobsWon: affJobsWon, conversion: affConversion }
      : null,
    teamConversion: conversion,
    campaignConnected,
  });
  const shownInsights = showAllInsights ? insights : insights.slice(0, 3);

  const selectedRep = rows.find((r) => r.user_id === search.rep) ?? null;
  const people = allRows.map((r) => ({ user_id: r.user_id, full_name: r.full_name }));

  const topAffiliates = [...activeAffiliates]
    .map((a) => ({
      ...a,
      won: refRows.filter((r) => r.affiliate_id === a.id && r.status === "won").length,
    }))
    .sort((a, b) => b.won - a.won)
    .slice(0, 5);

  return (
    <div className="space-y-4 p-4">
      <PageHeader title="Sales Director Dashboard">
        <Select value={month} onValueChange={setMonth}>
          <SelectTrigger className="h-9 w-[170px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {months.map((m) => (
              <SelectItem key={m.value} value={m.value}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={team} onValueChange={setTeam}>
          <SelectTrigger className="h-9 w-[170px]">
            <SelectValue placeholder="All teams" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Teams</SelectItem>
            {(locations.data ?? []).map((l) => (
              <SelectItem key={l.id} value={l.id}>
                {l.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" onClick={() => setAssignSignal((n) => n + 1)}>
          <Plus className="size-3.5" /> Assign Task
        </Button>
      </PageHeader>

      {/* KPI row */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Team Revenue"
          value={money(revenue)}
          sub={revenueTarget ? `of ${money(revenueTarget)} target` : "No revenue goal set"}
          pct={revenueTarget ? (revenue / revenueTarget) * 100 : null}
          icon={TrendingUp}
        />
        <KpiCard
          label="Jobs Won"
          value={String(jobs)}
          sub={jobsTarget ? `of ${Math.round(jobsTarget)} target` : "No jobs goal set"}
          pct={jobsTarget ? (jobs / jobsTarget) * 100 : null}
          icon={Sparkles}
        />
        <KpiCard
          label="Calls Made"
          value={calls.toLocaleString("en-US")}
          sub={
            priorCalls ? `${priorCalls.toLocaleString("en-US")} last month` : "No prior month data"
          }
          trend={
            callTrend !== null ? `${callTrend >= 0 ? "↑" : "↓"} ${Math.abs(callTrend)}%` : null
          }
          icon={Phone}
        />
        <KpiCard
          label="Conversion"
          value={`${Math.round(conversion)}%`}
          sub={`${jobs} jobs from ${appts} appointments`}
          pct={conversion}
          icon={ArrowUpRight}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        {/* Team performance */}
        <section className="rounded-xl border border-border bg-card p-4 xl:col-span-2">
          <Tabs defaultValue="employees">
            <div className="flex items-center justify-between">
              <h3 className="text-[15px] font-semibold">Team Performance</h3>
              <TabsList>
                <TabsTrigger value="employees" className="text-[13px]">
                  Employees
                </TabsTrigger>
                <TabsTrigger value="affiliates" className="text-[13px]">
                  Affiliates
                </TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="employees" className="mt-3">
              {reps.isLoading ? (
                <EmptyLine>Loading…</EmptyLine>
              ) : rows.length === 0 ? (
                <EmptyLine>No reps in this team for the selected month.</EmptyLine>
              ) : (
                <div className="overflow-x-auto md:max-h-[75svh] md:overflow-auto">
                  <table className="w-full text-[13px]">
                    <thead>
                      <tr className="border-b border-border text-left text-[12px] text-muted-foreground">
                        <th className="py-2 font-medium">Rep</th>
                        <th className="py-2 text-right font-medium">Revenue</th>
                        <th className="py-2 text-right font-medium">Calls</th>
                        <th className="py-2 text-right font-medium">Appts</th>
                        <th className="py-2 text-right font-medium">Jobs Won</th>
                        <th className="py-2 text-right font-medium">Conversion</th>
                        <th className="py-2 pl-3 font-medium">Status</th>
                        <th className="py-2" />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => {
                        const st = statusFor(r, win.elapsed);
                        return (
                          <tr key={r.user_id} className="border-b border-border last:border-b-0">
                            <td className="py-2.5">
                              <div className="flex items-center gap-2">
                                <span className="grid size-7 place-items-center rounded-full bg-muted text-[11px] font-semibold">
                                  {initialsOf(r.full_name)}
                                </span>
                                <span className="font-medium">{r.full_name}</span>
                              </div>
                            </td>
                            <td className="py-2.5 text-right tabular-nums">
                              {moneyFull(r.revenue)}
                            </td>
                            <td className="py-2.5 text-right tabular-nums">{r.calls}</td>
                            <td className="py-2.5 text-right tabular-nums">{r.appointments}</td>
                            <td className="py-2.5 text-right tabular-nums">{r.jobs_won}</td>
                            <td className="py-2.5 text-right tabular-nums">
                              {Math.round(conversionOf(r))}%
                            </td>
                            <td className="py-2.5 pl-3">
                              <Badge
                                variant="outline"
                                className={cn(
                                  "text-[11px]",
                                  // Three states, not two: no goal is neither a
                                  // pass nor a warning, and must not read green.
                                  st.ok === null
                                    ? "border-border text-muted-foreground"
                                    : st.ok
                                      ? "border-[var(--success)]/30 text-[var(--success)]"
                                      : "border-[var(--warning)]/40 text-[var(--warning)]",
                                )}
                              >
                                {st.label}
                              </Badge>
                            </td>
                            <td className="py-2.5 text-right">
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 text-[12px]"
                                onClick={() =>
                                  navigate({
                                    to: "/sales-director",
                                    search: { rep: r.user_id },
                                  })
                                }
                              >
                                View
                              </Button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </TabsContent>

            <TabsContent value="affiliates" className="mt-3">
              {topAffiliates.length === 0 ? (
                <EmptyLine>No affiliate reps yet.</EmptyLine>
              ) : (
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="border-b border-border text-left text-[12px] text-muted-foreground">
                      <th className="py-2 font-medium">Affiliate</th>
                      <th className="py-2 font-medium">Company</th>
                      <th className="py-2 text-right font-medium">Leads</th>
                      <th className="py-2 text-right font-medium">Jobs Won</th>
                    </tr>
                  </thead>
                  <tbody>
                    {topAffiliates.map((a) => (
                      <tr key={a.id} className="border-b border-border last:border-b-0">
                        <td className="py-2.5">
                          <div className="flex items-center gap-2">
                            <span className="grid size-7 place-items-center rounded-full bg-muted text-[11px] font-semibold">
                              {initialsOf(a.full_name)}
                            </span>
                            <span className="font-medium">{a.full_name}</span>
                          </div>
                        </td>
                        <td className="py-2.5 text-muted-foreground">{a.company ?? "—"}</td>
                        <td className="py-2.5 text-right tabular-nums">
                          {refRows.filter((r) => r.affiliate_id === a.id).length}
                        </td>
                        <td className="py-2.5 text-right tabular-nums">{a.won}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </TabsContent>
          </Tabs>
        </section>

        {/* Sales intelligence */}
        <section className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-[15px] font-semibold">Sales Intelligence</h3>
            <Sparkles className="size-4 text-muted-foreground" />
          </div>
          {shownInsights.length === 0 ? (
            <EmptyLine>Nothing anomalous in this period.</EmptyLine>
          ) : (
            <div className="mt-1">
              {shownInsights.map((i) => (
                <InsightRow key={i.id} insight={i} />
              ))}
            </div>
          )}
          {insights.length > 3 ? (
            <button
              type="button"
              className="mt-3 text-[13px] font-medium text-primary hover:underline"
              onClick={() => setShowAllInsights((v) => !v)}
            >
              {showAllInsights ? "Show less" : `${insights.length - 3} more insights`}
            </button>
          ) : null}
        </section>
      </div>

      {/* Task board */}
      <section className="rounded-xl border border-border bg-card p-4">
        <h3 className="mb-3 text-[15px] font-semibold">Task Board</h3>
        <DirectorTaskBoard people={people} openSignal={assignSignal} />
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Affiliate sales */}
        <section className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-[15px] font-semibold">Affiliate Sales</h3>
            <Link to="/director" className="text-[13px] font-medium text-primary hover:underline">
              View affiliates
            </Link>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: "Active Affiliates", value: String(activeAffiliates.length) },
              { label: "Leads This Month", value: String(monthRefs.length) },
              { label: "Jobs Won", value: String(affJobsWon) },
              { label: "Revenue", value: money(affRevenue) },
            ].map((s) => (
              <div key={s.label} className="rounded-lg border border-border p-3">
                <div className="text-[12px] text-muted-foreground">{s.label}</div>
                <FitText className="mt-1 text-[18px] font-semibold tabular-nums">{s.value}</FitText>
              </div>
            ))}
          </div>
          <h4 className="mt-4 text-[13px] font-semibold">Top affiliates</h4>
          {topAffiliates.length === 0 ? (
            <EmptyLine>No affiliate activity yet.</EmptyLine>
          ) : (
            <ul className="mt-2 space-y-2">
              {topAffiliates.map((a) => (
                <li key={a.id} className="flex items-center gap-2">
                  <span className="grid size-7 place-items-center rounded-full bg-muted text-[11px] font-semibold">
                    {initialsOf(a.full_name)}
                  </span>
                  <span className="flex-1 text-[13px] font-medium">{a.full_name}</span>
                  <span className="text-[13px] tabular-nums text-muted-foreground">
                    {a.won} jobs won
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Email marketing */}
        <section className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-[15px] font-semibold">Email Marketing</h3>
            <Badge
              variant="outline"
              className={cn(
                "text-[11px]",
                campaignConnected
                  ? "border-[var(--success)]/30 text-[var(--success)]"
                  : "text-muted-foreground",
              )}
            >
              {campaignConnected ? "Connected" : "Not connected"}
            </Badge>
          </div>
          {campaignConnected ? (
            <>
              <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                {["Sent", "Open Rate", "Replies", "Appointments"].map((l) => (
                  <div key={l} className="rounded-lg border border-border p-3">
                    <div className="text-[12px] text-muted-foreground">{l}</div>
                    <div className="mt-1 text-[18px] font-semibold tabular-nums">—</div>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex gap-2">
                <Button size="sm" variant="outline">
                  View Campaign
                </Button>
                <Button size="sm">New Campaign</Button>
              </div>
            </>
          ) : (
            <>
              <p className="mt-3 text-[13px] text-muted-foreground">
                No campaign provider is connected, so sends, opens, replies and campaign-sourced
                appointments are not being attributed here.
              </p>
              <Button asChild size="sm" className="mt-3">
                <Link to="/admin/integrations">Connect</Link>
              </Button>
            </>
          )}
        </section>
      </div>

      <RepDiagnostic
        rep={selectedRep}
        rows={rows}
        prior={priorScoped}
        elapsed={win.elapsed}
        open={!!selectedRep}
        onOpenChange={(o) => {
          if (!o) navigate({ to: "/sales-director", search: { rep: undefined } });
        }}
      />
    </div>
  );
}
