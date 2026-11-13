import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, Minus } from "lucide-react";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { EmptyLine } from "@/components/ui-density";
import {
  conversionOf,
  fetchRepDeals,
  initialsOf,
  median,
  moneyFull,
  pacePct,
  type DirectorRepRow,
} from "@/lib/sales-director";
import { FitText } from "@/components/ui/fit-text";
import { ACTIVITY_METRICS, GOAL_METRICS } from "@/lib/goals";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
/**
 * "Why isn't this rep performing." Activity against team median and against
 * their own last period, where the funnel breaks, stalled deals, lost reasons
 * and goal pacing — the answers a director wants before the 1:1.
 */

function Delta({ now, then, label }: { now: number; then: number; label: string }) {
  const diff = then === 0 ? (now === 0 ? 0 : 100) : ((now - then) / then) * 100;
  const Icon = diff > 2 ? ArrowUp : diff < -2 ? ArrowDown : Minus;
  const tone =
    diff > 2 ? "text-[var(--success)]" : diff < -2 ? "text-destructive" : "text-muted-foreground";
  return (
    <span className={`inline-flex items-center gap-1 text-[12px] ${tone}`}>
      <Icon className="size-3" />
      {Math.abs(Math.round(diff))}% {label}
    </span>
  );
}

function Row({
  label,
  value,
  medianValue,
  prior,
  target,
  elapsed,
  format,
}: {
  label: string;
  value: number;
  medianValue: number;
  prior: number;
  target: number | null;
  elapsed: number;
  format?: (v: number) => string;
}) {
  const f = format ?? ((v: number) => Math.round(v).toLocaleString("en-US"));
  const pace = pacePct(value, target, elapsed);
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-baseline justify-between">
        <span className="shrink-0 text-[13px] text-muted-foreground">{label}</span>
        <FitText className="text-[18px] font-semibold tabular-nums">{f(value)}</FitText>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-[12px] text-muted-foreground">Team median {f(medianValue)}</span>
        <Delta now={value} then={prior} label="vs last period" />
      </div>
      {target ? (
        <div className="mt-2">
          <Progress value={Math.min(100, (value / target) * 100)} className="h-1.5" />
          <div className="mt-1 text-[12px] text-muted-foreground">
            {f(value)} of {f(target)} goal
            {pace !== null ? ` · ${Math.round(pace)}% of pace` : ""}
          </div>
        </div>
      ) : (
        <div className="mt-2 text-[12px] text-muted-foreground">No goal set</div>
      )}
    </div>
  );
}

export function RepDiagnostic({
  rep,
  rows,
  prior,
  elapsed,
  open,
  onOpenChange,
}: {
  rep: DirectorRepRow | null;
  rows: DirectorRepRow[];
  prior: DirectorRepRow[];
  elapsed: number;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const deals = useQuery({
    queryKey: ["director-rep-deals", rep?.user_id],
    enabled: !!rep && open,
    queryFn: () => fetchRepDeals(rep!.user_id),
  });

  if (!rep) return null;

  const last = prior.find((p) => p.user_id === rep.user_id);
  const zero: DirectorRepRow = {
    ...rep,
    revenue: 0,
    calls: 0,
    appointments: 0,
    jobs_won: 0,
    activity: Object.fromEntries(ACTIVITY_METRICS.map((m) => [m, 0])) as DirectorRepRow["activity"],
  };
  const before = last ?? zero;

  const med = {
    revenue: median(rows.map((r) => r.revenue)),
    calls: median(rows.map((r) => r.calls)),
    appointments: median(rows.map((r) => r.appointments)),
    jobs_won: median(rows.map((r) => r.jobs_won)),
  };
  // Mark's six activity goals (16 Sep 2026), same Row as the four above.
  // Rendered only once the migration has put the columns there — a null
  // actual is "not measured yet", and a row of zeros would read as "did
  // nothing".
  const activityRows = ACTIVITY_METRICS.filter((m) => rep.activity[m] != null).map((m) => ({
    metric: m,
    label: GOAL_METRICS[m].label,
    value: rep.activity[m] ?? 0,
    medianValue: median(rows.map((r) => r.activity[m] ?? 0)),
    prior: before.activity[m] ?? 0,
    target: rep.activity_target[m],
  }));

  const callToAppt = rep.calls > 0 ? (rep.appointments / rep.calls) * 100 : 0;
  const teamCallToAppt = med.calls > 0 ? (med.appointments / med.calls) * 100 : 0;
  const apptToJob = conversionOf(rep);
  const teamApptToJob = med.appointments > 0 ? (med.jobs_won / med.appointments) * 100 : 0;

  const breakPoint =
    rep.calls < med.calls * 0.7
      ? "Activity — call volume is well below the team median."
      : callToAppt < teamCallToAppt * 0.7
        ? "Calls to appointments — reps are dialling but not booking."
        : apptToJob < teamApptToJob * 0.7
          ? "Appointments to jobs — meetings happen but do not close."
          : "No single break — the funnel converts at or above team median.";

  const stalled = (deals.data ?? []).filter((d) => !d.lost_reason);
  const lost = (deals.data ?? []).filter((d) => !!d.lost_reason);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <span className="grid size-8 place-items-center rounded-full bg-muted text-[12px] font-semibold">
              {initialsOf(rep.full_name)}
            </span>
            {rep.full_name}
          </SheetTitle>
          <SheetDescription>Diagnostic for the selected period.</SheetDescription>
        </SheetHeader>

        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          <Row
            label="Revenue"
            value={rep.revenue}
            medianValue={med.revenue}
            prior={before.revenue}
            target={rep.revenue_target}
            elapsed={elapsed}
            format={moneyFull}
          />
          <Row
            label="Calls"
            value={rep.calls}
            medianValue={med.calls}
            prior={before.calls}
            target={rep.calls_target}
            elapsed={elapsed}
          />
          <Row
            label="Appointments"
            value={rep.appointments}
            medianValue={med.appointments}
            prior={before.appointments}
            target={rep.appointments_target}
            elapsed={elapsed}
          />
          <Row
            label="Jobs won"
            value={rep.jobs_won}
            medianValue={med.jobs_won}
            prior={before.jobs_won}
            target={rep.jobs_target}
            elapsed={elapsed}
          />
          {activityRows.map((a) => (
            <Row
              key={a.metric}
              label={a.label}
              value={a.value}
              medianValue={a.medianValue}
              prior={a.prior}
              target={a.target}
              elapsed={elapsed}
            />
          ))}
        </div>

        <div className="mt-4 rounded-lg border border-border bg-card p-3">
          <h4 className="text-[13px] font-semibold">Where the funnel breaks</h4>
          <div className="mt-2 flex items-center gap-2 text-[13px] tabular-nums">
            <span>{rep.calls} calls</span>
            <span className="text-muted-foreground">→</span>
            <span>{rep.appointments} appts</span>
            <Badge variant="outline" className="text-[11px]">
              {Math.round(callToAppt)}% · team {Math.round(teamCallToAppt)}%
            </Badge>
            <span className="text-muted-foreground">→</span>
            <span>{rep.jobs_won} jobs</span>
            <Badge variant="outline" className="text-[11px]">
              {Math.round(apptToJob)}% · team {Math.round(teamApptToJob)}%
            </Badge>
          </div>
          <p className="mt-2 text-[13px] text-muted-foreground">{breakPoint}</p>
        </div>

        <div className="mt-4 rounded-lg border border-border bg-card p-3">
          <h4 className="text-[13px] font-semibold">Stalled deals ({stalled.length})</h4>
          {stalled.length === 0 ? (
            <EmptyLine>Nothing sitting untouched for 14 days.</EmptyLine>
          ) : (
            <ul className="mt-2 space-y-1">
              {stalled.slice(0, 8).map((d) => (
                <li key={d.account_id} className="flex items-center justify-between text-[13px]">
                  <Link
                    to="/accounts/$id"
                    params={{ id: d.account_id }}
                    className="text-primary hover:underline"
                  >
                    {d.name}
                  </Link>
                  <span className="text-[12px] text-muted-foreground">
                    {d.stage ?? "—"} ·{" "}
                    {d.stage_changed_at
                      ? new Date(d.stage_changed_at).toLocaleDateString(DATE_LOCALE, US_DATE)
                      : "no movement"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="mt-4 mb-6 rounded-lg border border-border bg-card p-3">
          <h4 className="text-[13px] font-semibold">Lost reasons ({lost.length})</h4>
          {lost.length === 0 ? (
            <EmptyLine>No lost reasons recorded in this book.</EmptyLine>
          ) : (
            <ul className="mt-2 space-y-1">
              {lost.slice(0, 8).map((d) => (
                <li key={d.account_id} className="flex items-center justify-between text-[13px]">
                  <Link
                    to="/accounts/$id"
                    params={{ id: d.account_id }}
                    className="text-primary hover:underline"
                  >
                    {d.name}
                  </Link>
                  <span className="text-[12px] text-muted-foreground">{d.lost_reason}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
