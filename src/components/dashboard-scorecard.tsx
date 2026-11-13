import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Building2 } from "lucide-react";

import { useAppContext } from "@/components/app-context";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyLine, LoadError } from "@/components/ui-density";
import { money } from "@/lib/finance";
import {
  fetchLocationScorecard,
  scorecardWindows,
  type Bucket,
  type ScorecardRow,
} from "@/lib/location-scorecard";
import { delta, formatRange, toDateStr } from "@/lib/period";
import { useMyPermissions } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { FitText } from "@/components/ui/fit-text";

/**
 * Scorecard — jobs, invoiced and collected per office, month to date, against
 * the same span last month and last year.
 *
 * Money is gated on `job.view_costs`, the same capability `invoices_select`
 * checks in the database. A viewer without it sees the job count and is told
 * the figures are withheld; it never renders money as zero.
 */

const NUM_COL = "text-right tabular-nums";

function count(n: number) {
  return n.toLocaleString("en-US");
}

/**
 * A bare percentage turns 1 job into 3 and calls it "+200%". The figure it
 * grew from is always printed beside it.
 */
function DeltaLine({
  label,
  current,
  prior,
  fmt,
}: {
  label: string;
  current: number;
  prior: number;
  fmt: (n: number) => string;
}) {
  const d = delta(current, prior);
  const pct =
    d.pct == null
      ? prior === 0 && current > 0
        ? "new"
        : "—"
      : `${d.pct > 0 ? "+" : ""}${Math.round(d.pct * 100)}%`;
  return (
    <div className="text-[11px] text-muted-foreground">
      <span className="text-muted-foreground/70">{label} </span>
      <span
        className={cn(
          "font-medium tabular-nums",
          d.direction === "up" && "text-success",
          d.direction === "down" && "text-destructive",
        )}
      >
        {pct}
      </span>
      <span className="tabular-nums"> from {fmt(prior)}</span>
    </div>
  );
}

function MetricCell({
  row,
  pick,
  fmt,
}: {
  row: ScorecardRow;
  pick: (b: Bucket) => number;
  fmt: (n: number) => string;
}) {
  const now = pick(row.current);
  return (
    <div className={NUM_COL}>
      <FitText className="text-[15px] font-semibold tabular-nums">{fmt(now)}</FitText>
      <DeltaLine label="MoM" current={now} prior={pick(row.mom)} fmt={fmt} />
      <DeltaLine label="YoY" current={now} prior={pick(row.yoy)} fmt={fmt} />
    </div>
  );
}

/**
 * Phone form of one office: the three metrics become labelled rows instead of
 * columns. Four columns of money plus two delta lines cannot be read at 390px —
 * it either overflows the page or shrinks the figures past legibility.
 */
function ScorecardRowCard({
  name,
  row,
  canMoney,
}: {
  name: string;
  row: ScorecardRow;
  canMoney: boolean;
}) {
  return (
    <div className="rounded-md border p-3">
      <div className="mb-2 text-[13px] font-semibold">{name}</div>
      <dl className="space-y-2">
        <div className="flex items-start justify-between gap-3">
          <dt className="text-[11px] font-medium text-muted-foreground">Jobs</dt>
          <dd className="min-w-0">
            <MetricCell row={row} pick={(b) => b.jobs} fmt={count} />
          </dd>
        </div>
        {canMoney && (
          <>
            <div className="flex items-start justify-between gap-3">
              <dt className="text-[11px] font-medium text-muted-foreground">Invoiced</dt>
              <dd className="min-w-0">
                <MetricCell row={row} pick={(b) => b.invoiced} fmt={money} />
              </dd>
            </div>
            <div className="flex items-start justify-between gap-3">
              <dt className="text-[11px] font-medium text-muted-foreground">Collections</dt>
              <dd className="min-w-0">
                <MetricCell row={row} pick={(b) => b.collected} fmt={money} />
              </dd>
            </div>
          </>
        )}
      </dl>
    </div>
  );
}

export function ScorecardCard() {
  const app = useAppContext();
  const { loading: permsLoading, allowed } = useMyPermissions();
  const canMoney = allowed.has("job.view_costs");

  const windows = useMemo(() => scorecardWindows(), []);
  const q = useQuery({
    // The day is in the key so the windows roll over instead of going stale.
    queryKey: [
      "location-scorecard",
      app.currentLocationId,
      canMoney,
      toDateStr(windows.current.to),
    ],
    enabled: !permsLoading,
    queryFn: () =>
      fetchLocationScorecard({
        locationId: app.currentLocationId,
        includeMoney: canMoney,
        windows,
      }),
  });

  const names = useMemo(() => {
    const m = new Map<string, string>();
    for (const l of [...app.allLocations, ...app.visibleLocations]) m.set(l.id, l.name);
    return m;
  }, [app.allLocations, app.visibleLocations]);

  const rows = useMemo(
    () =>
      [...(q.data?.rows ?? [])].sort((a, b) =>
        (names.get(a.locationId) ?? a.locationId).localeCompare(
          names.get(b.locationId) ?? b.locationId,
        ),
      ),
    [q.data, names],
  );

  const cols = canMoney
    ? "grid-cols-[minmax(6rem,1.3fr)_repeat(3,minmax(6.5rem,1fr))]"
    : "grid-cols-[minmax(6rem,1.3fr)_minmax(6.5rem,1fr)]";

  return (
    <Card className="flex h-full flex-col">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-1.5">
          <Building2 className="h-4 w-4 text-muted-foreground" />
          Scorecard
        </CardTitle>
        <CardDescription>
          {formatRange(windows.current)} · MoM vs {formatRange(windows.mom)} · YoY vs{" "}
          {formatRange(windows.yoy)}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex-1 space-y-2">
        {q.isError ? (
          <LoadError what="the scorecard" error={q.error} onRetry={() => void q.refetch()} />
        ) : permsLoading || q.isPending ? (
          <EmptyLine>Loading…</EmptyLine>
        ) : !rows.length ? (
          <EmptyLine>No jobs, invoices or payments in any of these three spans.</EmptyLine>
        ) : (
          <>
            <div className="space-y-2 sm:hidden">
              {rows.map((r) => (
                <ScorecardRowCard
                  key={r.locationId}
                  name={names.get(r.locationId) ?? "Unnamed office"}
                  row={r}
                  canMoney={canMoney}
                />
              ))}
            </div>

            {/* Tablet and up keep the column layout; the scroller is the
                guard so a long office name can never widen the page. */}
            <div className="hidden overflow-x-auto sm:block">
              <div className={cn("grid min-w-[26rem] gap-x-3 gap-y-2.5", cols)}>
                <div className="text-[11px] font-medium text-muted-foreground">Office</div>
                <div className={cn(NUM_COL, "text-[11px] font-medium text-muted-foreground")}>
                  Jobs
                </div>
                {canMoney && (
                  <>
                    <div className={cn(NUM_COL, "text-[11px] font-medium text-muted-foreground")}>
                      Invoiced
                    </div>
                    <div className={cn(NUM_COL, "text-[11px] font-medium text-muted-foreground")}>
                      Collections
                    </div>
                  </>
                )}

                {rows.map((r) => (
                  <div key={r.locationId} className="contents">
                    <div className="self-center truncate text-[13px] font-medium">
                      {names.get(r.locationId) ?? "Unnamed office"}
                    </div>
                    <MetricCell row={r} pick={(b) => b.jobs} fmt={count} />
                    {canMoney && (
                      <>
                        <MetricCell row={r} pick={(b) => b.invoiced} fmt={money} />
                        <MetricCell row={r} pick={(b) => b.collected} fmt={money} />
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {!canMoney && (
              <p className="text-[12px] text-muted-foreground">
                Invoiced and collections are not shown to your role.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
