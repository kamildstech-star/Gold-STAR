import { useEffect, useMemo, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  MessageSquare,
  Send,
  Target,
  Trophy,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAppContext } from "@/components/app-context";
import { HeroRing } from "@/components/goals/hero-ring";
import { TrophyCase } from "@/components/leaderboard/trophy-case";
import { useGoalProgress } from "@/lib/goal-progress";
import {
  ACTIVITY_METRICS,
  GOAL_METRICS,
  goalWindow,
  type GoalMetric,
  type GoalPeriod,
} from "@/lib/goals";
import { fetchStandings, type Standing } from "@/lib/leaderboard";
import { money } from "@/lib/finance";
import { canSeeMoney, isSalesLeadership } from "@/lib/roles";
import { toastDbError } from "@/lib/db-errors";
import {
  fetchMyLeadership,
  fetchRepSnapshot,
  fetchViewableReps,
  openDirectConversation,
  requestGoalReview,
  type RepOption,
  type RepSnapshot,
} from "@/lib/my-goals";
import { cn } from "@/lib/utils";
import { FitText } from "@/components/ui/fit-text";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
/**
 * My Goals — the rep's own scoreboard.
 *
 * Attainment comes from `useGoalProgress`, the same reader the dashboard goal
 * card uses, so the two screens can never disagree. Money follows the money
 * rule: reps see progress as percentages, leadership sees the dollars.
 */

type Search = { u?: string; p?: GoalPeriod };

export const Route = createFileRoute("/_authenticated/my-goals")({
  validateSearch: (s: Record<string, unknown>): Search => ({
    u: typeof s.u === "string" ? s.u : undefined,
    p: s.p === "month" || s.p === "quarter" || s.p === "year" ? s.p : undefined,
  }),
  component: MyGoalsPage,
});

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("") || "?";

function daysLeftIn(period: GoalPeriod) {
  const w = goalWindow(period);
  const end = new Date(`${w.endsOn}T23:59:59Z`).getTime();
  return Math.max(0, Math.ceil((end - Date.now()) / 86_400_000));
}

function MetricTile({
  label,
  actual,
  target,
  format,
  hideValues,
}: {
  label: string;
  actual: number | null;
  target: number | null;
  format: (n: number) => string;
  hideValues?: boolean;
}) {
  const ratio = target && target > 0 && actual != null ? actual / target : null;
  const met = ratio != null && ratio >= 1;
  return (
    <Card className="overflow-hidden">
      <CardContent className="space-y-2 p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
            {label}
          </span>
          {met && (
            <Badge className="h-4 gap-1 bg-success px-1.5 text-[9px] font-bold uppercase text-success-foreground">
              <CheckCircle2 className="h-2.5 w-2.5" /> Goal met
            </Badge>
          )}
        </div>
        <div className="flex items-baseline gap-1.5">
          <FitText className="font-display text-[22px] font-bold leading-none tabular-nums">
            {hideValues
              ? ratio == null
                ? "—"
                : `${Math.round(ratio * 100)}%`
              : actual == null
                ? "—"
                : format(actual)}
          </FitText>
          {!hideValues && target != null && target > 0 && (
            <span className="shrink-0 text-[11px] text-muted-foreground">of {format(target)}</span>
          )}
        </div>
        <div className="h-1.5 w-full rounded-full bg-muted">
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-500",
              ratio == null
                ? "bg-transparent"
                : ratio >= 1
                  ? "bg-success"
                  : ratio >= 0.6
                    ? "bg-brand-gold"
                    : "bg-brand",
            )}
            style={{ width: `${Math.min(100, Math.max(0, (ratio ?? 0) * 100))}%` }}
          />
        </div>
        <div className="text-[10px] text-muted-foreground">
          {ratio == null ? "No target set" : `${Math.round(ratio * 100)}% of target`}
        </div>
      </CardContent>
    </Card>
  );
}

function MyGoalsPage() {
  const app = useAppContext();
  const search = Route.useSearch();
  const navigate = useNavigate();

  // The Dashboard goal card is month-to-date. Opening My Goals without an
  // explicit period must therefore land on the same target and actuals.
  const period: GoalPeriod = search.p ?? "month";
  const leadership =
    isSalesLeadership(app.roles) ||
    app.roles.includes("admin") ||
    app.roles.includes("owner") ||
    app.roles.includes("dev") ||
    app.roles.includes("location_manager") ||
    app.roles.includes("regional");
  // Under View As "my" goals are the viewed person's (viewerUserId). The
  // review / message buttons below still act as the signed-in user.
  const subjectId = (leadership && search.u) || app.viewerUserId;
  const isSelf = subjectId === app.viewerUserId;
  const showMoney = canSeeMoney(app.roles);

  const progress = useGoalProgress(subjectId, period);
  const [standing, setStanding] = useState<Standing | null>(null);
  const [snapshot, setSnapshot] = useState<RepSnapshot | null>(null);
  const [reps, setReps] = useState<RepOption[]>([]);
  const [managers, setManagers] = useState<RepOption[]>([]);
  const [busy, setBusy] = useState(false);

  const win = useMemo(() => goalWindow(period), [period]);

  useEffect(() => {
    if (!subjectId) return;
    let cancelled = false;
    fetchStandings(win.from, win.to, null)
      .then((rows) => !cancelled && setStanding(rows.find((r) => r.user_id === subjectId) ?? null))
      .catch(() => !cancelled && setStanding(null));
    fetchRepSnapshot(subjectId, win.from, win.to)
      .then((s) => !cancelled && setSnapshot(s))
      .catch(() => !cancelled && setSnapshot(null));
    return () => {
      cancelled = true;
    };
  }, [subjectId, win.from, win.to]);

  useEffect(() => {
    if (leadership)
      fetchViewableReps()
        .then(setReps)
        .catch(() => setReps([]));
    fetchMyLeadership()
      .then(setManagers)
      .catch(() => setManagers([]));
  }, [leadership]);

  const subjectName =
    (isSelf
      ? (app.viewingAsPerson?.name ?? app.fullName)
      : reps.find((r) => r.userId === subjectId)?.name) || "This rep";
  const daysLeft = daysLeftIn(period);
  const elapsed = progress.elapsed;
  const attainment = progress.attainment;
  const onTrack = attainment == null ? null : attainment >= elapsed - 0.05;

  const targetFor = (metric: GoalMetric) =>
    progress.lines.find((l) => l.metric === metric)?.target ?? null;

  // Mark's six activity goals (16 Sep 2026) get a tile each, but only when a
  // target is set for that metric — the four tiles above are the fixed
  // headline; ten permanent tiles would bury it. Actual and target come off
  // the same `progress.lines` the dashboard card renders.
  const activityLines = ACTIVITY_METRICS.map((m) =>
    progress.lines.find((l) => l.metric === m),
  ).filter((l): l is NonNullable<typeof l> => l != null);

  const conversion =
    standing && standing.meetings_held > 0 ? standing.jobs_won / standing.meetings_held : null;

  async function onRequestReview() {
    const manager = managers.find((m) => m.userId !== app.userId);
    if (!app.userId || !manager) {
      toast.error("No sales manager found to notify.");
      return;
    }
    setBusy(true);
    try {
      const conversationId = await requestGoalReview({
        me: app.userId,
        managerId: manager.userId,
        periodLabel: win.label,
        attainment,
        daysLeft,
      });
      toast.success(`Goal review requested from ${manager.name}.`);
      navigate({ to: "/chat/$conversationId", params: { conversationId } });
    } catch (e) {
      toastDbError(e, { action: "send the review request" });
    } finally {
      setBusy(false);
    }
  }

  async function onMessageDirector() {
    const director = managers.find((m) => m.userId !== app.userId);
    if (!app.userId || !director) {
      toast.error("No sales director found.");
      return;
    }
    setBusy(true);
    try {
      const conversationId = await openDirectConversation(app.userId, director.userId);
      navigate({ to: "/chat/$conversationId", params: { conversationId } });
    } catch (e) {
      toastDbError(e, { action: "open the chat" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1180px] space-y-4 p-4">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-brand text-[13px] font-bold text-brand-foreground">
          {initials(subjectName)}
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-[20px] font-bold leading-tight">
            {isSelf ? "My Goals" : `${subjectName}'s Goals`}
          </h1>
          <div className="truncate text-[12px] text-muted-foreground">
            {subjectName}
            {app.primary && isSelf ? ` · ${app.primary.replace(/_/g, " ")}` : ""}
          </div>
        </div>

        {leadership && reps.length > 0 && (
          <Select
            value={subjectId ?? ""}
            onValueChange={(v) =>
              navigate({
                to: "/my-goals",
                search: { u: v === app.viewerUserId ? undefined : v, p: period },
              })
            }
          >
            <SelectTrigger className="h-8 w-[200px] text-[12px]">
              <SelectValue placeholder="Rep" />
            </SelectTrigger>
            <SelectContent>
              {reps.map((r) => (
                <SelectItem key={r.userId} value={r.userId} className="text-[12px]">
                  {r.userId === app.viewerUserId ? `${r.name} (me)` : r.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <Select
          value={period}
          onValueChange={(v) =>
            navigate({ to: "/my-goals", search: { u: search.u, p: v as GoalPeriod } })
          }
        >
          <SelectTrigger className="h-8 w-[150px] text-[12px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="month" className="text-[12px]">
              {goalWindow("month").label}
            </SelectItem>
            <SelectItem value="quarter" className="text-[12px]">
              {goalWindow("quarter").label}
            </SelectItem>
            <SelectItem value="year" className="text-[12px]">
              {goalWindow("year").label}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Hero */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-6 p-5">
          <HeroRing value={attainment} />
          <div className="min-w-[240px] flex-1 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                className={cn(
                  "h-5 px-2 text-[10px] font-bold uppercase tracking-wide",
                  onTrack == null
                    ? "bg-muted text-muted-foreground"
                    : onTrack
                      ? "bg-success text-success-foreground"
                      : "bg-destructive text-destructive-foreground",
                )}
              >
                {onTrack == null ? "No target set" : onTrack ? "On track" : "Behind pace"}
              </Badge>
              <span className="inline-flex items-center gap-1 text-[12px] text-muted-foreground">
                <CalendarClock className="h-3.5 w-3.5" />
                {daysLeft} day{daysLeft === 1 ? "" : "s"} left in {win.label}
              </span>
            </div>
            <div className="text-[13px] text-muted-foreground">
              {attainment == null
                ? "Nobody has set a target for this period yet."
                : `${Math.round(attainment * 100)}% of target with ${Math.round(
                    elapsed * 100,
                  )}% of the period gone.`}
            </div>
            <div className="h-1.5 w-full rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-foreground/25"
                style={{ width: `${Math.round(elapsed * 100)}%` }}
              />
            </div>
            {progress.why && (
              <div className="rounded-md bg-[color-mix(in_oklab,var(--warning)_14%,var(--card))] px-3 py-2 text-[12px]">
                <span className="mr-1 text-[10px] font-bold uppercase tracking-wide text-brand-gold">
                  My why
                </span>
                {progress.why}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Metric row */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricTile
          label="Revenue"
          actual={standing?.billed_value ?? null}
          target={targetFor("billed_value")}
          format={(n) => money(n)}
          hideValues={!showMoney}
        />
        <MetricTile
          label="Jobs won"
          actual={standing?.jobs_won ?? null}
          target={targetFor("jobs_won")}
          format={GOAL_METRICS.jobs_won.format}
        />
        <MetricTile
          label="Inspections"
          actual={standing?.meetings_held ?? null}
          target={targetFor("meetings_held")}
          format={GOAL_METRICS.meetings_held.format}
        />
        <MetricTile
          label="Conversion"
          actual={conversion == null ? null : conversion * 100}
          target={null}
          format={(n) => `${Math.round(n)}%`}
        />
      </div>

      {activityLines.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {activityLines.map((l) => (
            <MetricTile
              key={l.metric}
              label={GOAL_METRICS[l.metric].label}
              actual={l.actual}
              target={l.target}
              format={(n) => GOAL_METRICS[l.metric].format(n)}
            />
          ))}
        </div>
      )}

      <div className="grid gap-3 lg:grid-cols-[1.4fr_1fr]">
        {/* Next steps */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-[13px] font-bold uppercase tracking-wide">
              <Target className="h-4 w-4 text-brand" /> Next steps
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {!snapshot ? (
              <div className="px-4 py-6 text-[12px] text-muted-foreground">Loading…</div>
            ) : snapshot.nextSteps.length === 0 ? (
              <div className="px-4 py-6 text-[12px] text-muted-foreground">
                Nothing outstanding — no open estimates, silent inspections or aging leads.
              </div>
            ) : (
              <ul className="divide-y">
                {snapshot.nextSteps.map((s) => (
                  <li key={s.id}>
                    <Link
                      to={s.href}
                      className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/50"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-semibold">{s.title}</div>
                        <div className="truncate text-[11px] text-muted-foreground">{s.detail}</div>
                      </div>
                      {showMoney && s.value != null && (
                        <span className="text-[12px] font-semibold tabular-nums">
                          {money(s.value)}
                        </span>
                      )}
                      <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Recent wins */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-[13px] font-bold uppercase tracking-wide">
              <Trophy className="h-4 w-4 text-brand-gold" /> Recent wins
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {!snapshot || snapshot.wins.length === 0 ? (
              <div className="px-4 py-6 text-[12px] text-muted-foreground">
                No jobs closed in {win.label} yet.
              </div>
            ) : (
              <ul className="divide-y">
                {snapshot.wins.map((w) => (
                  <li key={w.id}>
                    <Link
                      to={w.href}
                      className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/50"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-semibold">{w.name}</div>
                        <div className="text-[11px] text-muted-foreground">
                          {new Date(w.closedOn).toLocaleDateString(DATE_LOCALE, US_DATE)}
                          {w.jobNumber ? ` · ${w.jobNumber}` : ""}
                        </div>
                      </div>
                      {showMoney && w.value != null && (
                        <span className="text-[12px] font-semibold tabular-nums">
                          {money(w.value)}
                        </span>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Trophy case */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-[13px] font-bold uppercase tracking-wide">
            <Trophy className="h-4 w-4 text-brand-gold" /> Trophy case
          </CardTitle>
        </CardHeader>
        <CardContent>{subjectId ? <TrophyCase userId={subjectId} /> : null}</CardContent>
      </Card>

      {/* Footer actions */}
      {isSelf && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={onRequestReview} disabled={busy} className="gap-1.5">
            <Send className="h-3.5 w-3.5" /> Request goal review
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onMessageDirector}
            disabled={busy}
            className="gap-1.5"
          >
            <MessageSquare className="h-3.5 w-3.5" /> Message Sales Director
          </Button>
        </div>
      )}
    </div>
  );
}
