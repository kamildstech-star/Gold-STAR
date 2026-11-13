import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { useAppContext } from "@/components/app-context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  canViewFinance,
  companyMoneySummary,
  money,
  repProfitability,
  type RepProfitRow,
} from "@/lib/finance";
import { PageHeader } from "@/components/ui-density";
import { ExportExcelButton } from "@/components/export-excel-button";
import type { ExportColumn } from "@/lib/export-table";

/** The on-screen table plus the entity it was run for, so a stack of downloads stays tellable apart. */
function repColumns(entity: string): ExportColumn<RepProfitRow>[] {
  return [
    { key: "rep", label: "Rep", get: (r) => r.full_name ?? "Unnamed" },
    { key: "entity", label: "Entity", get: () => entity },
    { key: "jobs", label: "Jobs", get: (r) => r.job_count, type: "number" },
    { key: "revenue", label: "Revenue", get: (r) => r.revenue, type: "money" },
    { key: "collected", label: "Received", get: (r) => r.collected, type: "money" },
    { key: "salary", label: "Salary", get: (r) => r.salary_cost, type: "money" },
    { key: "commission", label: "Commission", get: (r) => r.commission_cost, type: "money" },
    { key: "expenses", label: "Expenses", get: (r) => r.expense_cost, type: "money" },
    { key: "total", label: "Total rep cost", get: (r) => r.total_rep_cost, type: "money" },
    { key: "net", label: "Net", get: (r) => r.net_contribution, type: "money" },
  ];
}
import { MetricStrip } from "@/components/metric-strip";
import { useLocationChoice } from "@/lib/use-own-location";
import { locationIdOf } from "@/lib/report-location";
import {
  DollarSign,
  TrendingUp,
  AlertTriangle,
  PiggyBank,
  Wrench,
  Users2,
  HandCoins,
  Wallet,
} from "lucide-react";
import { PERIOD_PRESETS, formatRange, resolvePeriod, type PeriodPreset } from "@/lib/period";

type Search = { period: PeriodPreset; from?: string; to?: string; loc?: string };

const PERIOD_KEYS = PERIOD_PRESETS.map((p) => p.key) as string[];

export const Route = createFileRoute("/_authenticated/profitability/")({
  head: () => ({
    meta: [
      { title: "Profitability · Recovery Hub" },
      {
        name: "description",
        content:
          "Revenue, cash received, open claims and net profit after costs and referrals, plus total cost and contribution per rep.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  validateSearch: (raw: Record<string, unknown>): Search => ({
    period: (PERIOD_KEYS.includes(String(raw.period)) ? raw.period : "ytd") as PeriodPreset,
    from: typeof raw.from === "string" ? raw.from : undefined,
    to: typeof raw.to === "string" ? raw.to : undefined,
    loc: typeof raw.loc === "string" ? raw.loc : undefined,
  }),
  component: ProfitabilityPage,
});

function ProfitabilityPage() {
  const app = useAppContext();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const allowed = canViewFinance(app.roles);

  const range = useMemo(
    () => resolvePeriod(search.period, search.from, search.to),
    [search.period, search.from, search.to],
  );
  /*
   * Opens on the viewer's own entity rather than on all twelve rolled up; the
   * summary tiles and the per-rep table both read this one value.
   */
  const officeChoice = useLocationChoice(search.loc);
  const locationId = locationIdOf(officeChoice);

  const summaryQ = useQuery({
    queryKey: ["money-summary", search.period, search.from, search.to, locationId],
    queryFn: () => companyMoneySummary(range, locationId),
    enabled: allowed,
  });
  const repsQ = useQuery({
    queryKey: ["rep-profitability", search.period, search.from, search.to, locationId],
    queryFn: () => repProfitability(range, locationId),
    enabled: allowed,
  });

  // Finance roles only. Anyone else gets nothing drawn, not a "limited to" card.
  if (!allowed) return null;

  const s = summaryQ.data;
  const reps = repsQ.data ?? [];
  const totalRepCost = reps.reduce((a, r) => a + r.total_rep_cost, 0);
  const entity = locationId
    ? (() => {
        const l = app.visibleLocations.find((x) => x.id === locationId);
        return l ? `${l.code} · ${l.name}` : locationId;
      })()
    : "All entities";

  return (
    <div className="space-y-3">
      <PageHeader title="Profitability" subtitle={formatRange(range)}>
        <ExportExcelButton
          report="rep-profitability"
          surface="profitability"
          entity="rep_profitability"
          filters={{ period: search.period, from: search.from, to: search.to, loc: locationId }}
          sheets={[{ name: "Rep profitability", rows: reps, columns: repColumns(entity) }]}
        />
      </PageHeader>
      <Card>
        <CardContent className="flex flex-wrap items-end gap-2 py-3">
          <div>
            <Label className="text-xs">Period</Label>
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
          </div>
          {search.period === "custom" && (
            <>
              <div>
                <Label className="text-xs">From</Label>
                <Input
                  type="date"
                  className="h-9"
                  value={search.from ?? ""}
                  onChange={(e) =>
                    void navigate({
                      search: (o: Search) => ({ ...o, from: e.target.value || undefined }),
                    })
                  }
                />
              </div>
              <div>
                <Label className="text-xs">To</Label>
                <Input
                  type="date"
                  className="h-9"
                  value={search.to ?? ""}
                  onChange={(e) =>
                    void navigate({
                      search: (o: Search) => ({ ...o, to: e.target.value || undefined }),
                    })
                  }
                />
              </div>
            </>
          )}
          <div>
            <Label className="text-xs">Entity</Label>
            <Select
              value={officeChoice}
              onValueChange={(v) => void navigate({ search: (o: Search) => ({ ...o, loc: v }) })}
            >
              <SelectTrigger className="h-9 w-[220px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All entities</SelectItem>
                {app.visibleLocations.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {l.code} · {l.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <span className="pb-2 text-xs text-muted-foreground">{formatRange(range)}</span>
        </CardContent>
      </Card>

      <MetricStrip
        metrics={[
          {
            label: "Total revenue",
            value: money(s?.total_revenue ?? 0),
            icon: DollarSign,
            note: "Billed in period",
          },
          {
            label: "Received",
            value: money(s?.received ?? 0),
            icon: Wallet,
            note: "Cash collected",
          },
          {
            label: "Open claims",
            value: money(s?.open_claims_value ?? 0),
            icon: AlertTriangle,
            tone: (s?.open_claims_count ?? 0) > 0 ? "warning" : "default",
            note: `${s?.open_claims_count ?? 0} job${(s?.open_claims_count ?? 0) === 1 ? "" : "s"} outstanding`,
          },
          {
            label: "Net profit to company",
            value: money(s?.net_profit ?? 0),
            icon: TrendingUp,
            tone: (s?.net_profit ?? 0) < 0 ? "danger" : "success",
            note: "After costs and referrals",
          },
        ]}
      />

      <MetricStrip
        metrics={[
          { label: "Direct job costs", value: money(s?.direct_costs ?? 0), icon: Wrench },
          { label: "Labor", value: money(s?.labour_cost ?? 0), icon: Users2 },
          { label: "Referral cost", value: money(s?.referral_cost ?? 0), icon: HandCoins },
          {
            label: "Total rep cost",
            value: money(totalRepCost || (s?.rep_cost ?? 0)),
            icon: PiggyBank,
            note: "Salary + commission + expenses",
          },
        ]}
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Rep profitability</CardTitle>
          <p className="text-xs text-muted-foreground">
            Commission counts only when it was issued, salary is pro-rated from effective-dated pay
            structures, and recurring expenses expand across the period.
          </p>
        </CardHeader>
        <CardContent>
          {/* Header frozen while the reps scroll (David, 21 Oct — every report). */}
          <div className="max-h-[75svh] overflow-auto">
            <table className="w-full min-w-[820px] text-xs">
              <thead className="sticky top-0 z-10 border-b bg-card text-left text-muted-foreground">
                <tr>
                  <th className="py-1.5 pr-2 font-medium">Rep</th>
                  <th className="py-1.5 pr-2 text-right font-medium">Jobs</th>
                  <th className="py-1.5 pr-2 text-right font-medium">Revenue</th>
                  <th className="py-1.5 pr-2 text-right font-medium">Received</th>
                  <th className="py-1.5 pr-2 text-right font-medium">Salary</th>
                  <th className="py-1.5 pr-2 text-right font-medium">Commission</th>
                  <th className="py-1.5 pr-2 text-right font-medium">Expenses</th>
                  <th className="py-1.5 pr-2 text-right font-medium">Total rep cost</th>
                  <th className="py-1.5 text-right font-medium">Net</th>
                </tr>
              </thead>
              <tbody>
                {repsQ.isLoading && (
                  <tr>
                    <td colSpan={9} className="py-4 text-center text-muted-foreground">
                      Loading…
                    </td>
                  </tr>
                )}
                {!repsQ.isLoading && reps.length === 0 && (
                  <tr>
                    <td colSpan={9} className="py-4 text-center text-muted-foreground">
                      No rep activity or cost in this period.
                    </td>
                  </tr>
                )}
                {reps.map((r) => (
                  <tr key={r.user_id} className="border-b last:border-0">
                    <td className="py-1.5 pr-2 font-medium">{r.full_name ?? "Unnamed"}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">{r.job_count}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">{money(r.revenue)}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">{money(r.collected)}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">{money(r.salary_cost)}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">
                      {money(r.commission_cost)}
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">{money(r.expense_cost)}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">
                      {money(r.total_rep_cost)}
                    </td>
                    <td
                      className={`py-1.5 text-right tabular-nums ${r.net_contribution < 0 ? "text-destructive" : ""}`}
                    >
                      {money(r.net_contribution)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Kpi({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "good" | "bad";
}) {
  return (
    <div className="rounded-[6px] border bg-card px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div
        className={`text-lg font-semibold tabular-nums ${tone === "bad" ? "text-destructive" : ""}`}
      >
        {value}
      </div>
      {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}
