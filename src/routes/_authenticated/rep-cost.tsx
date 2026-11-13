import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { HandCoins, Users2, Wallet, TrendingUp } from "lucide-react";

import { useAppContext } from "@/components/app-context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PageHeader } from "@/components/ui-density";
import { MetricStrip } from "@/components/metric-strip";
import { LocationFilter } from "@/components/location-filter";
import { canViewFinance, money, repProfitability } from "@/lib/finance";
import { PERIOD_PRESETS, formatRange, resolvePeriod, type PeriodPreset } from "@/lib/period";

/**
 * Rep's Cost — what each person costs the business for a period, next to what
 * they signed. Salary (annual or hourly), commission actually issued and
 * expenses are separate columns because they behave differently: salary is a
 * fixed carry, commission only exists once money is in.
 *
 * Money-rule gated: only finance roles see any figure here.
 */

type Search = { period: PeriodPreset; from?: string; to?: string; loc?: string };
const PERIOD_KEYS = PERIOD_PRESETS.map((p) => p.key) as string[];

export const Route = createFileRoute("/_authenticated/rep-cost")({
  head: () => ({
    meta: [
      { title: "Rep's cost · Recovery Hub" },
      {
        name: "description",
        content:
          "Per rep for the period: salary cost, commission paid, expenses and revenue signed, with net contribution.",
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
  component: RepCostPage,
});

function RepCostPage() {
  const app = useAppContext();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const allowed = canViewFinance(app.roles);

  const range = useMemo(
    () => resolvePeriod(search.period, search.from, search.to),
    [search.period, search.from, search.to],
  );
  const locationId = search.loc && search.loc !== "all" ? search.loc : null;

  const repsQ = useQuery({
    queryKey: ["rep-cost", search.period, search.from, search.to, locationId],
    queryFn: () => repProfitability(range, locationId),
    enabled: allowed,
  });

  // Finance roles only. Anyone else gets nothing drawn, not a "limited to" card.
  if (!allowed) return null;

  const reps = repsQ.data ?? [];
  const salary = reps.reduce((a, r) => a + r.salary_cost, 0);
  const commission = reps.reduce((a, r) => a + r.commission_cost, 0);
  const revenue = reps.reduce((a, r) => a + r.revenue, 0);
  const total = reps.reduce((a, r) => a + r.total_rep_cost, 0);

  return (
    <div className="page-shell space-y-3">
      <PageHeader title="Rep's cost" subtitle={formatRange(range)} />

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
                    void navigate({ search: (o: Search) => ({ ...o, from: e.target.value }) })
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
                    void navigate({ search: (o: Search) => ({ ...o, to: e.target.value }) })
                  }
                />
              </div>
            </>
          )}
          <div>
            <Label className="text-xs">Office</Label>
            <LocationFilter
              value={locationId ? [locationId] : []}
              onChange={(ids) =>
                void navigate({ search: (o: Search) => ({ ...o, loc: ids[0] ?? "all" }) })
              }
            />
          </div>
        </CardContent>
      </Card>

      <MetricStrip
        metrics={[
          { label: "Salary cost", value: money(salary), icon: Wallet },
          { label: "Commission paid", value: money(commission), icon: HandCoins },
          { label: "Revenue signed", value: money(revenue), icon: TrendingUp },
          { label: "Total rep cost", value: money(total), icon: Users2 },
        ]}
      />

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Per rep</CardTitle>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <div className="overflow-x-auto md:max-h-[75svh] md:overflow-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 text-left font-semibold">Rep</th>
                  <th className="px-3 py-2 text-right font-semibold">Salary</th>
                  <th className="px-3 py-2 text-right font-semibold">Commission paid</th>
                  <th className="px-3 py-2 text-right font-semibold">Expenses</th>
                  <th className="px-3 py-2 text-right font-semibold">Total cost</th>
                  <th className="px-3 py-2 text-right font-semibold">Revenue signed</th>
                  <th className="px-3 py-2 text-right font-semibold">Collected</th>
                  <th className="px-3 py-2 text-right font-semibold">Net contribution</th>
                </tr>
              </thead>
              <tbody>
                {repsQ.isLoading && (
                  <tr>
                    <td colSpan={8} className="px-3 py-6 text-center text-muted-foreground">
                      Loading…
                    </td>
                  </tr>
                )}
                {!repsQ.isLoading && reps.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-3 py-6 text-center text-muted-foreground">
                      No pay or signed work in this period.
                    </td>
                  </tr>
                )}
                {reps.map((r) => (
                  <tr key={r.user_id} className="border-b last:border-0">
                    <td className="px-3 py-2 font-medium">{r.full_name ?? "Unnamed"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{money(r.salary_cost)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {money(r.commission_cost)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{money(r.expense_cost)}</td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums">
                      {money(r.total_rep_cost)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{money(r.revenue)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{money(r.collected)}</td>
                    <td
                      className={`px-3 py-2 text-right font-semibold tabular-nums ${
                        r.net_contribution < 0 ? "text-[var(--danger)]" : ""
                      }`}
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
      <p className="text-[11px] text-muted-foreground">
        Commission is counted when it is issued, never when a job is estimated or invoiced. Salary
        is prorated across the period from the terms in force on each day.
      </p>
    </div>
  );
}
