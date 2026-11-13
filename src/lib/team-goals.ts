import {
  ACTIVITY_METRICS,
  GOAL_METRICS,
  elapsedShare,
  fetchGoals,
  goalWindow,
  saveAnnualGoal,
  saveGoal,
  type ActivityMetric,
  type Goal,
  type GoalMetric,
  type GoalPeriod,
} from "@/lib/goals";
import { fetchStandings, motionOf, type Standing } from "@/lib/leaderboard";
import { notifyUsers } from "@/lib/notifications.functions";

/**
 * Team Goals — the manager-facing counterpart to My Goals.
 *
 * It reads and writes the *same* `goals` rows that My Goals and the dashboard
 * goal card read, so the three screens can never disagree. Nothing here keeps
 * its own copy of a target or an actual.
 *
 * Status is never hardcoded: it is pace — progress against the share of the
 * period already spent. Being at 50% on the last day of the quarter is not the
 * same as being at 50% on day one, and the chip has to say so.
 */

export const TEAM_METRICS = {
  revenue: "billed_value",
  jobs: "jobs_won",
  conversion: "conversion_rate",
} as const satisfies Record<string, GoalMetric>;

/**
 * The six activity goals Mark added to this panel on 16 Sep 2026 ("add fires
 * chased, cold leak converted, cold calls, new deals worked on, active client
 * reach out ..., cold email outreach"). They are ordinary catalogue metrics —
 * see GOAL_METRICS in src/lib/goals.ts for what each one counts — listed here
 * in the order the panel shows them: the prospecting ones, then the client
 * one, then fires.
 */
export const TEAM_ACTIVITY_METRICS: readonly ActivityMetric[] = ACTIVITY_METRICS;

export type TeamStatus = "ahead" | "on_track" | "needs_attention" | "no_goals";

export type Figure = { actual: number | null; target: number | null; ratio: number | null };

export type TeamRow = {
  userId: string;
  name: string;
  locationIds: string[];
  moneyVisible: boolean;
  revenue: Figure;
  jobs: Figure;
  conversion: Figure;
  /** The six activity figures, keyed by metric. Actual is null until measured. */
  activity: Record<ActivityMetric, Figure>;
  /** Mean of the metrics that actually have a target. Null = no goals set. */
  progress: number | null;
  status: TeamStatus;
  /** The goal rows behind this person, keyed by metric — so Edit can update. */
  goals: Partial<Record<GoalMetric, Goal>>;
};

export type TeamSummary = {
  revenue: Figure;
  jobs: Figure;
  onTrack: number;
  teamSize: number;
};

export type TeamGoalsData = {
  rows: TeamRow[];
  summary: TeamSummary;
  elapsed: number;
};

const ratioOf = (actual: number | null, target: number | null) =>
  actual == null || target == null || target <= 0 ? null : actual / target;

/** Conversion is meetings held ÷ accounts advanced — the same one My Goals shows. */
export function conversionOf(s: Standing): number | null {
  if (!s.accounts_advanced) return null;
  return s.meetings_held / s.accounts_advanced;
}

/**
 * Pace, not raw attainment. A rep 60% of the way through a quarter needs to be
 * near 60% to be "on track"; comfortably past it is "ahead"; well short of it
 * needs attention. The early days of a period are deliberately forgiving.
 */
export function paceStatus(progress: number | null, elapsed: number): TeamStatus {
  if (progress == null) return "no_goals";
  if (progress >= 1) return "ahead";
  if (elapsed < 0.1) return "on_track";
  if (progress >= elapsed + 0.08) return "ahead";
  if (progress >= elapsed - 0.08) return "on_track";
  return "needs_attention";
}

export const STATUS_LABEL: Record<TeamStatus, string> = {
  ahead: "Ahead",
  on_track: "On Track",
  needs_attention: "Needs Attention",
  no_goals: "No goals",
};

/**
 * One read for the whole page. RLS already limits standings and goals to the
 * caller's locations, so a manager sees their own people and a director sees
 * everyone without the client asking for a different query.
 */
export async function fetchTeamGoals(
  period: GoalPeriod,
  locationIds: string[] | null,
): Promise<TeamGoalsData> {
  const win = goalWindow(period);
  const [standings, goals] = await Promise.all([
    fetchStandings(win.from, win.to, locationIds),
    fetchGoals({ period, window: win }),
  ]);

  const byUser = new Map<string, Partial<Record<GoalMetric, Goal>>>();
  for (const g of goals) {
    if (!g.subject_user_id) continue;
    const bag = byUser.get(g.subject_user_id) ?? {};
    bag[g.metric] = g;
    byUser.set(g.subject_user_id, bag);
  }

  const elapsed = elapsedShare(period);

  const rows: TeamRow[] = standings
    .filter((s) => motionOf(s.roles) === "relationship")
    .map((s) => {
      const bag = byUser.get(s.user_id) ?? {};
      const revenue: Figure = {
        actual: s.billed_value,
        target: bag.billed_value ? Number(bag.billed_value.target_value) : null,
        ratio: null,
      };
      revenue.ratio = ratioOf(revenue.actual, revenue.target);
      const jobs: Figure = {
        actual: s.jobs_won,
        target: bag.jobs_won ? Number(bag.jobs_won.target_value) : null,
        ratio: null,
      };
      jobs.ratio = ratioOf(jobs.actual, jobs.target);
      const convActual = conversionOf(s);
      const conversion: Figure = {
        actual: convActual,
        target: bag.conversion_rate ? Number(bag.conversion_rate.target_value) / 100 : null,
        ratio: null,
      };
      conversion.ratio = ratioOf(conversion.actual, conversion.target);

      // Actual comes off the standings row through the same ACTUAL map the
      // dashboard card and My Goals read, so a rep's cold calls are one
      // number everywhere. Absent column (migration not applied) = null.
      const activity = Object.fromEntries(
        TEAM_ACTIVITY_METRICS.map((metric) => {
          const f: Figure = {
            actual: s[metric] ?? null,
            target: bag[metric] ? Number(bag[metric].target_value) : null,
            ratio: null,
          };
          f.ratio = ratioOf(f.actual, f.target);
          return [metric, f];
        }),
      ) as Record<ActivityMetric, Figure>;

      const parts = [
        revenue.ratio,
        jobs.ratio,
        conversion.ratio,
        ...TEAM_ACTIVITY_METRICS.map((m) => activity[m].ratio),
      ].filter((r): r is number => r != null);
      const progress = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null;

      return {
        userId: s.user_id,
        name: s.full_name?.trim() || "Unnamed",
        locationIds: s.location_ids ?? [],
        moneyVisible: s.money_visible,
        revenue,
        jobs,
        conversion,
        activity,
        progress,
        status: paceStatus(progress, elapsed),
        goals: bag,
      };
    })
    .sort((a, b) => (b.progress ?? -1) - (a.progress ?? -1) || a.name.localeCompare(b.name));

  const sum = (pick: (r: TeamRow) => Figure) =>
    rows.reduce(
      (acc, r) => {
        const f = pick(r);
        if (f.actual != null) acc.actual = (acc.actual ?? 0) + f.actual;
        if (f.target != null) acc.target = (acc.target ?? 0) + f.target;
        return acc;
      },
      { actual: null, target: null, ratio: null } as Figure,
    );

  const revenue = sum((r) => r.revenue);
  revenue.ratio = ratioOf(revenue.actual, revenue.target);
  const jobs = sum((r) => r.jobs);
  jobs.ratio = ratioOf(jobs.actual, jobs.target);

  return {
    rows,
    summary: {
      revenue,
      jobs,
      onTrack: rows.filter((r) => r.status === "ahead" || r.status === "on_track").length,
      teamSize: rows.length,
    },
    elapsed,
  };
}

/* ------------------------------------------------------------------ */
/* Writing                                                             */
/* ------------------------------------------------------------------ */

export type TeamGoalInput = {
  userIds: string[];
  period: GoalPeriod;
  /** Dollars. Blank leaves the existing revenue target alone. */
  revenue: number | null;
  jobs: number | null;
  /** Whole percent, e.g. 38 for 38%. */
  conversion: number | null;
  /** Counts for the six activity goals. A missing or null entry leaves that target alone. */
  activity?: Partial<Record<ActivityMetric, number | null>>;
  /** End of the window. Defaults to the period end. */
  endsOn: string;
  startsOn: string;
  /** Location the goal is booked against, per rep. */
  locationFor: (userId: string) => string | null;
  setBy: string | null;
  existing: Map<string, Partial<Record<GoalMetric, Goal>>>;
};

/**
 * Save a target for one or many reps, then tell each of them. A goal nobody
 * knows about is not a goal.
 */
export async function saveTeamGoals(input: TeamGoalInput): Promise<void> {
  const entries: [GoalMetric, number | null][] = [
    [TEAM_METRICS.revenue, input.revenue],
    [TEAM_METRICS.jobs, input.jobs],
    [TEAM_METRICS.conversion, input.conversion],
    ...TEAM_ACTIVITY_METRICS.map((m): [GoalMetric, number | null] => [
      m,
      input.activity?.[m] ?? null,
    ]),
  ];

  for (const userId of input.userIds) {
    const locationId = input.locationFor(userId);
    if (!locationId) throw new Error("This person has no location, so a goal cannot be booked.");
    const bag = input.existing.get(userId) ?? {};

    for (const [metric, value] of entries) {
      if (value == null || Number.isNaN(value)) continue;

      if (input.period === "year") {
        // Annual targets keep their twelve monthly children in step.
        await saveAnnualGoal({
          parentId: bag[metric]?.id,
          subject_user_id: userId,
          location_id: locationId,
          metric,
          annual_target: value,
          year: Number(input.startsOn.slice(0, 4)),
          set_by: input.setBy,
          redistribute: true,
        });
        continue;
      }

      await saveGoal({
        id: bag[metric]?.id,
        subject_user_id: userId,
        subject_location_id: null,
        location_id: locationId,
        metric,
        target_value: value,
        period_type: input.period,
        starts_on: input.startsOn,
        ends_on: input.endsOn,
        set_by: input.setBy,
      });
    }
  }

  const set = entries
    .filter(([, v]) => v != null)
    .map(([m, v]) =>
      m === TEAM_METRICS.conversion
        ? `${GOAL_METRICS[m].label} ${v}%`
        : `${GOAL_METRICS[m].label} ${GOAL_METRICS[m].format(v as number)}`,
    )
    .join(" · ");

  await notifyUsers({
    data: {
      userIds: input.userIds,
      type: "goal_pace",
      title: "Your goals were updated",
      body: set ? `${set} — through ${input.endsOn}.` : null,
      href: "/my-goals",
      entityType: "goal",
      priority: "normal",
    },
  });
}

/** Reps the manager may set goals for, with the location each is booked to. */
export async function fetchGoalSubjects(
  locationIds: string[] | null,
): Promise<{ userId: string; name: string; locationId: string | null }[]> {
  const win = goalWindow("month");
  const standings = await fetchStandings(win.from, win.to, locationIds);
  return standings
    .filter((s) => motionOf(s.roles) === "relationship")
    .map((s) => ({
      userId: s.user_id,
      name: s.full_name?.trim() || "Unnamed",
      locationId: s.location_ids?.[0] ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Avatar initials — profiles carry no image, so two letters it is. */
export function initialsOf(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? "")
      .join("") || "?"
  );
}
