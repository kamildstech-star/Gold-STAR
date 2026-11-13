import { supabase } from "@/integrations/supabase/client";
import { countsTowardRep } from "@/lib/account-ownership";
import { fetchLabelMap } from "@/lib/labels";
import type { PersonMetrics } from "@/lib/scorecard";

/**
 * Goals and attainment.
 *
 * Attainment is actual ÷ target for the period, and nothing else. A person
 * with no goal set has *no attainment* — not zero. Ranking someone at 0%
 * because nobody gave them a target is an accusation the data does not
 * support, so `attainmentFor` returns null and every caller must say
 * "no active goals" instead of drawing a bar.
 */

export type GoalPeriod = "month" | "quarter" | "year";
export type GoalMetric =
  | "meetings_held"
  | "touchpoints"
  | "accounts_advanced"
  | "new_accounts"
  | "contracts_signed"
  | "jobs_won"
  | "billed_value"
  | "collected_value"
  | "median_tta_minutes"
  | "conversion_rate"
  | ActivityMetric;

/**
 * The six activity metrics Mark asked for on 16 Sep 2026, verbatim:
 *
 *   "add fires chased, cold leak converted, cold calls, new deals worked on,
 *    active client reach out (code it to understand this is acctive client
 *    messaging, emails, texts, calls, etc), cold email outreach"
 *
 * ("cold leak" is cold lead.) Every one of them is a count, settable per rep
 * in the Set Goals panel, and every actual is computed in the database by
 * `goal_activity_actuals` (20260916130100) and rides in on the leaderboard
 * standings row, the same road the existing actuals take. The exact rule for
 * each is written on its catalogue entry below and again beside the SQL.
 */
export const ACTIVITY_METRICS = [
  "cold_calls",
  "cold_emails",
  "new_deals_worked",
  "cold_leads_converted",
  "active_client_reach_outs",
  "fires_chased",
] as const;
export type ActivityMetric = (typeof ACTIVITY_METRICS)[number];

/** The six actuals, as `leaderboard_standings` returns them. */
export type ActivityActuals = Record<ActivityMetric, number | null>;

export type Motion = "relationship" | "chase";

export type Goal = {
  id: string;
  subject_user_id: string | null;
  subject_location_id: string | null;
  location_id: string;
  metric: GoalMetric;
  target_value: number;
  period_type: GoalPeriod;
  starts_on: string;
  ends_on: string;
  is_active: boolean;
  notes: string | null;
  set_by: string | null;
  /** The rep's own words about what this target is for. Shown on their dashboard. */
  why: string | null;
  /** Set on the twelve monthly targets broken out of an annual goal. */
  parent_goal_id: string | null;
};

/**
 * Extra actuals that `scorecard_metrics` does not carry. `activity` is the
 * rep's standings row (or the six fields off it); a caller that has not
 * fetched one leaves it out and the activity metrics read as unmeasured —
 * null, never zero — exactly as a missing goal does.
 */
export type GoalExtras = { newAccounts: number; activity?: Partial<ActivityActuals> | null };

export type MetricDef = {
  key: GoalMetric;
  label: string;
  /** Which sales motion the metric belongs to; "both" is available to either. */
  motion: Motion | "both";
  direction: "higher" | "lower";
  unit: "count" | "money" | "minutes" | "percent";
  actual: (m: PersonMetrics, extra: GoalExtras) => number | null;
  format: (v: number | null) => string;
};

const int = (v: number | null) =>
  v == null
    ? "—"
    : v.toLocaleString("en-US", {
        maximumFractionDigits: Number.isInteger(v) ? 0 : 2,
      });
const money = (v: number | null) => (v == null ? "—" : `$${Math.round(v).toLocaleString("en-US")}`);
const mins = (v: number | null) => (v == null ? "—" : `${Math.round(v)} min`);
const percent = (v: number | null) => (v == null ? "—" : `${Math.round(v)}%`);

/**
 * One activity entry. The rule text is the spec; the database function
 * `goal_activity_actuals` implements it and supabase/tests/goal-activity-actuals
 * proves it. Keep the three in step.
 */
const activity = (key: ActivityMetric, label: string, motion: Motion | "both"): MetricDef => ({
  key,
  label,
  motion,
  direction: "higher",
  unit: "count",
  actual: (_m, extra) => extra.activity?.[key] ?? null,
  format: int,
});

export const GOAL_METRICS: Record<GoalMetric, MetricDef> = {
  meetings_held: {
    key: "meetings_held",
    label: "Meetings held",
    motion: "relationship",
    direction: "higher",
    unit: "count",
    actual: (m) => m.meetings_held,
    format: int,
  },
  touchpoints: {
    key: "touchpoints",
    label: "Touchpoints logged",
    motion: "relationship",
    direction: "higher",
    unit: "count",
    actual: (m) => m.touchpoints,
    format: int,
  },
  accounts_advanced: {
    key: "accounts_advanced",
    label: "Accounts advanced",
    motion: "relationship",
    direction: "higher",
    unit: "count",
    actual: (m) => m.accounts_advanced,
    format: int,
  },
  new_accounts: {
    key: "new_accounts",
    label: "New accounts",
    motion: "relationship",
    direction: "higher",
    unit: "count",
    actual: (_m, extra) => extra.newAccounts,
    format: int,
  },
  contracts_signed: {
    key: "contracts_signed",
    label: "Contracts signed",
    motion: "both",
    direction: "higher",
    unit: "count",
    actual: (m) => m.contracts_signed,
    format: int,
  },
  jobs_won: {
    key: "jobs_won",
    label: "Jobs won",
    motion: "both",
    direction: "higher",
    unit: "count",
    actual: (m) => m.jobs_won,
    format: int,
  },
  billed_value: {
    key: "billed_value",
    label: "Billed value",
    motion: "relationship",
    direction: "higher",
    unit: "money",
    actual: (m) => m.billed_value,
    format: money,
  },
  collected_value: {
    key: "collected_value",
    label: "Collected value",
    motion: "relationship",
    direction: "higher",
    unit: "money",
    actual: (m) => m.collected_value,
    format: money,
  },
  conversion_rate: {
    key: "conversion_rate",
    label: "Conversion rate",
    motion: "relationship",
    direction: "higher",
    unit: "percent",
    /* Meetings held ÷ accounts advanced, expressed in whole percent. */
    actual: (m) => (m.accounts_advanced ? (m.meetings_held / m.accounts_advanced) * 100 : null),
    format: percent,
  },
  median_tta_minutes: {
    key: "median_tta_minutes",
    label: "Median time to arrival",
    motion: "chase",
    direction: "lower",
    unit: "minutes",
    actual: (m) => m.median_tta_minutes,
    format: mins,
  },

  /* ---- Mark's six, 16 Sep 2026. Rules in full; SQL in 20260916130100. ---- */

  /*
   * Cold calls — outbound calls to accounts that were NOT yet clients when the
   * call happened. Counts `touchpoints.type = 'call'` (any direction but
   * inbound) plus `contact_attempts.channel = 'call'` by the rep, exactly as
   * the leaderboard's `calls_made` already sums the two tables — a call logged
   * in both counts twice there, and so it does here, on purpose, so the two
   * screens agree. "Not yet a client" is judged at the moment of the call
   * (`account_client_since`), so January's cold calls stay cold when the
   * account signs in February. House accounts never count toward a rep.
   * Fire-lead attempts with no account attached are left out: there is no
   * account to say "not yet a client" about, and that is chase work.
   */
  cold_calls: activity("cold_calls", "Cold calls", "relationship"),
  /*
   * Cold email outreach — the same rule for email: `touchpoints.type =
   * 'email'` (which is where Outlook-synced mail lands, outbound only, under
   * the mailbox owner's user id) plus `contact_attempts.channel = 'email'`,
   * to accounts that were not yet clients at the time.
   */
  cold_emails: activity("cold_emails", "Cold email outreach", "relationship"),
  /*
   * New deals worked on — distinct prospect accounts the rep reached out to
   * for the FIRST time in the window: the rep's earliest outbound touch on the
   * account (either table) falls inside the window, and the account was not a
   * client at that moment. A prospect the rep was already working last month
   * is not a new deal this month. The alternative reading — every prospect
   * touched in the window, new or not — is the wider number a manager could
   * ask for later; "new" in Mark's words is why this one was chosen.
   */
  new_deals_worked: activity("new_deals_worked", "New deals worked on", "relationship"),
  /*
   * Cold leads converted — accounts that became an active client in the
   * window (a stage-history move into a won stage) having first been worked
   * through Active Outreach, the stage the pipeline enters "the moment the
   * rep logs their first attempt" (20260909120100).
   *
   * Said plainly: the data cannot tell a cold origin from a warm one. The
   * lead-source list (broker, web, phone, tradeshow, ...) has no cold value,
   * and a lead that called in is logged as an outbound touch like any other,
   * so it too can pass through Active Outreach. The passage is the closest
   * thing the system records to "the rep had to open the conversation", and
   * it is what this counts; a manager who wants the wider number — every
   * prospect activated in the window, however it arrived — is one predicate
   * away (drop the Active Outreach test in goal_activity_actuals).
   *
   * Credited to the account's assigned rep, not to whoever clicked Activate,
   * because a manager may do the click on the rep's behalf. House accounts
   * excluded.
   */
  cold_leads_converted: activity("cold_leads_converted", "Cold leads converted", "relationship"),
  /*
   * Active client reach-out — Mark: "code it to understand this is acctive
   * client messaging, emails, texts, calls, etc". Every outbound touch of any
   * type (call, email, text, in person, virtual, LinkedIn, mail, gift, other)
   * from `touchpoints`, plus every `contact_attempts` row, by the rep, to an
   * account that WAS an active client at that moment. "Active client" is the
   * board's own rule (`account_is_active_client`, mirroring `isActiveClient`
   * in src/lib/pipeline-reversion.ts), never a hand-written condition. A
   * touch to a prospect is never a client reach-out, and vice versa. House
   * accounts excluded.
   */
  active_client_reach_outs: activity(
    "active_client_reach_outs",
    "Active client reach-outs",
    "both",
  ),
  /*
   * Fires chased — incidents the rep accepted in the window
   * (`incidents.accepted_by = rep AND accepted_at` in window). The chase
   * cockpit's own words: "Their active chases — accepted, still awaiting an
   * outcome", so a chase starts at acceptance; arrival is a step inside it
   * ("Accept → on scene"), not the definition. This is the leaderboard's
   * `incidents_accepted` under the name Mark uses for it.
   */
  fires_chased: activity("fires_chased", "Fires chased", "both"),
};

export const GOAL_METRIC_LIST = Object.values(GOAL_METRICS);

export const GOAL_PERIODS: { key: GoalPeriod; label: string }[] = [
  { key: "month", label: "Month" },
  { key: "quarter", label: "Quarter" },
  { key: "year", label: "Year" },
];

/* ------------------------------------------------------------------ */
/* Period windows                                                      */
/* ------------------------------------------------------------------ */

export type GoalWindow = { from: Date; to: Date; startsOn: string; endsOn: string; label: string };

const dstr = (d: Date) => d.toISOString().slice(0, 10);

/** The calendar window a month / quarter / year goal is measured over. */
export function goalWindow(period: GoalPeriod, now = new Date()): GoalWindow {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  let from: Date;
  let end: Date;
  let label: string;
  if (period === "month") {
    from = new Date(Date.UTC(y, m, 1));
    end = new Date(Date.UTC(y, m + 1, 0));
    label = from.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  } else if (period === "quarter") {
    const q = Math.floor(m / 3);
    from = new Date(Date.UTC(y, q * 3, 1));
    end = new Date(Date.UTC(y, q * 3 + 3, 0));
    label = `Q${q + 1} ${y}`;
  } else {
    from = new Date(Date.UTC(y, 0, 1));
    end = new Date(Date.UTC(y, 12, 0));
    label = String(y);
  }
  const to = new Date(Math.min(end.getTime() + 86_399_000, Date.now()));
  return { from, to, startsOn: dstr(from), endsOn: dstr(end), label };
}

/** How far through the window we are — context for a part-period attainment. */
export function elapsedShare(period: GoalPeriod, now = new Date()): number {
  const w = goalWindow(period, now);
  const end = new Date(`${w.endsOn}T23:59:59Z`).getTime();
  const span = end - w.from.getTime();
  return span <= 0 ? 1 : Math.max(0, Math.min(1, (now.getTime() - w.from.getTime()) / span));
}

/* ------------------------------------------------------------------ */
/* Reads and writes                                                    */
/* ------------------------------------------------------------------ */

/** Active goals whose window overlaps the one given. RLS decides visibility. */
export async function fetchGoals(opts: {
  period?: GoalPeriod;
  window?: GoalWindow;
  userId?: string;
  includeInactive?: boolean;
}): Promise<Goal[]> {
  let q = supabase.from("goals").select("*");
  if (!opts.includeInactive) q = q.eq("is_active", true);
  if (opts.period) q = q.eq("period_type", opts.period);
  if (opts.window) q = q.lte("starts_on", opts.window.endsOn).gte("ends_on", opts.window.startsOn);
  if (opts.userId) q = q.eq("subject_user_id", opts.userId);
  const { data, error } = await q.order("starts_on", { ascending: false });
  if (error) throw error;
  return (data ?? []) as Goal[];
}

/**
 * Accounts opened in the window, per owning rep — the "new accounts" actual.
 *
 * House accounts are left out. Mark: "House accounts belong to the company
 * rather than a rep", and on what that covers: "TPA work that already does not
 * count toward any rep". A target is a promise about work the rep goes and
 * does; crediting them for a company relationship that was handed to them
 * inflates the number in the one direction nobody would notice, because the
 * rep it flatters is not going to query it.
 *
 * Only the label decides. An account with no rep on it is already skipped
 * below on `assigned_rep` alone — it is unclaimed, not the company's, and this
 * function must not be the place that quietly decides otherwise.
 */
export async function fetchNewAccounts(from: Date, to: Date): Promise<Record<string, number>> {
  const { data, error } = await supabase
    .from("accounts")
    .select("id, assigned_rep, created_at")
    .gte("created_at", from.toISOString())
    .lte("created_at", to.toISOString());
  if (error) throw error;
  const rows = (data ?? []) as { id: string; assigned_rep: string | null }[];
  const owned = rows.filter((r) => r.assigned_rep);
  // A label read that fails must not blank out everyone's attainment, so the
  // fallback is today's behaviour: count them all.
  const labelMap = await fetchLabelMap(
    "account",
    owned.map((r) => r.id),
  ).catch(() => ({}) as Record<string, { name: string }[]>);
  const out: Record<string, number> = {};
  for (const row of owned) {
    const labels = (labelMap[row.id] ?? []).map((l) => l.name);
    if (!countsTowardRep({ assigned_rep: row.assigned_rep, labels })) continue;
    out[row.assigned_rep!] = (out[row.assigned_rep!] ?? 0) + 1;
  }
  return out;
}

export type SaveGoalInput = {
  id?: string;
  subject_user_id: string | null;
  subject_location_id: string | null;
  location_id: string;
  metric: GoalMetric;
  target_value: number;
  period_type: GoalPeriod;
  starts_on: string;
  ends_on: string;
  notes?: string | null;
  set_by?: string | null;
};

export async function saveGoal(input: SaveGoalInput): Promise<void> {
  if (input.id) {
    const { id, ...rest } = input;
    const { error } = await supabase.from("goals").update(rest).eq("id", id);
    if (error) throw error;
    return;
  }
  const { error } = await supabase.from("goals").insert(input);
  if (error) throw error;
}

export async function setGoalActive(id: string, active: boolean): Promise<void> {
  const { error } = await supabase.from("goals").update({ is_active: active }).eq("id", id);
  if (error) throw error;
}

/* ------------------------------------------------------------------ */
/* Annual goals and their monthly break-out                            */
/* ------------------------------------------------------------------ */

/** The month windows of a calendar year, as `[startsOn, endsOn]` pairs. */
export function monthsOfYear(year: number): { startsOn: string; endsOn: string; label: string }[] {
  return Array.from({ length: 12 }, (_, i) => {
    const from = new Date(Date.UTC(year, i, 1));
    const end = new Date(Date.UTC(year, i + 1, 0));
    return {
      startsOn: dstr(from),
      endsOn: dstr(end),
      label: from.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }),
    };
  });
}

/**
 * An annual number split twelve ways. Whole units only — a target of 50
 * meetings becomes 5,4,4,4,4,4,4,4,4,4,4,5-ish, not 4.1666 a month, because a
 * rep cannot hold a sixth of a meeting. Money splits evenly to the dollar.
 */
export function splitAnnual(total: number, unit: MetricDef["unit"]): number[] {
  // Rates and thresholds describe the desired level in every period. Dividing
  // them would turn a 60% annual conversion goal into a meaningless 5% monthly
  // goal (and a 60-minute response target into five minutes).
  if (unit === "percent" || unit === "minutes") {
    return Array(12).fill(total);
  }
  if (unit === "money") {
    const per = Math.round((total / 12) * 100) / 100;
    const out = Array(12).fill(per);
    out[11] = Math.round((total - per * 11) * 100) / 100;
    return out;
  }
  // A legitimate annual count can be smaller than twelve (for example, five
  // jobs won). Zero-valued monthly rows violate the goals table constraint and
  // also make attainment undefined, so use a fractional monthly pace until an
  // annual target is large enough to distribute as whole work items.
  if (unit === "count" && total > 0 && total < 12) {
    return Array(12).fill(total / 12);
  }
  const base = Math.floor(total / 12);
  let rem = Math.round(total - base * 12);
  return Array.from({ length: 12 }, () => {
    const extra = rem > 0 ? 1 : 0;
    rem -= extra;
    return base + extra;
  });
}

export type AnnualGoalInput = {
  parentId?: string;
  subject_user_id: string;
  location_id: string;
  metric: GoalMetric;
  annual_target: number;
  year: number;
  why?: string | null;
  notes?: string | null;
  set_by?: string | null;
  /** Overwrite the monthly targets from the annual figure. */
  redistribute: boolean;
};

/** Children of an annual goal, oldest month first. */
export async function fetchMonthlyChildren(parentId: string): Promise<Goal[]> {
  const { data, error } = await supabase
    .from("goals")
    .select("*")
    .eq("parent_goal_id", parentId)
    .order("starts_on");
  if (error) throw error;
  return (data ?? []) as Goal[];
}

/**
 * Save an annual goal and keep its twelve monthly targets in step. Months are
 * only rewritten when the manager asks for it, so a hand-tuned January is not
 * silently flattened by an edit to the annual number.
 */
export async function saveAnnualGoal(input: AnnualGoalInput): Promise<string> {
  let preservedWhy: string | null | undefined;
  if (input.parentId && input.why === undefined) {
    const { data, error } = await supabase
      .from("goals")
      .select("why")
      .eq("id", input.parentId)
      .maybeSingle();
    if (error) throw error;
    preservedWhy = data?.why ?? null;
  }
  const normalizedWhy = input.why === undefined ? preservedWhy : input.why?.trim() || null;
  const why = normalizedWhy === undefined ? {} : { why: normalizedWhy };
  const base = {
    subject_user_id: input.subject_user_id,
    subject_location_id: null,
    location_id: input.location_id,
    metric: input.metric,
    ...why,
    notes: input.notes?.trim() || null,
    set_by: input.set_by ?? null,
  };
  const yearStart = `${input.year}-01-01`;
  const yearEnd = `${input.year}-12-31`;

  let parentId = input.parentId ?? null;
  if (parentId) {
    const { error } = await supabase
      .from("goals")
      .update({ ...base, target_value: input.annual_target, is_active: true })
      .eq("id", parentId);
    if (error) throw error;
  } else {
    const { data, error } = await supabase
      .from("goals")
      .insert({
        ...base,
        target_value: input.annual_target,
        period_type: "year" as GoalPeriod,
        starts_on: yearStart,
        ends_on: yearEnd,
      })
      .select("id")
      .single();
    if (error) throw error;
    parentId = data.id as string;
  }

  const existing = await fetchMonthlyChildren(parentId);
  const split = splitAnnual(input.annual_target, GOAL_METRICS[input.metric].unit);
  const months = monthsOfYear(input.year);

  const toInsert: Record<string, unknown>[] = [];
  for (let i = 0; i < 12; i++) {
    const m = months[i]!;
    const hit = existing.find((g) => g.starts_on === m.startsOn);
    if (!hit) {
      toInsert.push({
        ...base,
        parent_goal_id: parentId,
        target_value: split[i],
        period_type: "month" as GoalPeriod,
        starts_on: m.startsOn,
        ends_on: m.endsOn,
      });
    } else if (input.redistribute) {
      const { error } = await supabase
        .from("goals")
        .update({ ...base, target_value: split[i], is_active: true })
        .eq("id", hit.id);
      if (error) throw error;
    } else {
      const { error } = await supabase.from("goals").update(base).eq("id", hit.id);
      if (error) throw error;
    }
  }
  if (toInsert.length > 0) {
    const { error } = await supabase.from("goals").insert(toInsert as never);
    if (error) throw error;
  }
  return parentId;
}

/** Change one month's target without touching the rest of the year. */
export async function setMonthlyTarget(goalId: string, target: number): Promise<void> {
  const { error } = await supabase.from("goals").update({ target_value: target }).eq("id", goalId);
  if (error) throw error;
}

/**
 * The "why" is the rep's, so the rep can write it — the database decides that,
 * not the UI. Writing it on a parent goal writes it down to every month.
 */
export async function setGoalWhy(goalId: string, why: string): Promise<void> {
  const { error } = await supabase.rpc("set_goal_why", { _goal_id: goalId, _why: why });
  if (error) throw error;
}

/* ------------------------------------------------------------------ */
/* Attainment                                                          */
/* ------------------------------------------------------------------ */

export type AttainmentLine = {
  goal: Goal;
  def: MetricDef;
  actual: number | null;
  target: number;
  /** actual ÷ target, inverted for lower-is-better metrics. Null when unmeasured. */
  ratio: number | null;
};

export type Attainment = {
  /** Null means "no active goals" — never rendered as zero. */
  pct: number | null;
  lines: AttainmentLine[];
};

export function attainmentFor(
  goals: Goal[],
  m: PersonMetrics,
  extra: GoalExtras = { newAccounts: 0 },
): Attainment {
  const lines: AttainmentLine[] = goals.map((g) => {
    const def = GOAL_METRICS[g.metric];
    const actual = def.actual(m, extra);
    let ratio: number | null = null;
    if (actual != null && g.target_value > 0) {
      ratio =
        def.direction === "lower"
          ? g.target_value / Math.max(actual, 0.0001)
          : actual / g.target_value;
    }
    return { goal: g, def, actual, target: Number(g.target_value), ratio };
  });
  const scored = lines.map((l) => l.ratio).filter((r): r is number => r != null);
  return { pct: scored.length ? scored.reduce((a, b) => a + b, 0) / scored.length : null, lines };
}

export const fmtPct = (v: number | null) => (v == null ? "—" : `${Math.round(v * 100)}%`);
