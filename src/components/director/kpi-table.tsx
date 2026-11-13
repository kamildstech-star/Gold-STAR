import * as React from "react";
import { cn } from "@/lib/utils";
import { EmptyLine } from "@/components/ui-density";
import { KPI_COLUMNS, median, type DirectorKpi, type KpiKey } from "@/lib/director";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

/**
 * Why a rep is behind, not just that they are: every activity input beside the
 * team median, with the gap called out. "300 calls this month" is the answer.
 */
export function KpiTable({
  rows,
  attainment,
}: {
  rows: DirectorKpi[];
  /** user_id → attainment ratio (0..1+), from the goals engine. */
  attainment: Record<string, number | null>;
}) {
  const medians = React.useMemo(() => {
    const out = {} as Record<KpiKey, number>;
    for (const c of KPI_COLUMNS) out[c.key] = median(rows.map((r) => r[c.key]));
    return out;
  }, [rows]);

  if (!rows.length) return <EmptyLine>No reps in scope for this window.</EmptyLine>;

  return (
    <div className="overflow-x-auto md:max-h-[75svh] md:overflow-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="min-w-[160px]">Rep</TableHead>
            <TableHead className="text-right">Goal</TableHead>
            {KPI_COLUMNS.map((c) => (
              <TableHead key={c.key} className="text-right">
                {c.label}
              </TableHead>
            ))}
            <TableHead className="text-right">Jobs signed</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => {
            const att = attainment[r.user_id] ?? null;
            return (
              <TableRow key={r.user_id}>
                <TableCell className="font-semibold">{r.full_name ?? "Unnamed"}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {att == null ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <Badge
                      variant={att >= 0.9 ? "success" : att >= 0.6 ? "warning" : "destructive"}
                    >
                      {Math.round(att * 100)}%
                    </Badge>
                  )}
                </TableCell>
                {KPI_COLUMNS.map((c) => {
                  const v = r[c.key];
                  const m = medians[c.key];
                  const behind = m > 0 && v < m * 0.7;
                  return (
                    <TableCell key={c.key} className="text-right tabular-nums">
                      <span className={cn(behind && "font-semibold text-destructive")}>
                        {v.toLocaleString("en-US")}
                      </span>
                      <span className="ml-1.5 text-[11px] text-muted-foreground">
                        med {Math.round(m).toLocaleString("en-US")}
                      </span>
                    </TableCell>
                  );
                })}
                <TableCell className="text-right tabular-nums">
                  {r.jobs_signed_insurance + r.jobs_signed_cash}
                  <span className="ml-1.5 text-[11px] text-muted-foreground">
                    {r.jobs_signed_insurance} ins / {r.jobs_signed_cash} cash
                  </span>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
