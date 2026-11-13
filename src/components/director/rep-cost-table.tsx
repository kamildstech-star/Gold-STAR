import * as React from "react";
import { EmptyLine } from "@/components/ui-density";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { money, totalCost, type RepCost } from "@/lib/director";

/**
 * Salary vs commission per rep against revenue attributable to them.
 * Owner / Sales Head only — gated on `rep_cost.view`.
 */
export function RepCostTable({ rows }: { rows: RepCost[] }) {
  const sorted = React.useMemo(() => [...rows].sort((a, b) => totalCost(b) - totalCost(a)), [rows]);
  if (!sorted.length) return <EmptyLine>No pay or payout records in this window.</EmptyLine>;

  return (
    <div className="overflow-x-auto md:max-h-[75svh] md:overflow-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="min-w-[160px]">Rep</TableHead>
            <TableHead className="text-right">Salary</TableHead>
            <TableHead className="text-right">Commission paid</TableHead>
            <TableHead className="text-right">Total cost</TableHead>
            <TableHead className="text-right">Revenue collected</TableHead>
            <TableHead className="text-right">Cost of revenue</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((r) => {
            const cost = totalCost(r);
            const ratio = r.revenue > 0 ? cost / r.revenue : null;
            return (
              <TableRow key={r.user_id}>
                <TableCell className="font-semibold">{r.full_name ?? "Unnamed"}</TableCell>
                <TableCell className="text-right tabular-nums">{money(r.salary_cost)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {money(r.commission_paid)}
                </TableCell>
                <TableCell className="text-right tabular-nums font-semibold">
                  {money(cost)}
                </TableCell>
                <TableCell className="text-right tabular-nums">{money(r.revenue)}</TableCell>
                <TableCell
                  className={cn(
                    "text-right tabular-nums",
                    ratio != null && ratio > 0.5 && "font-semibold text-destructive",
                  )}
                >
                  {ratio == null ? "—" : `${Math.round(ratio * 100)}%`}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <p className="mt-2 text-[11px] text-muted-foreground">
        Salary is pro-rated from the pay structure effective in the window. Revenue is payment
        received attributed to the rep. Affiliate reps are costed separately and are not in these
        lines.
      </p>
    </div>
  );
}
