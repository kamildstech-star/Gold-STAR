import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useAppContext } from "@/components/app-context";
import { LocationPicker } from "@/components/location-picker";
import { PageHeader } from "@/components/ui-density";
import { MetricStrip } from "@/components/metric-strip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toastDbError } from "@/lib/db-errors";
import { ROLE_LABELS, isPrivileged, primaryRole } from "@/lib/roles";
import {
  GOAL_METRICS,
  GOAL_METRIC_LIST,
  GOAL_PERIODS,
  elapsedShare,
  fetchGoals,
  fetchMonthlyChildren,
  goalWindow,
  monthsOfYear,
  saveAnnualGoal,
  setMonthlyTarget,
  splitAnnual,
  saveGoal,
  setGoalActive,
  type Goal,
  type GoalMetric,
  type GoalPeriod,
} from "@/lib/goals";
import {
  fetchStandings,
  motionOf,
  pct,
  rankStandings,
  type Ranked,
  type Standing,
} from "@/lib/leaderboard";
import { carryIntelSearch } from "@/lib/report-search";
import { GoalProgressCard } from "@/components/goal-progress-card";
import { useGoalProgress } from "@/lib/goal-progress";
import { cn } from "@/lib/utils";

type Search = { tab: "mine" | "manage"; gp: GoalPeriod };

export const Route = createFileRoute("/_authenticated/goals/")({
  head: () => ({
    meta: [
      { title: "Goals · Recovery Hub" },
      {
        name: "description",
        content:
          "Set and track sales goals by month, quarter or year — meetings, touchpoints, accounts, contracts and billed value — with attainment measured against real activity.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  validateSearch: (raw: Record<string, unknown>): Search => ({
    tab: raw.tab === "manage" ? "manage" : "mine",
    gp: raw.gp === "month" || raw.gp === "year" ? raw.gp : "quarter",
  }),
  component: GoalsPage,
});

function ProgressBar({ ratio }: { ratio: number | null }) {
  if (ratio == null) return <div className="h-1.5 w-full bg-muted" aria-label="No target set" />;
  const w = Math.max(0, Math.min(1, ratio));
  return (
    <div className="h-1.5 w-full bg-muted">
      <div
        className={cn(
          "h-full",
          ratio >= 1 ? "bg-success" : ratio >= 0.6 ? "bg-brand-gold" : "bg-brand",
        )}
        style={{ width: `${w * 100}%` }}
      />
    </div>
  );
}

function GoalsPage() {
  const app = useAppContext();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  const canManage =
    isPrivileged(app.roles) ||
    app.roles.includes("regional") ||
    app.roles.includes("location_manager") ||
    app.roles.includes("sales_manager");

  const period = search.gp;
  const win = useMemo(() => goalWindow(period), [period]);

  const [standings, setStandings] = useState<Standing[] | null>(null);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([fetchStandings(win.from, win.to, null), fetchGoals({ period, window: win })])
      .then(([s, g]) => {
        if (cancelled) return;
        setStandings(s);
        setGoals(g);
      })
      .catch((e) => {
        if (cancelled) return;
        toastDbError(e, { action: "load goals" });
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [period, win.from.getTime(), win.to.getTime(), reload]);

  const ranked = useMemo(() => rankStandings(standings ?? [], goals), [standings, goals]);
  /* The dashboard widget and this tab read the same hook — one source. */
  const myProgress = useGoalProgress(app.userId, period);
  const elapsed = elapsedShare(period);

  const setTab = (tab: Search["tab"]) => navigate({ search: (p: Search) => ({ ...p, tab }) });
  const setPeriod = (gp: GoalPeriod) => navigate({ search: (p: Search) => ({ ...p, gp }) });

  return (
    <div className="mx-auto max-w-5xl space-y-3 px-4 py-4">
      <PageHeader
        title="Goals"
        subtitle="Attainment is actual ÷ target for the period. Someone with no goal shows “no active goals”, never 0%."
      >
        <Select value={period} onValueChange={(v) => setPeriod(v as GoalPeriod)}>
          <SelectTrigger className="h-8 w-[130px] text-[13px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {GOAL_PERIODS.map((p) => (
              <SelectItem key={p.key} value={p.key}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button asChild variant="outline" size="sm">
          <Link to="/intelligence" search={carryIntelSearch}>
            Intelligence
          </Link>
        </Button>
      </PageHeader>

      <Tabs value={search.tab} onValueChange={(v) => setTab(v as Search["tab"])}>
        <TabsList>
          <TabsTrigger value="mine" className="text-[12px]">
            My goals
          </TabsTrigger>
          {canManage && (
            <TabsTrigger value="manage" className="text-[12px]">
              Goal manager
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="mine" className="mt-2 space-y-3">
          <MetricStrip
            metrics={[
              { label: "Period", value: win.label, note: `${Math.round(elapsed * 100)}% elapsed` },
              { label: "Active goals", value: myProgress.goals.length, note: "set for you" },
              {
                label: "Attainment",
                value: myProgress.attainment == null ? "—" : pct(myProgress.attainment),
                note: myProgress.attainment == null ? "no active goals" : "mean of goal ratios",
              },
            ]}
          />
          <GoalProgressCard
            userId={app.userId}
            period={period}
            progress={myProgress}
            title={`My goals · ${win.label}`}
          />
        </TabsContent>

        {canManage && (
          <TabsContent value="manage" className="mt-2 space-y-3">
            <GoalManager
              ranked={ranked}
              goals={goals}
              period={period}
              win={win}
              loading={loading}
              onSaved={() => setReload((n) => n + 1)}
            />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

function GoalManager({
  ranked,
  goals,
  period,
  win,
  loading,
  onSaved,
}: {
  ranked: Ranked[];
  goals: Goal[];
  period: GoalPeriod;
  win: { startsOn: string; endsOn: string; label: string };
  loading: boolean;
  onSaved: () => void;
}) {
  const app = useAppContext();
  const [editing, setEditing] = useState<{ userId: string; name: string; goal?: Goal } | null>(
    null,
  );
  const [annual, setAnnual] = useState<{ userId: string; name: string } | null>(null);

  const byUser = useMemo(() => {
    const m = new Map<string, Goal[]>();
    for (const g of goals) {
      if (!g.subject_user_id) continue;
      m.set(g.subject_user_id, [...(m.get(g.subject_user_id) ?? []), g]);
    }
    return m;
  }, [goals]);

  if (loading) return <div className="px-1 py-6 text-sm text-muted-foreground">Loading…</div>;
  if (ranked.length === 0)
    return (
      <div className="rounded-md border px-3 py-6 text-sm text-muted-foreground">
        No people are visible to you. Assign roles and locations in Admin → Users.
      </div>
    );

  return (
    <>
      <p className="text-[11px] text-muted-foreground">
        Targets apply to {win.label}. Only people in locations you manage can be given goals; the
        database enforces that regardless of what this list shows.
      </p>

      <div className="divide-y rounded-md border">
        {ranked.map((r) => {
          const list = byUser.get(r.standing.user_id) ?? [];
          const role = primaryRole(r.standing.roles);
          return (
            <div key={r.standing.user_id} className="px-3 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[13px] font-medium">{r.name}</div>
                  <div className="text-[11px] text-muted-foreground">
                    {role ? ROLE_LABELS[role] : "No role"} · {motionOf(r.standing.roles)}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {r.attainment == null ? (
                    <Badge variant="outline" className="text-[10px] font-normal">
                      no active goals
                    </Badge>
                  ) : (
                    <span className="font-mono text-[12px] tabular-nums">{pct(r.attainment)}</span>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={app.writesDisabled}
                    onClick={() => setAnnual({ userId: r.standing.user_id, name: r.name })}
                  >
                    Annual goal
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={app.writesDisabled}
                    onClick={() => setEditing({ userId: r.standing.user_id, name: r.name })}
                  >
                    Add {period} goal
                  </Button>
                </div>
              </div>

              {list.length > 0 && (
                <div className="mt-1.5 space-y-1">
                  {list.map((g) => {
                    const line = r.lines.find((l) => l.metric === g.metric);
                    return (
                      <div key={g.id} className="flex items-center gap-2">
                        <span className="w-[150px] shrink-0 truncate text-[12px]">
                          {GOAL_METRICS[g.metric].label}
                        </span>
                        <div className="flex-1">
                          <ProgressBar ratio={line?.ratio ?? null} />
                        </div>
                        <span className="w-[130px] shrink-0 text-right font-mono text-[11px] tabular-nums">
                          {GOAL_METRICS[g.metric].format(line?.actual ?? null)} /{" "}
                          {GOAL_METRICS[g.metric].format(Number(g.target_value))}
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-[11px]"
                          disabled={app.writesDisabled}
                          onClick={() =>
                            setEditing({ userId: r.standing.user_id, name: r.name, goal: g })
                          }
                        >
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-[11px] text-destructive"
                          disabled={app.writesDisabled}
                          onClick={async () => {
                            try {
                              await setGoalActive(g.id, false);
                              onSaved();
                            } catch (e) {
                              toastDbError(e, { action: "retire goal" });
                            }
                          }}
                        >
                          Retire
                        </Button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {editing && (
        <GoalDialog
          subject={editing}
          period={period}
          win={win}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onSaved();
          }}
        />
      )}

      {annual && (
        <AnnualGoalDialog
          subject={annual}
          onClose={() => setAnnual(null)}
          onSaved={() => {
            setAnnual(null);
            onSaved();
          }}
        />
      )}
    </>
  );
}

function GoalDialog({
  subject,
  period,
  win,
  onClose,
  onSaved,
}: {
  subject: { userId: string; name: string; goal?: Goal };
  period: GoalPeriod;
  win: { startsOn: string; endsOn: string; label: string };
  onClose: () => void;
  onSaved: () => void;
}) {
  const app = useAppContext();
  const g = subject.goal;
  const [metric, setMetric] = useState<GoalMetric>(g?.metric ?? "meetings_held");
  const [target, setTarget] = useState(String(g?.target_value ?? ""));
  const [locationId, setLocationId] = useState(g?.location_id ?? "");
  const [notes, setNotes] = useState(g?.notes ?? "");
  const [saving, setSaving] = useState(false);

  const valid = Number(target) > 0 && !!locationId;

  const submit = async () => {
    if (!valid) return;
    setSaving(true);
    try {
      await saveGoal({
        id: g?.id,
        subject_user_id: subject.userId,
        subject_location_id: null,
        location_id: locationId,
        metric,
        target_value: Number(target),
        period_type: period,
        starts_on: g?.starts_on ?? win.startsOn,
        ends_on: g?.ends_on ?? win.endsOn,
        notes: notes.trim() || null,
        set_by: app.userId,
      });
      onSaved();
    } catch (e) {
      toastDbError(e, { action: "save goal" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle className="text-[15px]">
            {g ? "Edit goal" : "Set goal"} · {subject.name}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-[12px]">Metric</Label>
            <Select value={metric} onValueChange={(v) => setMetric(v as GoalMetric)}>
              <SelectTrigger className="h-8 text-[13px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {GOAL_METRIC_LIST.map((m) => (
                  <SelectItem key={m.key} value={m.key}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              {GOAL_METRICS[metric].direction === "lower"
                ? "Lower is better — attainment is target ÷ actual."
                : "Higher is better — attainment is actual ÷ target."}
            </p>
          </div>

          <div className="space-y-1">
            <Label className="text-[12px]">Target for {win.label}</Label>
            <NumberInput
              value={target}
              onValueChange={(_, clean) => setTarget(clean)}
              decimals={2}
              className="h-8 text-[13px]"
              placeholder="e.g. 12"
            />
          </div>

          <LocationPicker
            value={locationId}
            onChange={setLocationId}
            label="Owning location"
            className="space-y-1"
          />

          <div className="space-y-1">
            <Label className="text-[12px]">Notes (optional)</Label>
            <Input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="h-8 text-[13px]"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={!valid || saving || app.writesDisabled} onClick={submit}>
            {saving ? "Saving…" : g ? "Save goal" : "Set goal"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Annual goal, broken into twelve months.
 *
 * The manager sets one number for the year; the system splits it into monthly
 * targets that are then editable one at a time. Editing the annual figure does
 * not silently flatten a hand-tuned month — redistribution is an explicit tick.
 */
function AnnualGoalDialog({
  subject,
  onClose,
  onSaved,
}: {
  subject: { userId: string; name: string };
  onClose: () => void;
  onSaved: () => void;
}) {
  const app = useAppContext();
  const year = new Date().getFullYear();
  const [metric, setMetric] = useState<GoalMetric>("meetings_held");
  const [target, setTarget] = useState("");
  const [locationId, setLocationId] = useState("");
  const [why, setWhy] = useState("");
  const [redistribute, setRedistribute] = useState(true);
  const [parent, setParent] = useState<Goal | null>(null);
  const [months, setMonths] = useState<Goal[]>([]);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    fetchGoals({ period: "year", userId: subject.userId, includeInactive: true })
      .then(async (rows) => {
        const hit =
          rows.find((g) => g.metric === metric && g.starts_on === `${year}-01-01`) ?? null;
        const kids = hit ? await fetchMonthlyChildren(hit.id) : [];
        if (cancelled) return;
        setParent(hit);
        setMonths(kids);
        setTarget(hit ? String(Number(hit.target_value)) : "");
        setLocationId(hit?.location_id ?? "");
        setWhy(hit?.why ?? "");
        setRedistribute(!hit);
      })
      .catch((e) => toastDbError(e, { action: "load annual goal" }))
      .finally(() => !cancelled && setBusy(false));
    return () => {
      cancelled = true;
    };
  }, [subject.userId, metric, year]);

  const preview = useMemo(
    () => splitAnnual(Number(target) || 0, GOAL_METRICS[metric].unit),
    [target, metric],
  );
  const monthLabels = useMemo(() => monthsOfYear(year), [year]);
  const valid = Number(target) > 0 && !!locationId;

  const submit = async () => {
    if (!valid) return;
    setSaving(true);
    try {
      await saveAnnualGoal({
        parentId: parent?.id,
        subject_user_id: subject.userId,
        location_id: locationId,
        metric,
        annual_target: Number(target),
        year,
        why,
        set_by: app.userId,
        redistribute,
      });
      onSaved();
    } catch (e) {
      toastDbError(e, { action: "save annual goal" });
    } finally {
      setSaving(false);
    }
  };

  const editMonth = async (g: Goal, value: string) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) {
      toast.error("A monthly target must be greater than zero.");
      return;
    }
    setMonths((prev) => prev.map((m) => (m.id === g.id ? { ...m, target_value: n } : m)));
    try {
      await setMonthlyTarget(g.id, n);
    } catch (e) {
      toastDbError(e, { action: "save monthly target" });
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="text-[15px]">
            Annual goal {year} · {subject.name}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-[12px]">Metric</Label>
            <Select value={metric} onValueChange={(v) => setMetric(v as GoalMetric)}>
              <SelectTrigger className="h-8 text-[13px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {GOAL_METRIC_LIST.map((m) => (
                  <SelectItem key={m.key} value={m.key}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <Label className="text-[12px]">Annual target</Label>
            <NumberInput
              value={target}
              onValueChange={(_, clean) => setTarget(clean)}
              decimals={2}
              className="h-8 text-[13px]"
              placeholder="e.g. 144"
            />
            <p className="text-[11px] text-muted-foreground">
              Breaks into twelve monthly targets automatically.
            </p>
          </div>

          <LocationPicker
            value={locationId}
            onChange={setLocationId}
            label="Owning location"
            className="space-y-1"
          />

          <div className="space-y-1">
            <Label className="text-[12px]">Why (the rep can edit this)</Label>
            <Input
              value={why}
              onChange={(e) => setWhy(e.target.value)}
              className="h-8 text-[13px]"
              placeholder="What they are working toward"
            />
          </div>

          <label className="flex items-center gap-2 text-[12px]">
            <input
              type="checkbox"
              checked={redistribute}
              onChange={(e) => setRedistribute(e.target.checked)}
            />
            Rewrite every monthly target from the annual figure
          </label>

          <div>
            <Label className="text-[12px]">Monthly targets</Label>
            {busy ? (
              <div className="py-2 text-[12px] text-muted-foreground">Loading…</div>
            ) : months.length > 0 && !redistribute ? (
              <div className="mt-1 grid grid-cols-4 gap-1.5">
                {months.map((g, i) => (
                  <div key={g.id}>
                    <div className="text-[10px] uppercase text-muted-foreground">
                      {monthLabels[i]?.label}
                    </div>
                    <NumberInput
                      defaultValue={Math.round(Number(g.target_value) * 100) / 100}
                      onCommit={(n) => editMonth(g, n == null ? "" : String(n))}
                      className="h-7 text-[12px]"
                      decimals={2}
                    />
                  </div>
                ))}
              </div>
            ) : (
              <div className="mt-1 grid grid-cols-6 gap-1 text-center">
                {preview.map((v: number, i: number) => (
                  <div key={i} className="rounded border px-1 py-0.5">
                    <div className="text-[9px] uppercase text-muted-foreground">
                      {monthLabels[i]?.label}
                    </div>
                    <div className="font-mono text-[11px] tabular-nums">
                      {GOAL_METRICS[metric].format(v)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={!valid || saving || app.writesDisabled}>
            {saving ? "Saving…" : parent ? "Update annual goal" : "Set annual goal"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
