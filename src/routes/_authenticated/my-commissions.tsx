import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Clock, HandCoins, Target, Wallet } from "lucide-react";
import { toast } from "sonner";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as ReTooltip,
  XAxis,
  YAxis,
} from "recharts";

import { useAppContext } from "@/components/app-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PageHeader } from "@/components/ui-density";
import { MetricStrip } from "@/components/metric-strip";
import { ExportExcelButton } from "@/components/export-excel-button";
import type { ExportColumn } from "@/lib/export-table";
import { supabase } from "@/integrations/supabase/client";
import { canViewFinance, money } from "@/lib/finance";
import { payoutCreditNote } from "@/lib/job-credit";
import { cn } from "@/lib/utils";
import {
  PERIOD_PRESETS,
  formatRange,
  resolvePeriod,
  toDateStr,
  type PeriodPreset,
} from "@/lib/period";
import {
  PAYOUT_STATUS_LABEL,
  fetchMyTiers,
  fetchOverview,
  listPayouts,
  monthlySeries,
  payoutsView,
  setPayoutStatus,
  tierClaim,
  tierProgress,
  type PayoutRow,
} from "@/lib/commissions";
import {
  COMMISSION_BASIS_LABEL,
  effectiveRangeLabel,
  isInForce,
  listCommissionPlans,
} from "@/lib/pay";

/**
 * My commissions — one person's true total compensation: salary carried for the
 * period plus commission the engine calculated from their plan and tier. Reps
 * see only their own rows (RLS). Finance roles can switch rep and approve or
 * mark a payout paid, which is the same population as Rep's cost.
 */

type Search = { period: PeriodPreset; from?: string; to?: string; rep?: string };
const PERIOD_KEYS = PERIOD_PRESETS.map((p) => p.key) as string[];

/** The payouts table as shown, with the customer (company) beside every job. */
const PAYOUT_COLUMNS: ExportColumn<PayoutRow>[] = [
  { key: "job", label: "Job", get: (p) => p.jobs?.job_number ?? p.note ?? "" },
  {
    key: "customer",
    label: "Customer",
    get: (p) => p.jobs?.accounts?.name ?? p.jobs?.job_name ?? p.jobs?.address ?? "",
  },
  { key: "basis", label: "Signed value", get: (p) => Number(p.basis_amount ?? 0), type: "money" },
  {
    key: "rate",
    label: "Rate",
    get: (p) => (p.rate_percent != null ? Number(p.rate_percent) / 100 : null),
    type: "percent",
  },
  { key: "split", label: "Split", get: (p) => Number(p.split_percent) / 100, type: "percent" },
  { key: "amount", label: "Commission", get: (p) => Number(p.amount ?? 0), type: "money" },
  { key: "status", label: "Status", get: (p) => PAYOUT_STATUS_LABEL[p.status] ?? p.status },
  {
    key: "expected",
    label: "Expected",
    get: (p) => p.issued_on ?? p.expected_pay_date,
    type: "date",
  },
  { key: "period_start", label: "Period start", get: (p) => p.period_start, type: "date" },
  { key: "period_end", label: "Period end", get: (p) => p.period_end, type: "date" },
];

export const Route = createFileRoute("/_authenticated/my-commissions")({
  head: () => ({
    meta: [
      { title: "My commissions · Recovery Hub" },
      {
        name: "description",
        content:
          "Salary plus commission for the period, tier progress, and every payout with the deal behind it.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  validateSearch: (raw: Record<string, unknown>): Search => ({
    period: (PERIOD_KEYS.includes(String(raw.period)) ? raw.period : "ytd") as PeriodPreset,
    from: typeof raw.from === "string" ? raw.from : undefined,
    to: typeof raw.to === "string" ? raw.to : undefined,
    rep: typeof raw.rep === "string" ? raw.rep : undefined,
  }),
  component: MyCommissionsPage,
});

function MyCommissionsPage() {
  const app = useAppContext();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const qc = useQueryClient();
  const isFinance = canViewFinance(app.roles);

  const range = useMemo(
    () => resolvePeriod(search.period, search.from, search.to),
    [search.period, search.from, search.to],
  );
  const from = toDateStr(range.from);
  const to = toDateStr(range.to);
  // Under View As "my" commissions are the viewed person's (viewerUserId).
  const subjectId = (isFinance && search.rep) || app.viewerUserId || "";

  // Manager rep picker — anyone with a commission plan on file.
  const repsQ = useQuery({
    queryKey: ["commission-reps"],
    enabled: isFinance,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("commission_plans")
        .select("user_id, profiles:user_id(full_name)")
        .order("effective_from", { ascending: false });
      if (error) throw error;
      const seen = new Map<string, string>();
      for (const r of (data ?? []) as unknown as {
        user_id: string;
        profiles?: { full_name: string | null } | null;
      }[]) {
        if (!seen.has(r.user_id)) seen.set(r.user_id, r.profiles?.full_name ?? "Unnamed");
      }
      return [...seen].map(([userId, name]) => ({ userId, name }));
    },
  });

  const payoutsQ = useQuery({
    queryKey: ["commission-payouts", subjectId],
    enabled: !!subjectId,
    queryFn: () => listPayouts({ userIds: [subjectId] }),
  });

  const overviewQ = useQuery({
    queryKey: ["commission-overview", subjectId, from, to],
    enabled: !!subjectId,
    queryFn: () => fetchOverview(subjectId, from, to),
  });

  const tiersQ = useQuery({
    queryKey: ["my-commission-tiers"],
    // my_commission_tiers answers for auth.uid() — the admin under View As —
    // so a person preview shows no tiers rather than the wrong ones.
    enabled: !app.viewingAsPerson,
    queryFn: fetchMyTiers,
  });

  const plansQ = useQuery({
    queryKey: ["commission-plans", subjectId],
    enabled: !!subjectId,
    queryFn: () => listCommissionPlans(subjectId),
  });

  const statusM = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => setPayoutStatus(id, status),
    onSuccess: () => {
      toast.success("Payout updated");
      void qc.invalidateQueries({ queryKey: ["commission-payouts"] });
    },
    onError: (e: unknown) =>
      toast.error(e instanceof Error ? e.message : "Could not update payout"),
  });

  const all = payoutsQ.data ?? [];
  const inPeriod = all.filter((p) => p.period_end >= from && p.period_start <= to);
  const sum = (rows: PayoutRow[]) => rows.reduce((a, r) => a + Number(r.amount ?? 0), 0);
  const paid = inPeriod.filter((p) => p.status === "paid");
  const pending = inPeriod.filter((p) => p.status === "pending" || p.status === "approved");

  const overview = overviewQ.data;
  const salary = Math.round(overview?.salary_period ?? 0);
  const commission = sum(inPeriod.filter((p) => p.status !== "void"));

  const progress = tierProgress(tiersQ.data ?? [], overview?.signed_volume ?? 0);
  const plan = (plansQ.data ?? []).find((p) => isInForce(p));
  // The plan is the single source for anything that claims a tier — see
  // tierClaim(). Without one in force the ladder says nothing true.
  const claim = tierClaim({
    planLoading: plansQ.isLoading,
    hasPlan: !!plan,
    tierCount: (tiersQ.data ?? []).length,
  });
  const payouts = payoutsView({
    isLoading: payoutsQ.isLoading,
    isError: payoutsQ.isError,
    rowCount: inPeriod.length,
  });
  const payoutCols = isFinance ? 8 : 7;
  const year = new Date().getFullYear();
  const series = monthlySeries(all, year);

  const viewingOther = isFinance && subjectId !== app.viewerUserId;

  return (
    <div className="page-shell space-y-3">
      <PageHeader
        title={viewingOther ? "Commissions" : "My commissions"}
        subtitle={`${formatRange(range)} · salary and commission together`}
      >
        {isFinance && (
          <Button asChild variant="outline" size="sm">
            <Link to="/rep-cost" search={{ period: "ytd" }}>
              Rep's cost
            </Link>
          </Button>
        )}
      </PageHeader>

      <Card>
        <CardContent className="flex flex-wrap items-end gap-2 py-3">
          <Select
            value={search.period}
            onValueChange={(v) =>
              void navigate({ search: (o: Search) => ({ ...o, period: v as PeriodPreset }) })
            }
          >
            <SelectTrigger className="h-9 w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PERIOD_PRESETS.map((p) => (
                <SelectItem key={p.key} value={p.key}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {isFinance && (
            <Select
              value={subjectId}
              onValueChange={(v) => void navigate({ search: (o: Search) => ({ ...o, rep: v }) })}
            >
              <SelectTrigger className="h-9 w-[220px]">
                <SelectValue placeholder="Rep" />
              </SelectTrigger>
              <SelectContent>
                {app.viewerUserId && <SelectItem value={app.viewerUserId}>Me</SelectItem>}
                {(repsQ.data ?? [])
                  .filter((r) => r.userId !== app.viewerUserId)
                  .map((r) => (
                    <SelectItem key={r.userId} value={r.userId}>
                      {r.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          )}
        </CardContent>
      </Card>

      <MetricStrip
        metrics={[
          {
            label: "Total comp this period",
            value: money(salary + commission),
            note: `${money(salary)} salary + ${money(commission)} commission`,
            icon: Wallet,
          },
          { label: "Paid", value: money(sum(paid)), icon: CheckCircle2, tone: "success" },
          { label: "Pending", value: money(sum(pending)), icon: Clock },
          {
            label: "Current tier",
            // No plan in force means no tier. Saying "Platinum" here beside
            // "No commission plan is in force" was the page contradicting itself.
            value:
              claim === "loading"
                ? "…"
                : claim === "ladder"
                  ? (progress.current?.label ?? "Base")
                  : "—",
            note:
              claim === "no-plan"
                ? "No commission plan in force"
                : claim === "ladder"
                  ? progress.current?.rate_percent != null
                    ? `${progress.current.rate_percent}%`
                    : plan?.rate_percent != null
                      ? `${plan.rate_percent}%`
                      : undefined
                  : undefined,
            icon: Target,
          },
        ]}
      />

      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Tier progress</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-[13px]">
            {claim === "loading" ? (
              <p className="text-muted-foreground">Loading…</p>
            ) : claim === "no-plan" ? (
              <p className="text-muted-foreground">
                No commission plan is in force, so there is no tier to report.
              </p>
            ) : claim === "no-ladder" ? (
              <p className="text-muted-foreground">Your plan has no tier ladder.</p>
            ) : progress.next ? (
              <>
                <p className="text-[15px] font-semibold">
                  {money(progress.gap)} more signed → {progress.next.rate_percent}% rate
                  {progress.upliftOnCurrentVolume > 0 && (
                    <span className="text-success">
                      , +{money(progress.upliftOnCurrentVolume)} on current volume
                    </span>
                  )}
                </p>
                <div>
                  <div className="mb-1 flex items-baseline justify-between text-muted-foreground">
                    <span>Signed {formatRange(range)}</span>
                    <span className="tabular-nums">
                      {money(progress.volume)} / {money(Number(progress.next.min_amount ?? 0))}
                    </span>
                  </div>
                  <Progress
                    value={Math.min(
                      100,
                      (progress.volume / Math.max(1, Number(progress.next.min_amount ?? 1))) * 100,
                    )}
                  />
                </div>
              </>
            ) : (
              <p className="text-[15px] font-semibold">
                Top tier reached — {money(progress.volume)} signed.
              </p>
            )}

            {/* The ladder bolds the rep's "current" rung, so it is part of the
                tier claim — it stays hidden until a plan makes it true. */}
            <ul className={`divide-y border-t ${claim === "ladder" ? "" : "hidden"}`}>
              {(tiersQ.data ?? []).map((t) => {
                const active = progress.current?.key === t.key;
                return (
                  <li
                    key={`${t.work_component ?? "all"}-${t.key}`}
                    className={`flex items-center justify-between py-1.5 ${active ? "font-semibold" : ""}`}
                  >
                    <span>
                      {t.label}
                      {t.work_component ? (
                        <span className="ml-1 text-[11px] text-muted-foreground">
                          {t.work_component}
                        </span>
                      ) : null}
                    </span>
                    <span className="tabular-nums text-muted-foreground">
                      {t.rate_percent != null ? `${t.rate_percent}%` : "—"}
                      {t.min_amount != null ? ` from ${money(Number(t.min_amount))}` : ""}
                    </span>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Plan &amp; salary</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-[13px]">
            {!plan ? (
              <p className="text-muted-foreground">
                No commission plan is in force. Ask your Sales Head.
              </p>
            ) : (
              <ul className="space-y-1">
                <Row label="Basis" value={COMMISSION_BASIS_LABEL[plan.basis] ?? plan.basis} />
                {plan.rate_percent != null && (
                  <Row label="Base rate" value={`${plan.rate_percent}%`} />
                )}
                {plan.flat_amount != null && (
                  <Row label="Flat amount" value={money(Number(plan.flat_amount))} />
                )}
                <Row label="Source" value={plan.deal_source} />
                <Row label="In force" value={effectiveRangeLabel(plan)} />
                <Row label="Salary for period" value={money(salary)} />
                <Row label="Signed volume" value={money(overview?.signed_volume ?? 0)} />
                <Row label="Collected" value={money(overview?.collected_volume ?? 0)} />
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">{year} by month</CardTitle>
        </CardHeader>
        <CardContent className="h-[180px] pt-0">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={series} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} className="stroke-border" />
              <XAxis dataKey="month" tickLine={false} axisLine={false} fontSize={11} />
              <YAxis tickLine={false} axisLine={false} fontSize={11} width={56} />
              <ReTooltip
                formatter={(v, n) => [money(Number(v)), n === "paid" ? "Paid" : "Pending"]}
              />
              <Bar dataKey="paid" stackId="a" fill="hsl(var(--success))" radius={[0, 0, 0, 0]} />
              <Bar
                dataKey="pending"
                stackId="a"
                fill="hsl(var(--muted-foreground))"
                radius={[3, 3, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm">Payouts</CardTitle>
          <ExportExcelButton
            report={viewingOther ? "commissions" : "my-commissions"}
            surface="commissions"
            entity="commission_payouts"
            filters={{ period: search.period, from, to, rep: subjectId }}
            sheets={[{ name: "Payouts", rows: inPeriod, columns: PAYOUT_COLUMNS }]}
          />
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {/* Header frozen while the payouts scroll (David, 21 Oct). */}
          <div className="max-h-[75svh] overflow-auto">
            <table className="w-full text-[13px]">
              <thead className="sticky top-0 z-10 bg-card">
                <tr className="border-b text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 text-left font-semibold">Job</th>
                  <th className="px-3 py-2 text-left font-semibold">Customer</th>
                  <th className="px-3 py-2 text-right font-semibold">Signed value</th>
                  <th className="px-3 py-2 text-right font-semibold">Rate</th>
                  <th className="px-3 py-2 text-right font-semibold">Commission</th>
                  <th className="px-3 py-2 text-left font-semibold">Status</th>
                  <th className="px-3 py-2 text-left font-semibold">Expected</th>
                  {isFinance && <th className="px-3 py-2 text-right font-semibold">Action</th>}
                </tr>
              </thead>
              <tbody>
                {payouts === "loading" && (
                  <tr>
                    <td
                      colSpan={payoutCols}
                      className="px-3 py-6 text-center text-muted-foreground"
                    >
                      Loading…
                    </td>
                  </tr>
                )}
                {payouts === "error" && (
                  <tr>
                    <td colSpan={payoutCols} className="px-3 py-6 text-center">
                      <p className="font-medium">Could not load your payouts.</p>
                      <p className="mt-0.5 text-[12px] text-muted-foreground">
                        This is a problem reading the data, not a period with nothing in it —
                        don&rsquo;t read it as “you are owed nothing”.
                      </p>
                      <Button
                        size="sm"
                        variant="outline"
                        className="mt-2"
                        disabled={payoutsQ.isFetching}
                        onClick={() => void payoutsQ.refetch()}
                      >
                        {payoutsQ.isFetching ? "Retrying…" : "Retry"}
                      </Button>
                    </td>
                  </tr>
                )}
                {payouts === "empty" && (
                  <tr>
                    <td
                      colSpan={payoutCols}
                      className="px-3 py-6 text-center text-muted-foreground"
                    >
                      No payouts in this period.
                    </td>
                  </tr>
                )}
                {inPeriod.map((p) => (
                  <tr key={p.id} className="border-b last:border-0">
                    <td className="px-3 py-2 font-mono text-[12px]">
                      {p.job_id ? (
                        <Link
                          to="/jobs/$id"
                          params={{ id: p.job_id }}
                          className="text-primary hover:underline"
                        >
                          {p.jobs?.job_number ?? "View job"}
                        </Link>
                      ) : (
                        (p.note ?? "—")
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {p.jobs?.accounts?.name ?? p.jobs?.job_name ?? p.jobs?.address ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {money(Number(p.basis_amount ?? 0))}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                      {p.rate_percent != null ? `${Number(p.rate_percent)}%` : "—"}
                      {Number(p.split_percent) < 100 ? ` · ${Number(p.split_percent)}% split` : ""}
                    </td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums">
                      {money(Number(p.amount ?? 0))}
                    </td>
                    <td className="px-3 py-2">
                      <Badge
                        variant={p.status === "paid" ? "default" : "outline"}
                        className="text-[10px]"
                      >
                        {PAYOUT_STATUS_LABEL[p.status] ?? p.status}
                      </Badge>
                      {(() => {
                        // Where the account sat when the job arrived decides
                        // whether this pays by itself — src/lib/job-credit.ts.
                        const note = payoutCreditNote(p);
                        return note ? (
                          <div
                            className={cn(
                              "mt-1 max-w-[260px] text-[11px] leading-snug",
                              note.tone === "warning"
                                ? "text-warning"
                                : note.tone === "success"
                                  ? "text-success"
                                  : "text-muted-foreground",
                            )}
                          >
                            {note.text}
                          </div>
                        ) : null;
                      })()}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {p.issued_on ?? p.expected_pay_date ?? "—"}
                    </td>
                    {isFinance && (
                      <td className="px-3 py-2 text-right">
                        {p.status === "pending" && (
                          <span className="inline-flex gap-1.5">
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={statusM.isPending}
                              onClick={() => statusM.mutate({ id: p.id, status: "approved" })}
                            >
                              Approve
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-muted-foreground"
                              disabled={statusM.isPending}
                              onClick={() => statusM.mutate({ id: p.id, status: "void" })}
                            >
                              Decline
                            </Button>
                          </span>
                        )}
                        {p.status === "approved" && (
                          <Button
                            size="sm"
                            disabled={statusM.isPending}
                            onClick={() => statusM.mutate({ id: p.id, status: "paid" })}
                          >
                            Mark paid
                          </Button>
                        )}
                        {p.status === "paid" && (
                          <span className="text-[11px] text-muted-foreground">—</span>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
              {inPeriod.length > 0 && (
                <tfoot>
                  <tr className="border-t bg-muted/30 font-semibold">
                    <td className="px-3 py-2" colSpan={4}>
                      Total commission
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{money(commission)}</td>
                    <td
                      className="px-3 py-2 text-[11px] font-normal text-muted-foreground"
                      colSpan={isFinance ? 3 : 2}
                    >
                      {money(sum(paid))} paid · {money(sum(pending))} pending
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </CardContent>
      </Card>

      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <HandCoins className="h-3 w-3" />
        Commission is calculated automatically from your plan and tier when a job's money changes,
        and credited to whoever owned the account when the job arrived. A job from a Conversation
        Established account or a client pays automatically; one from Ready or Active Outreach waits
        for a manager. Payouts a person approved or paid are never recalculated.
      </p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <li className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </li>
  );
}
