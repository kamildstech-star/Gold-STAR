import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Wallet } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyLine, LoadError } from "@/components/ui-density";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useCan } from "@/lib/permissions";
import { fetchRepCost, money, totalCost } from "@/lib/director";
import { goalWindow } from "@/lib/goals";
import { FitText } from "@/components/ui/fit-text";

/**
 * Rep's cost — salary paid against commission paid for the period, with the
 * cost-of-revenue ratio. Money the rep never sees: gated on `rep_cost.view`,
 * which only managers, the Sales Head and the Owner hold.
 */
export function RepCostCard() {
  const canCost = useCan("rep_cost.view");
  const month = useMemo(() => goalWindow("month"), []);

  const cost = useQuery({
    queryKey: ["rep-cost-card", month.startsOn],
    enabled: canCost,
    queryFn: () => fetchRepCost(month.from, month.to),
  });

  if (!canCost) return null;

  const rows = [...(cost.data ?? [])].sort((a, b) => totalCost(b) - totalCost(a));
  const teamCost = rows.reduce((a, r) => a + totalCost(r), 0);
  const teamRevenue = rows.reduce((a, r) => a + r.revenue, 0);
  const teamRatio = teamRevenue > 0 ? teamCost / teamRevenue : null;

  return (
    <Card className="flex h-full flex-col">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-1.5">
          <Wallet className="h-4 w-4 text-muted-foreground" />
          Rep's cost
        </CardTitle>
        <CardDescription>
          {month.label} · salary vs commission paid against revenue signed.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex-1 space-y-2">
        {cost.isError ? (
          <LoadError what="rep cost" error={cost.error} onRetry={() => void cost.refetch()} />
        ) : cost.isLoading ? (
          <EmptyLine>Loading…</EmptyLine>
        ) : !rows.length ? (
          <EmptyLine>No pay or payout records in this window.</EmptyLine>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2 rounded-md border bg-muted/30 p-2 text-center">
              <div>
                <div className="text-[11px] text-muted-foreground">Total cost</div>
                <FitText className="text-[15px] font-semibold tabular-nums">
                  {money(teamCost)}
                </FitText>
              </div>
              <div>
                <div className="text-[11px] text-muted-foreground">Revenue</div>
                <FitText className="text-[15px] font-semibold tabular-nums">
                  {money(teamRevenue)}
                </FitText>
              </div>
              <div>
                <div className="text-[11px] text-muted-foreground">Cost of revenue</div>
                <FitText
                  className={cn(
                    "text-[15px] font-semibold tabular-nums",
                    teamRatio != null && teamRatio > 0.5 && "text-destructive",
                  )}
                >
                  {teamRatio == null ? "—" : `${Math.round(teamRatio * 100)}%`}
                </FitText>
              </div>
            </div>

            <ul className="divide-y text-[13px]">
              {rows.slice(0, 6).map((r) => {
                const c = totalCost(r);
                const ratio = r.revenue > 0 ? c / r.revenue : null;
                return (
                  <li key={r.user_id} className="flex items-center gap-2 py-1.5">
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {r.full_name ?? "Unnamed"}
                    </span>
                    <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                      {money(r.salary_cost)} sal · {money(r.commission_paid)} comm
                    </span>
                    <FitText className="w-16 shrink-0 text-right font-semibold tabular-nums">
                      {money(c)}
                    </FitText>
                    <span
                      className={cn(
                        "w-10 shrink-0 text-right tabular-nums",
                        ratio != null && ratio > 0.5 && "font-semibold text-destructive",
                      )}
                    >
                      {ratio == null ? "—" : `${Math.round(ratio * 100)}%`}
                    </span>
                  </li>
                );
              })}
            </ul>

            <Button asChild size="sm" variant="outline" className="w-full">
              <Link to="/rep-cost" search={{} as never}>
                Full rep cost view
              </Link>
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
