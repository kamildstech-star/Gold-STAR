import { createFileRoute, useParams, useSearch } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { buildCoachingPack, NUDGE_KIND_LABEL } from "@/lib/coaching";
import { GOAL_METRICS, fmtPct } from "@/lib/goals";
import { useAppContext } from "@/components/app-context";
import { isPrivileged } from "@/lib/roles";

export const Route = createFileRoute("/_authenticated/coaching/pack/$userId")({
  validateSearch: (s: Record<string, unknown>) => ({ name: (s["name"] as string) ?? "" }),
  head: () => ({
    meta: [
      { title: "1:1 pack · Recovery Hub" },
      {
        name: "description",
        content:
          "An automatically prepared one-to-one pack: funnel, activity, pacing, stalled deals and lost reasons for a single rep.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: CoachingPackPage,
});

const int = (v: number | null | undefined) =>
  v == null ? "—" : Math.round(v).toLocaleString("en-US");

/**
 * The 1:1 pack the manager opens instead of building.
 *
 * Comparison is against the rep's own previous 30 days and the anonymous team
 * median. No peer is ever named, and money lines only render for roles allowed
 * to see finance.
 */
function CoachingPackPage() {
  const { userId } = useParams({ from: "/_authenticated/coaching/pack/$userId" });
  const { name } = useSearch({ from: "/_authenticated/coaching/pack/$userId" });
  const app = useAppContext();
  const money = isPrivileged(app.roles);

  const pack = useQuery({
    queryKey: ["coaching-pack", userId],
    queryFn: () => buildCoachingPack(userId, name || "This rep"),
  });

  if (pack.isLoading)
    return <div className="p-3 text-sm text-muted-foreground">Building pack…</div>;
  if (pack.error)
    return (
      <div className="p-3 text-sm text-destructive">
        {pack.error instanceof Error ? pack.error.message : "Could not build the pack"}
      </div>
    );

  const p = pack.data!;
  const c = p.current;
  const prev = p.previous;
  const med = p.medians;

  const rows: { label: string; now: number | null; then: number | null; team: number | null }[] = [
    {
      label: "Touchpoints",
      now: c?.touchpoints ?? null,
      then: prev?.touchpoints ?? null,
      team: med?.touchpoints ?? null,
    },
    {
      label: "Meetings held",
      now: c?.meetings_held ?? null,
      then: prev?.meetings_held ?? null,
      team: med?.meetings_held ?? null,
    },
    {
      label: "Accounts advanced",
      now: c?.accounts_advanced ?? null,
      then: prev?.accounts_advanced ?? null,
      team: med?.accounts_advanced ?? null,
    },
    {
      label: "Contact attempts",
      now: c?.contact_attempts ?? null,
      then: prev?.contact_attempts ?? null,
      team: med?.contact_attempts ?? null,
    },
    {
      label: "Jobs won",
      now: c?.jobs_won ?? null,
      then: prev?.jobs_won ?? null,
      team: med?.jobs_won ?? null,
    },
  ];

  return (
    <div className="mx-auto max-w-3xl space-y-3 p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="display-heavy text-[22px] leading-tight">
            1:1 pack — {c?.full_name || name || "Rep"}
          </h1>
          <p className="text-[13px] text-muted-foreground">
            Last 30 days, against their own previous 30 and the anonymous team median.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => window.print()}>
          Print
        </Button>
      </div>

      <Card>
        <CardHeader className="py-3">
          <CardTitle className="text-sm">Activity and funnel</CardTitle>
        </CardHeader>
        <CardContent className="pb-3">
          <table className="w-full text-[13px]">
            <thead className="text-muted-foreground">
              <tr>
                <th className="text-left font-normal">Metric</th>
                <th className="text-right font-normal">Now</th>
                <th className="text-right font-normal">Prev 30</th>
                <th className="text-right font-normal">Team median</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.label} className="border-t">
                  <td className="py-1">{r.label}</td>
                  <td className="py-1 text-right font-medium tabular-nums">{int(r.now)}</td>
                  <td className="py-1 text-right tabular-nums text-muted-foreground">
                    {int(r.then)}
                  </td>
                  <td className="py-1 text-right tabular-nums text-muted-foreground">
                    {int(r.team)}
                  </td>
                </tr>
              ))}
              {money && (
                <tr className="border-t">
                  <td className="py-1">Collected value</td>
                  <td className="py-1 text-right font-medium tabular-nums">
                    ${int(c?.collected_value)}
                  </td>
                  <td className="py-1 text-right tabular-nums text-muted-foreground">
                    ${int(prev?.collected_value)}
                  </td>
                  <td className="py-1 text-right tabular-nums text-muted-foreground">—</td>
                </tr>
              )}
            </tbody>
          </table>

          <div className="mt-2 flex flex-wrap gap-3 text-[13px] text-muted-foreground">
            <span>Touch → meeting {fmtPct(p.conversion.touchToMeeting)}</span>
            <span>Meeting → advance {fmtPct(p.conversion.meetingToAdvance)}</span>
            <span>Advance → won {fmtPct(p.conversion.advanceToWon)}</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="py-3">
          <CardTitle className="text-sm">Goal pacing</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 pb-3 text-[13px]">
          {p.attainment.lines.length === 0 ? (
            <p className="text-muted-foreground">No active goals this month.</p>
          ) : (
            <>
              <p className="text-muted-foreground">
                {fmtPct(p.attainment.pct)} of goal · {fmtPct(p.elapsed)} of the month gone
              </p>
              {p.attainment.lines.map((l) => (
                <div key={l.goal.id} className="flex justify-between border-t py-1">
                  <span>{GOAL_METRICS[l.goal.metric].label}</span>
                  <span className="tabular-nums">
                    {GOAL_METRICS[l.goal.metric].format(l.actual)} /{" "}
                    {GOAL_METRICS[l.goal.metric].format(l.target)} ({fmtPct(l.ratio)})
                  </span>
                </div>
              ))}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="py-3">
          <CardTitle className="text-sm">Stalled deals ({p.stalled.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 pb-3 text-[13px]">
          {p.stalled.length === 0 ? (
            <p className="text-muted-foreground">Nothing stalled.</p>
          ) : (
            p.stalled.slice(0, 12).map((s) => (
              <div key={s.id} className="flex justify-between border-t py-1">
                <span className="truncate">{s.record_label ?? s.record_type}</span>
                <span className="text-muted-foreground">{s.days_stale ?? "—"} days</span>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="py-3">
          <CardTitle className="text-sm">Lost reasons (last 60 days)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 pb-3 text-[13px]">
          {p.lostReasons.length === 0 ? (
            <p className="text-muted-foreground">Nothing lost in the window.</p>
          ) : (
            p.lostReasons.map((l) => (
              <div key={l.reason} className="flex justify-between border-t py-1">
                <span className="truncate capitalize">{l.reason}</span>
                <span className="tabular-nums text-muted-foreground">{l.count}</span>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="py-3">
          <CardTitle className="text-sm">Open nudges ({p.openNudges.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 pb-3 text-[13px]">
          {p.openNudges.length === 0 ? (
            <p className="text-muted-foreground">None outstanding.</p>
          ) : (
            p.openNudges.map((n) => (
              <div key={n.id} className="flex items-center gap-2 border-t py-1">
                <Badge variant="outline" className="text-[11px]">
                  {NUDGE_KIND_LABEL[n.kind] ?? n.kind}
                </Badge>
                <span className="truncate">{n.title}</span>
                {n.nudge_count > 1 && (
                  <span className="ml-auto shrink-0 text-muted-foreground">
                    reminded {n.nudge_count}×
                  </span>
                )}
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
