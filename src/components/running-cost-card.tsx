import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { useAppContext } from "@/components/app-context";
import { money } from "@/lib/finance";
import { canViewFinance } from "@/lib/finance";
import { getMarginThreshold, marginTone, runningCostOverview } from "@/lib/running-cost";
import { cn } from "@/lib/utils";
import { FitText } from "@/components/ui/fit-text";

/**
 * Running cost across active jobs in the user's offices, plus the jobs
 * eating their margin. Finance roles only — the RPC returns nothing to
 * anyone else, and the card renders nothing rather than an empty shell.
 */
export function RunningCostCard() {
  const app = useAppContext();
  const allowed = canViewFinance(app.roles);

  const q = useQuery({
    queryKey: ["running-cost-overview", app.currentLocationId],
    queryFn: () => runningCostOverview(app.currentLocationId),
    enabled: allowed,
  });
  const thresholdQ = useQuery({
    queryKey: ["margin-threshold"],
    queryFn: getMarginThreshold,
    enabled: allowed,
  });

  // Not a finance role: nothing at all — no notice that the figures exist.
  if (!allowed) return null;
  if (q.isLoading) return <div className="p-1 text-sm text-muted-foreground">Loading…</div>;

  const d = q.data;
  const threshold = thresholdQ.data ?? 25;
  if (!d) return null;

  const marginPct =
    d.companyRevenue > 0 ? ((d.companyRevenue - d.companyCost) / d.companyRevenue) * 100 : null;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <div>
          <span className="kpi-label">Running cost</span>
          <FitText className="mt-1 text-[22px] font-bold leading-none tracking-tight tabular-nums">
            {money(d.companyCost)}
          </FitText>
        </div>
        <div>
          <span className="kpi-label">Active jobs</span>
          <FitText className="mt-1 text-[22px] font-bold leading-none tracking-tight tabular-nums">
            {d.activeJobs}
          </FitText>
        </div>
        <div>
          <span className="kpi-label">Margin</span>
          <FitText
            className={cn(
              "mt-1 text-[22px] font-bold leading-none tracking-tight tabular-nums",
              marginTone(marginPct, threshold),
            )}
          >
            {marginPct == null ? "—" : `${marginPct.toFixed(1)}%`}
          </FitText>
        </div>
      </div>

      <div>
        <span className="kpi-label">Worst margin</span>
        {d.worst.length === 0 ? (
          <p className="mt-2 text-[12px] text-muted-foreground">No costed active jobs.</p>
        ) : (
          <ul className="mt-2 divide-y divide-border">
            {d.worst.map((j) => (
              <li key={j.job_id} className="flex items-center gap-3 py-2">
                <Link
                  to="/jobs/$id"
                  params={{ id: j.job_id }}
                  className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground hover:underline"
                >
                  {j.title ?? "Untitled job"}
                  <span className="ml-1.5 font-mono text-[11px] font-normal text-muted-foreground">
                    {j.job_number ?? "—"}
                  </span>
                </Link>
                <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">
                  {money(j.total_cost)}
                </span>
                <span
                  className={cn(
                    "w-11 shrink-0 text-right text-[12px] font-bold tabular-nums",
                    marginTone(j.margin_pct, threshold),
                  )}
                >
                  {j.margin_pct == null ? "—" : `${j.margin_pct.toFixed(0)}%`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
