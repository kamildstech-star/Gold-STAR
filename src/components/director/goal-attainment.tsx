import * as React from "react";
import { EmptyLine } from "@/components/ui-density";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { fmtPct } from "@/lib/goals";

export type TeamGoalRow = {
  user_id: string;
  name: string;
  monthly: number | null;
  annual: number | null;
  why: string | null;
};

/** Team goal attainment, monthly and annual, from the same goals engine the rep sees. */
export function GoalAttainment({ rows }: { rows: TeamGoalRow[] }) {
  const sorted = React.useMemo(
    () => [...rows].sort((a, b) => (a.monthly ?? 99) - (b.monthly ?? 99)),
    [rows],
  );
  if (!sorted.length) return <EmptyLine>No active goals for the team.</EmptyLine>;

  return (
    <div className="divide-y">
      {sorted.map((r) => (
        <div key={r.user_id} className="grid gap-1 py-2.5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-[13px] font-semibold">{r.name}</span>
            <span className="text-[12px] tabular-nums text-muted-foreground">
              Month{" "}
              <strong
                className={cn("text-foreground", (r.monthly ?? 1) < 0.6 && "text-destructive")}
              >
                {fmtPct(r.monthly)}
              </strong>{" "}
              · Year <strong className="text-foreground">{fmtPct(r.annual)}</strong>
            </span>
          </div>
          <Progress value={Math.min(100, Math.round((r.monthly ?? 0) * 100))} className="h-1.5" />
          {r.why && (
            <p className="rounded-sm bg-[color-mix(in_oklab,var(--warning)_14%,var(--card))] px-2 py-1 text-[12px] text-foreground/80">
              {r.why}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}
