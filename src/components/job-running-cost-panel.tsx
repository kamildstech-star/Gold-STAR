import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, ChevronRight, RefreshCw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { supabase } from "@/integrations/supabase/client";
import { moneyExact } from "@/lib/finance";
import { loadJobLabourRollup, manHours } from "@/lib/job-labour-rollup";
import {
  REVENUE_BASIS_LABEL,
  getMarginThreshold,
  jobRunningCost,
  marginTone,
  runningCostSources,
  sumOfSources,
  type RunningCost,
} from "@/lib/running-cost";
import { cn } from "@/lib/utils";
import { FitText } from "@/components/ui/fit-text";
import { roundMoneyLoose } from "@/lib/money";

/**
 * Live cost on a job. Never rendered for a role that cannot see money —
 * the caller gates it and the RPC refuses anyway.
 */
export function JobRunningCostPanel({ jobId }: { jobId: string }) {
  const costQ = useQuery({
    queryKey: ["job-running-cost", jobId],
    queryFn: () => jobRunningCost(jobId),
  });
  const thresholdQ = useQuery({
    queryKey: ["margin-threshold"],
    queryFn: getMarginThreshold,
  });
  /*
   * The same rollup the Labor & profitability panel reads, on the same query
   * key, so the two cards on this page cannot print different hours for the
   * same job. The database prices the money; the rollup is only asked for
   * the man-hours on the field forms, which it deduplicates against the
   * clock by the same day rule the function uses.
   */
  const rollupQ = useQuery({
    queryKey: ["job-labour-rollup", jobId],
    queryFn: () => loadJobLabourRollup(supabase, jobId),
  });
  const roll = rollupQ.data?.rollup;

  const c = costQ.data;
  const threshold = thresholdQ.data ?? 25;

  if (costQ.isLoading) {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-muted-foreground">Adding up the job…</CardContent>
      </Card>
    );
  }
  if (!c) return null;

  /*
   * Every source, every time, at $0 when it has nothing. Mark: "the right side
   * should show a runnign cost adding up all costs added in from alal sources
   * of costs from the project" — and a $0 total that lists nine named zeros
   * is an answer, where one bare $0.00 was a question. Rows used to be
   * filtered to the non-zero ones, which is exactly how an empty source
   * became invisible.
   */
  const rows = runningCostSources(c).map((r) =>
    r.key === "field_tickets" && roll && roll.fieldFormMinutes > 0
      ? { ...r, meta: `${manHours(roll.fieldFormMinutes)} man-h · ${r.meta ?? ""}`.trim() }
      : r,
  );
  // The drawer's own audit: if the rows do not add to the total, the function
  // has a source the drawer does not, and the reader should know.
  const unlisted = roundMoneyLoose(c.total_cost - sumOfSources(rows));

  const share = (v: number) => (c.total_cost > 0 ? (v / c.total_cost) * 100 : 0);
  const costed = c.total_cost > 0;
  const below = costed && c.margin_pct != null && c.margin_pct < threshold;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0 pb-2">
        <CardTitle className="text-sm">Running cost</CardTitle>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="font-normal">
            {REVENUE_BASIS_LABEL[c.revenue_basis].badge}
          </Badge>
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            onClick={() => costQ.refetch()}
            aria-label="Refresh running cost"
          >
            <RefreshCw className={cn("size-3.5", costQ.isFetching && "animate-spin")} />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 p-4 pt-0">
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Cost to date
            </div>
            <FitText className="text-2xl font-semibold tabular-nums">
              {moneyExact(c.total_cost)}
            </FitText>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Revenue</div>
            <FitText className="text-2xl font-semibold tabular-nums">
              {c.revenue > 0 ? moneyExact(c.revenue) : "—"}
            </FitText>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Margin</div>
            <FitText
              className={cn(
                "text-2xl font-semibold tabular-nums",
                costed ? marginTone(c.margin_pct, threshold) : "text-muted-foreground",
              )}
            >
              {c.margin_pct == null || c.total_cost === 0 ? "—" : `${c.margin_pct.toFixed(1)}%`}
            </FitText>
            <div className="text-xs text-muted-foreground tabular-nums">
              {c.revenue === 0
                ? "no revenue booked"
                : c.total_cost === 0
                  ? "no costs recorded yet"
                  : moneyExact(c.margin)}
            </div>
          </div>
        </div>

        {below && (
          <div className="flex items-start gap-2 rounded-sm border border-warning/40 bg-warning/10 p-2 text-xs">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
            <span>
              Margin is under the {threshold}% floor set in Settings. Review equipment days on site,
              labor hours and referral cost before this job closes.
            </span>
          </div>
        )}

        <div className="space-y-2">
          {rows.map((r) => (
            <div key={r.key} className="space-y-1" data-cost-source={r.key}>
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="min-w-0">
                  {r.label}
                  <span className="ml-2 text-xs text-muted-foreground">{r.source}</span>
                  {r.meta && <span className="ml-2 text-xs text-muted-foreground">· {r.meta}</span>}
                </span>
                <span className="shrink-0 tabular-nums">{moneyExact(r.value)}</span>
              </div>
              <Progress value={share(r.value)} className="h-1" />
              {r.warning && (
                <p className="flex items-start gap-1 text-xs text-warning">
                  <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                  <span>{r.warning}</span>
                </p>
              )}
            </div>
          ))}
          {unlisted !== 0 && (
            <div className="flex items-baseline justify-between text-sm">
              <span>
                Not itemized
                <span className="ml-2 text-xs text-muted-foreground">
                  in the total, but in no row above
                </span>
              </span>
              <span className="tabular-nums">{moneyExact(unlisted)}</span>
            </div>
          )}
        </div>

        {/* The Job Calculator's cost side, for the job Mark was looking at: two
            calculator results on the rail and $0.00 beside them. It is what the
            job was expected to cost, not what it has cost, so it is named and
            kept out of the total rather than added to actual hours. */}
        {c.calculator_cost > 0 && (
          <div className="flex items-baseline justify-between rounded-sm border border-dashed px-2 py-1.5 text-sm">
            <span>
              Calculator projection
              <span className="ml-2 text-xs text-muted-foreground">
                from the job calculator · not in the total
              </span>
            </span>
            <span className="tabular-nums text-muted-foreground">
              {moneyExact(c.calculator_cost)}
            </span>
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          {REVENUE_BASIS_LABEL[c.revenue_basis].sentence} Equipment accrues its daily rate for every
          day on site. A field ticket prices its day from the crew, hours and machines on the form,
          and the time clock counts on the days no ticket covers.{" "}
          <Link to="/admin/billing-costs" search={{ tab: "cost" }} className="underline">
            Costs
          </Link>{" "}
          and{" "}
          <Link
            to="/admin/billing-costs"
            search={{ tab: "cost", view: "rules" }}
            className="underline"
          >
            margin floor
          </Link>
          .
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * The same figures as tiles for the job's right rail — cost, revenue, margin
 * — with the full panel a tap away in a drawer. The panel used to sit across
 * the top of the Billing tab, so reaching the estimates meant scrolling past
 * it every time; three small squares say the same thing in a tenth of the
 * height and stay pinned while the tab scrolls.
 *
 * Gated exactly like the panel: never rendered for a role that cannot see
 * money, and the RPC refuses anyway.
 */
export function JobRunningCostWidgets({ jobId }: { jobId: string }) {
  const [open, setOpen] = useState(false);
  const costQ = useQuery({
    queryKey: ["job-running-cost", jobId],
    queryFn: () => jobRunningCost(jobId),
  });
  const thresholdQ = useQuery({
    queryKey: ["margin-threshold"],
    queryFn: getMarginThreshold,
  });

  const c = costQ.data;
  const threshold = thresholdQ.data ?? 25;
  const costed = !!c && c.total_cost > 0;
  const below = costed && c.margin_pct != null && c.margin_pct < threshold;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0 p-4 pb-2">
        <CardTitle className="text-sm">Running cost</CardTitle>
        <Button
          size="sm"
          variant="ghost"
          className="-mr-2 h-7 px-2 text-xs"
          onClick={() => setOpen(true)}
          disabled={!c}
        >
          Details
          <ChevronRight className="ml-0.5 size-3.5" />
        </Button>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        {costQ.isLoading ? (
          <p className="text-xs text-muted-foreground">Adding up the job…</p>
        ) : costQ.isError ? (
          <p className="text-xs text-destructive">
            Could not add up this job. These are not zeros — they are unknown.
          </p>
        ) : !c ? null : (
          <div className="grid grid-cols-3 gap-1.5">
            <CostTile label="Cost" value={moneyExact(c.total_cost)} />
            <CostTile
              label="Revenue"
              value={c.revenue > 0 ? moneyExact(c.revenue) : "—"}
              note={REVENUE_BASIS_LABEL[c.revenue_basis].short}
            />
            {/*
              Profit in money, not only as a percentage. David, 16 Sep, asked to
              see "the amounts" — cost, revenue and margin — and the money was
              previously the one thing this tile dropped the moment the margin
              fell under the floor, which is exactly when somebody wants to know
              what it is worth.
            */}
            <CostTile
              label="Margin"
              value={
                c.margin_pct == null || c.total_cost === 0 ? "—" : `${c.margin_pct.toFixed(0)}%`
              }
              tone={costed ? marginTone(c.margin_pct, threshold) : undefined}
              note={
                c.revenue === 0
                  ? "no revenue yet"
                  : c.total_cost === 0
                    ? "no costs yet"
                    : below
                      ? `${moneyExact(c.margin)} · under ${threshold}% floor`
                      : moneyExact(c.margin)
              }
              warn={below}
            />
          </div>
        )}
        {/* Where the three numbers come from, so they can be trusted or
            challenged without opening the drawer. */}
        {c && !costQ.isLoading && !costQ.isError ? (
          <p className="mt-2 text-[10px] leading-snug text-muted-foreground">
            {c.total_cost > 0
              ? "Cost is field tickets, the time clock, the drying log, supplies, stock, subcontractors, expenses, referral and typed cost lines to date."
              : c.calculator_cost > 0
                ? `No cost recorded against this job yet. The calculator projected ${moneyExact(c.calculator_cost)}; Details lists every source at $0.`
                : "No cost recorded against this job yet — Details lists every source at $0."}{" "}
            {REVENUE_BASIS_LABEL[c.revenue_basis].sentence}
          </p>
        ) : null}
      </CardContent>

      {/* The panel itself, unchanged, in a drawer — the breakdown by
          component and the rates link are for the office, not the glance. */}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="w-full sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>Running cost</SheetTitle>
            {/*
              Says what the sheet IS, and stops. How equipment accrues, how a
              field ticket prices its day and where the rates live are all in
              the panel's own footer, two inches below this line and on screen
              at the same time. David, 17 Sep, on the billing copy: "making
              sure that it talks to everything and running costs and this
              aren't repetitious."
            */}
            <SheetDescription>Cost to date against revenue, by component.</SheetDescription>
          </SheetHeader>
          {open && <JobRunningCostPanel jobId={jobId} />}
        </SheetContent>
      </Sheet>
    </Card>
  );
}

function CostTile({
  label,
  value,
  note,
  tone,
  warn,
}: {
  label: string;
  value: string;
  note?: string;
  tone?: string;
  warn?: boolean;
}) {
  return (
    <div
      className={cn(
        "min-w-0 rounded-md border px-2 py-1.5",
        warn && "border-warning/50 bg-warning/10",
      )}
    >
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
        {warn && <AlertTriangle className="size-3 text-warning" />}
      </div>
      <FitText className={cn("text-sm font-semibold tabular-nums", tone)} title={value}>
        {value}
      </FitText>
      {note && <div className="truncate text-[10px] text-muted-foreground">{note}</div>}
    </div>
  );
}

export type { RunningCost };
