import { supabase } from "@/integrations/supabase/client";
import { fetchStandings, type Standing } from "@/lib/leaderboard";
import { fetchGoals, goalWindow, type Goal, type GoalMetric } from "@/lib/goals";
import { actionValue, keysNeedingCounts, type ActionCounts } from "@/lib/action-catalogue";
import { weightsFor, type Weight as ScorecardWeight } from "@/lib/scorecard";
import { DEFAULT_CHALLENGE_METRIC } from "@/lib/leaderboard-challenge";
import type { AppRole } from "@/lib/roles";
import { localDayKey } from "@/lib/pipeline-rules";
import {
  fetchCompanyClosures,
  isWorkingDay,
  OFFICE_TIME_ZONE,
  shiftDateKey,
  todayKey,
  type DateKey,
  type WorkingDayOptions,
} from "@/lib/working-days";

/**
 * Leaderboard board data.
 *
 * Points are not hardcoded: they are the scorecard weights the Sales Head
 * already maintains (`scorecard_weights`), applied to the same standings row
 * the rest of the app ranks on. Streaks come from consecutive working days of
 * real activity (see `streakLength`), achievements from an admin-defined
 * badge set, goals from the real goals tables and wins from real jobs. Money
 * follows the money rule — `money_visible` is decided in the database, never
 * here.
 */

export type Weight = {
  id?: string;
  /** NULL is the company default; a row with an office overrides it there. */
  location_id: string | null;
  component: string;
  role_group: string;
  weight: number;
  target: number;
  direction: string;
  enabled: boolean;
};

export type Achievement = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  icon: string;
  color: string;
  metric: string;
  threshold: number;
  sort_order: number;
  active: boolean;
};

export type Challenge = {
  id: string;
  /** NULL is company-wide; an office's challenge scores that office alone. */
  location_id: string | null;
  name: string;
  description: string | null;
  /** An action-catalogue key; scored by src/lib/leaderboard-challenge.ts. */
  metric: string;
  target: number;
  starts_at: string;
  ends_at: string;
  bonus_text: string | null;
  active: boolean;
};

export type Win = {
  id: string;
  job_number: string;
  rep: string;
  value: number | null;
  loss_type: string | null;
  address: string | null;
  locality: string | null;
  region: string | null;
  at: string;
};

export type BoardRow = {
  user_id: string;
  name: string;
  role: string;
  group: "chase" | "sales";
  points: number;
  rank: number;
  rank_change: number | null;
  fire_leads_claimed: number;
  inspections_booked: number;
  contracts_signed: number;
  revenue: number | null;
  avg_response_minutes: number | null;
  close_rate: number | null;
  streak: number;
  achievements: Achievement[];
  jobs_won: number;
  money_visible: boolean;
  /** Primary sales columns. */
  jobs_signed_insurance: number;
  jobs_signed_cash: number;
  jobs_signed_total: number;
  calls_made: number;
  stage_advances: number;
  meetings_held: number;
};

const ROLE_LABEL: Partial<Record<AppRole, string>> = {
  field_chaser: "Fire Chaser",
  sales_person: "Sales Rep",
  outside_sales_rep: "Sales Rep",
  cold_caller: "Cold Caller",
  sales_head: "Sales Head",
  location_manager: "Manager",
};

export function roleLabelOf(roles: AppRole[]): string {
  for (const r of roles) if (ROLE_LABEL[r]) return ROLE_LABEL[r]!;
  return roles[0] ? roles[0].replace(/_/g, " ") : "Team member";
}

/**
 * Value of a scorecard component, in the units the weight targets use.
 *
 * This used to be a `switch` over the fixed standings columns, which meant a
 * component was only real if someone had added a `case` for it. It is now the
 * action catalogue (src/lib/action-catalogue.ts): the standings row still
 * answers for every column it carries — so every seeded component produces
 * exactly the number it did before, which leaderboard-board.test.ts asserts —
 * and anything else comes from `scorecard_action_counts` via `counts`. An
 * unknown key is null and scores nothing, as it always did.
 */
function componentValue(
  s: Standing,
  component: string,
  counts?: ActionCounts | null,
): number | null {
  return actionValue(component, s, counts);
}

export function groupOf(roles: AppRole[]): "chase" | "sales" {
  return roles.includes("field_chaser") || roles.includes("field") || roles.includes("crew")
    ? "chase"
    : "sales";
}

/**
 * Points = Σ weight × attainment, using the Sales Head's own weights. A rep who
 * exactly hits every target scores 100 × 25 = 2,500 points, so the board reads
 * like a score rather than a percentage.
 *
 * Which weights apply is `weightsFor()` in src/lib/scorecard.ts — the office
 * row overrides the company row component by component — judged for the
 * rep's own office, so an office that has tuned its scorecard sees its reps
 * scored by it. Before the admin screen existed there were no office rows and
 * this is exactly the old "enabled rows for the group" filter.
 *
 * `counts` is the rep's row from `scorecard_action_counts`, for components the
 * standings row does not carry. Absent (the migration not yet applied, or the
 * RPC not asked), those components simply contribute nothing — the fallback
 * is the old behaviour, not a wrong number.
 */
export function pointsFor(
  s: Standing,
  weights: Weight[],
  counts?: ActionCounts | null,
  locationId?: string | null,
): number {
  const group = groupOf(s.roles);
  const office = locationId === undefined ? (s.location_ids?.[0] ?? null) : locationId;
  const rows = weightsFor(weights as ScorecardWeight[], group, office);
  let total = 0;
  for (const w of rows) {
    const v = componentValue(s, w.component, counts);
    if (v == null || !Number.isFinite(v)) continue;
    const target = Number(w.target) || 1;
    const ratio = w.direction === "lower" ? target / Math.max(v, 0.0001) : v / target;
    total += Number(w.weight) * Math.min(Math.max(ratio, 0), 3);
  }
  return Math.round(total * 25);
}

/** The catalogue keys on the board's weights that only the RPC can answer. */
export function countKeysFor(weights: Weight[]): string[] {
  return keysNeedingCounts(weights.filter((w) => w.enabled).map((w) => w.component));
}

/** Per user, the counts row — the shape `buildRows` and `pointsFor` take. */
export type ActionCountsByUser = Record<string, ActionCounts>;

/**
 * Actuals for catalogue keys the standings row does not carry, from
 * `scorecard_action_counts` (migration 20260916140000). The client sends
 * keys only; the mapping from key to query lives in SQL.
 *
 * Returns null — not an error — when the function does not exist yet, so a
 * build that ships before the migration runs keeps scoring on the standings
 * columns alone. PostgREST reports a missing function as PGRST202; Postgres
 * itself as 42883.
 */
export async function fetchActionCounts(
  from: Date,
  to: Date,
  keys: string[],
  locationIds?: string[] | null,
): Promise<ActionCountsByUser | null> {
  if (keys.length === 0) return {};
  // Not in the generated types until the migration is applied and the types
  // regenerated; the `as never` is the same escape hatch calendar-recurring-store uses.
  const { data, error } = await supabase.rpc(
    "scorecard_action_counts" as never,
    {
      _from: from.toISOString(),
      _to: to.toISOString(),
      _keys: keys,
      _location_ids: locationIds && locationIds.length ? locationIds : null,
    } as never,
  );
  if (error) {
    if (isMissingRpc(error)) return null;
    throw error;
  }
  const out: ActionCountsByUser = {};
  for (const row of (data ?? []) as { user_id: string; key: string; value: number | null }[]) {
    (out[row.user_id] ??= {})[row.key] = row.value == null ? null : Number(row.value);
  }
  return out;
}

function isMissingRpc(error: { code?: string; message?: string }): boolean {
  if (error.code === "PGRST202" || error.code === "42883") return true;
  const m = (error.message ?? "").toLowerCase();
  return m.includes("could not find the function") || m.includes("does not exist");
}

export async function fetchWeights(): Promise<Weight[]> {
  const { data, error } = await supabase
    .from("scorecard_weights")
    .select("id,location_id,component,role_group,weight,target,direction,enabled");
  if (error) throw error;
  return (data ?? []).map((w) => ({
    ...w,
    weight: Number(w.weight),
    target: Number(w.target),
  })) as Weight[];
}

export async function fetchAchievements(): Promise<Achievement[]> {
  const { data, error } = await supabase
    .from("leaderboard_achievements")
    .select("*")
    .order("sort_order");
  if (error) throw error;
  return (data ?? []) as Achievement[];
}

export async function fetchChallenge(): Promise<Challenge | null> {
  const { data, error } = await supabase
    .from("leaderboard_challenges")
    .select("*")
    .eq("active", true)
    .order("ends_at", { ascending: true })
    .limit(1);
  if (error) throw error;
  return ((data ?? [])[0] as Challenge) ?? null;
}

export async function saveChallenge(input: Partial<Challenge> & { name: string }): Promise<void> {
  const row = {
    name: input.name,
    description: input.description ?? null,
    metric: input.metric ?? DEFAULT_CHALLENGE_METRIC,
    target: input.target ?? 25,
    starts_at: input.starts_at ?? new Date().toISOString(),
    ends_at: input.ends_at ?? new Date(Date.now() + 7 * 86400000).toISOString(),
    bonus_text: input.bonus_text ?? null,
    active: input.active ?? true,
  };
  const { error } = input.id
    ? await supabase.from("leaderboard_challenges").update(row).eq("id", input.id)
    : await supabase.from("leaderboard_challenges").insert(row);
  if (error) throw error;
}

export async function saveAchievement(input: Partial<Achievement> & { key: string; name: string }) {
  const row = {
    key: input.key,
    name: input.name,
    description: input.description ?? null,
    icon: input.icon ?? "award",
    color: input.color ?? "var(--primary)",
    metric: input.metric ?? "contracts_signed",
    threshold: input.threshold ?? 1,
    sort_order: input.sort_order ?? 0,
    active: input.active ?? true,
  };
  const { error } = input.id
    ? await supabase.from("leaderboard_achievements").update(row).eq("id", input.id)
    : await supabase.from("leaderboard_achievements").insert(row);
  if (error) throw error;
}

export async function deleteAchievement(id: string) {
  const { error } = await supabase.from("leaderboard_achievements").delete().eq("id", id);
  if (error) throw error;
}

/* ------------------------------------------------------------- streaks */

/**
 * How far back a streak is scored, in calendar days. About 60 working days
 * once weekends and holidays come out, and the cap on what the column can
 * show — a longer streak reads as the cap. The old window was 60 calendar
 * days; with non-working days no longer counting, that was only ~40.
 */
export const STREAK_LOOKBACK_DAYS = 90;

/** Rep → the office-calendar days on which they logged at least one touchpoint. */
export type ActivityDays = Record<string, Set<DateKey>>;

export type StreakOptions = WorkingDayOptions & {
  /** "Today", as an office-calendar day key. Defaults to today in New York. */
  today?: DateKey;
};

/**
 * The streak: consecutive WORKING days, walking back from today, on which the
 * rep logged at least one touchpoint.
 *
 * Mark: "it needs to exclude weekends and jewsih holidays" — "as well as
 * federal holidays". So the walk goes back over the office calendar
 * (`isWorkingDay`), and a day the office is closed is skipped: it is neither
 * counted nor a break. A rep who logs Friday and Monday has an unbroken
 * streak of two across the weekend; a rep who logs the day before Rosh
 * Hashanah and the day after keeps it.
 *
 * The rules, in the order the walk applies them:
 *
 *   - A working day with a touchpoint counts one.
 *   - Today, if it is a working day with nothing logged yet, is skipped once
 *     ("grace"): the streak should not read as zero at 9am because the rep has
 *     not made their first call. That is the same grace the old code gave
 *     "yesterday". Only today gets it.
 *   - A non-working day with a touchpoint ALSO counts one. A rep who worked a
 *     Saturday should not have it thrown away; and since a non-working day
 *     with nothing logged never breaks the streak, this can only ever help.
 *   - A non-working day with nothing logged is skipped.
 *   - Any other working day with nothing logged ends the streak.
 */
export function streakLength(logged: ReadonlySet<DateKey>, opts: StreakOptions = {}): number {
  const today = opts.today ?? todayKey();
  let n = 0;
  for (let i = 0; i < STREAK_LOOKBACK_DAYS; i += 1) {
    const day = shiftDateKey(today, -i);
    if (logged.has(day)) {
      n += 1;
      continue;
    }
    if (!isWorkingDay(day, opts)) continue;
    if (i === 0) continue;
    break;
  }
  return n;
}

export function computeStreaks(
  days: ActivityDays,
  opts: StreakOptions = {},
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [user, set] of Object.entries(days)) out[user] = streakLength(set, opts);
  return out;
}

const RAW_PAGE = 1000;

/**
 * Which office-calendar days each rep logged on, since `sinceIso`.
 *
 * First choice is the `touchpoint_activity_days` RPC (migration
 * `20260916120100_touchpoint_activity_days.sql`): one round trip, grouped and
 * bucketed by New York day in the database, and never more rows than reps ×
 * days. Until that migration is applied the RPC does not exist, so the
 * fallback pages the raw rows instead of the old single `.limit(5000)` — which
 * silently dropped the oldest rows once the floor logged more than that in the
 * window, and so quietly shortened everyone's streak. The page size is the
 * PostgREST default max-rows, so a server cap cannot end the loop early.
 *
 * Both paths bucket by `America/New_York`, the same `localDayKey` the pipeline
 * rules use: a touchpoint at 9pm in Brooklyn belongs to that evening's date,
 * not to tomorrow's UTC date.
 */
export async function fetchActivityDays(sinceIso: string): Promise<ActivityDays> {
  const days: ActivityDays = {};
  const add = (user: string | null, key: string) => {
    if (user) (days[user] ??= new Set()).add(key);
  };

  const rpc = await (
    supabase.rpc as unknown as (
      fn: string,
      args: Record<string, unknown>,
    ) => PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>
  )("touchpoint_activity_days", { _since: sinceIso, _time_zone: OFFICE_TIME_ZONE });
  if (!rpc.error) {
    for (const row of (rpc.data ?? []) as { created_by: string | null; day: string }[]) {
      add(row.created_by, String(row.day).slice(0, 10));
    }
    return days;
  }
  const missing =
    rpc.error.code === "PGRST202" ||
    rpc.error.code === "42883" ||
    /could not find the function|does not exist/i.test(rpc.error.message ?? "");
  if (!missing) throw rpc.error;

  for (let page = 0; page < 100; page += 1) {
    const from = page * RAW_PAGE;
    const { data, error } = await supabase
      .from("touchpoints")
      .select("created_by,occurred_at")
      .gte("occurred_at", sinceIso)
      .order("occurred_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + RAW_PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as { created_by: string | null; occurred_at: string }[];
    for (const row of rows) add(row.created_by, localDayKey(row.occurred_at, OFFICE_TIME_ZONE));
    if (rows.length < RAW_PAGE) break;
  }
  return days;
}

/** Rep → current streak in working days. See `streakLength` for the rules. */
export async function fetchStreaks(): Promise<Record<string, number>> {
  const today = todayKey();
  // One day of slack so the window's first New York day is whole whatever the
  // UTC offset; the walk is bounded by STREAK_LOOKBACK_DAYS regardless.
  const sinceIso = `${shiftDateKey(today, -(STREAK_LOOKBACK_DAYS + 1))}T00:00:00Z`;
  const [closures, days] = await Promise.all([fetchCompanyClosures(), fetchActivityDays(sinceIso)]);
  return computeStreaks(days, { today, closures });
}

/**
 * Signed jobs, newest first — the Recent Wins feed.
 *
 * Takes the same office scope every other panel on the Leaderboard takes. It
 * used to take none, so a board scoped to one office — headline reading "JOBS
 * SIGNED 0 · SIGNED REVENUE $0", ranked "3 ranked · nc · nc" — still listed
 * wins in Lakewood NJ and Los Angeles CA underneath. One screen, two answers
 * about the same period, and no way for a reader to tell which to believe.
 */
export async function fetchWins(limit = 6, locationIds?: string[] | null): Promise<Win[]> {
  let q = supabase
    .from("jobs")
    .select(
      "id,job_number,loss_type,address,locality,region,agreed_price,estimated_amount,billed_amount,created_at,created_by,location_id,profiles:created_by(full_name)",
    )
    .order("created_at", { ascending: false })
    .limit(limit);
  if (locationIds && locationIds.length) q = q.in("location_id", locationIds);
  const { data, error } = await q;
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map((j) => ({
    id: j.id as string,
    job_number: (j.job_number as string) ?? "",
    rep: ((j.profiles as { full_name?: string } | null)?.full_name ?? "A rep") as string,
    value: Number(j.agreed_price ?? j.billed_amount ?? j.estimated_amount ?? 0) || null,
    loss_type: (j.loss_type as string) ?? null,
    address: (j.address as string) ?? null,
    locality: (j.locality as string) ?? null,
    region: (j.region as string) ?? null,
    at: j.created_at as string,
  }));
}

export type TeamGoalLine = {
  metric: GoalMetric;
  label: string;
  target: number;
  actual: number;
  ratio: number;
  money: boolean;
};

const GOAL_ACTUAL: Partial<Record<GoalMetric, (s: Standing) => number | null>> = {
  billed_value: (s) => s.billed_value,
  collected_value: (s) => s.collected_value,
  jobs_won: (s) => s.jobs_won,
  contracts_signed: (s) => s.contracts_signed,
  meetings_held: (s) => s.meetings_held,
  touchpoints: (s) => s.touchpoints,
  accounts_advanced: (s) => s.accounts_advanced,
  new_accounts: (s) => s.new_accounts,
  cold_calls: (s) => s.cold_calls ?? null,
  cold_emails: (s) => s.cold_emails ?? null,
  new_deals_worked: (s) => s.new_deals_worked ?? null,
  cold_leads_converted: (s) => s.cold_leads_converted ?? null,
  active_client_reach_outs: (s) => s.active_client_reach_outs ?? null,
  fires_chased: (s) => s.fires_chased ?? null,
};

const GOAL_LABEL: Partial<Record<GoalMetric, string>> = {
  billed_value: "Revenue Goal",
  collected_value: "Collected Goal",
  jobs_won: "Jobs Goal",
  contracts_signed: "Contracts Goal",
  meetings_held: "Meetings Goal",
  touchpoints: "Touchpoints Goal",
  cold_calls: "Cold Calls Goal",
  cold_emails: "Cold Emails Goal",
  new_deals_worked: "New Deals Goal",
  cold_leads_converted: "Cold Leads Converted Goal",
  active_client_reach_outs: "Client Reach-Out Goal",
  fires_chased: "Fires Chased Goal",
};

/** Team vs Goal: this month's targets, summed across everyone on the board. */
export async function fetchTeamGoals(): Promise<Goal[]> {
  return fetchGoals({ period: "month", window: goalWindow("month") });
}

export function teamGoalLines(goals: Goal[], standings: Standing[]): TeamGoalLine[] {
  const byMetric = new Map<GoalMetric, number>();
  for (const g of goals) {
    if (!GOAL_ACTUAL[g.metric]) continue;
    byMetric.set(g.metric, (byMetric.get(g.metric) ?? 0) + Number(g.target_value));
  }
  const lines: TeamGoalLine[] = [];
  for (const [metric, target] of byMetric) {
    const get = GOAL_ACTUAL[metric]!;
    const actual = standings.reduce((sum, s) => sum + (get(s) ?? 0), 0);
    lines.push({
      metric,
      label: GOAL_LABEL[metric] ?? metric.replace(/_/g, " "),
      target,
      actual,
      ratio: target > 0 ? actual / target : 0,
      money: metric === "billed_value" || metric === "collected_value",
    });
  }
  return lines.sort((a, b) => Number(b.money) - Number(a.money));
}

/**
 * Chasers are excluded from the leaderboard entirely, per the client spec:
 * their work is measured on their own performance screen, not ranked against
 * sales. They are filtered here so no board, tab or previous-rank comparison
 * can surface them.
 */
export function isLeaderboardEligible(roles: AppRole[]): boolean {
  return groupOf(roles) === "sales";
}

/** Everything the board renders per person, ranked and rank-compared. */
export function buildRows(
  current: Standing[],
  previous: Standing[],
  weights: Weight[],
  achievements: Achievement[],
  streaks: Record<string, number>,
  counts?: ActionCountsByUser | null,
  previousCounts?: ActionCountsByUser | null,
): BoardRow[] {
  const prevPoints = previous
    .filter((s) => isLeaderboardEligible(s.roles))
    .map((s) => ({
      user_id: s.user_id,
      points: pointsFor(s, weights, previousCounts?.[s.user_id]),
    }))
    .sort((a, b) => b.points - a.points);
  const prevRank = new Map(prevPoints.map((p, i) => [p.user_id, i + 1]));

  const rows = current
    .filter((s) => isLeaderboardEligible(s.roles))
    .map((s) => {
      const points = pointsFor(s, weights, counts?.[s.user_id]);
      const dispatched = s.incidents_dispatched || 0;
      const earned = achievements.filter(
        (a) =>
          a.active &&
          (componentValue(s, a.metric, counts?.[s.user_id]) ?? 0) >= Number(a.threshold),
      );
      return {
        user_id: s.user_id,
        name: s.full_name?.trim() || "Unnamed user",
        role: roleLabelOf(s.roles),
        group: groupOf(s.roles),
        points,
        rank: 0,
        rank_change: null as number | null,
        fire_leads_claimed: s.incidents_accepted,
        inspections_booked: s.meetings_held,
        contracts_signed: s.contracts_signed,
        revenue: s.money_visible ? (s.billed_value ?? 0) : null,
        avg_response_minutes: s.median_tta_minutes,
        close_rate:
          dispatched > 0
            ? s.contracts_signed / dispatched
            : s.accounts_owned > 0
              ? s.jobs_won / s.accounts_owned
              : null,
        streak: streaks[s.user_id] ?? 0,
        achievements: earned,
        jobs_won: s.jobs_won,
        money_visible: s.money_visible,
        jobs_signed_insurance: s.jobs_signed_insurance ?? 0,
        jobs_signed_cash: s.jobs_signed_cash ?? 0,
        jobs_signed_total: s.jobs_signed_total ?? s.jobs_won,
        calls_made: s.calls_made ?? 0,
        stage_advances: s.stage_advances ?? 0,
        meetings_held: s.meetings_held,
      } satisfies BoardRow;
    })
    .sort((a, b) => b.points - a.points);

  return rows.map((r, i) => {
    const before = prevRank.get(r.user_id);
    return { ...r, rank: i + 1, rank_change: before == null ? null : before - (i + 1) };
  });
}

export const fmtMoney = (v: number | null) =>
  v == null ? "—" : `$${Math.round(v).toLocaleString("en-US")}`;

export const fmtCompact = (v: number | null) => {
  if (v == null) return "—";
  if (Math.abs(v) >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (Math.abs(v) >= 1_000) return `$${Math.round(v / 1000)}K`;
  return `$${Math.round(v)}`;
};

export const fmtMinutes = (v: number | null) => (v == null ? "—" : `${Math.round(v)}m`);

export function countdown(to: string): string {
  const ms = new Date(to).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "Ended";
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return `Ends in ${d}d ${h}h ${m}m`;
}

export { type Standing, fetchStandings };
