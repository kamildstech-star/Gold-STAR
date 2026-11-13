import { supabase } from "@/integrations/supabase/client";
import {
  GOAL_METRICS,
  type ActivityActuals,
  type Goal,
  type GoalMetric,
  type Motion,
} from "@/lib/goals";
import type { AppRole } from "@/lib/roles";

/**
 * Leaderboard standings.
 *
 * A leaderboard is peer-visible by design, but it must not become the back
 * door around the scorecard permissions. `leaderboard_standings` is a separate
 * database function that returns rank-relevant figures only, for people in
 * locations the caller may see, and withholds money from anyone who is not a
 * manager — exactly as a peer's scorecard does. Drill-through remains gated by
 * `can_view_person_scorecard`.
 */

export type Standing = {
  user_id: string;
  full_name: string | null;
  roles: AppRole[];
  location_ids: string[];
  touchpoints: number;
  meetings_held: number;
  accounts_advanced: number;
  accounts_owned: number;
  new_accounts: number;
  cadence_health: number | null;
  jobs_won: number;
  billed_value: number | null;
  collected_value: number | null;
  incidents_dispatched: number;
  incidents_accepted: number;
  contracts_signed: number;
  chase_acceptance: number | null;
  median_tta_minutes: number | null;
  activity_events: number;
  money_visible: boolean;
  /** Logged call touchpoints + call attempts (swaps to dialer records later). */
  calls_made: number;
  /** Forward pipeline moves made by a person, excluding the auto-advance engine. */
  stage_advances: number;
  jobs_signed_insurance: number;
  jobs_signed_cash: number;
  jobs_signed_total: number;
  /**
   * Mark's six activity actuals (16 Sep 2026), from `goal_activity_actuals`
   * via 20260916130100. Each is `number | null` rather than `number` because
   * a database the migration has not reached returns no such column, and an
   * unmeasured actual must read "—", not "0 of 40" — see src/lib/goals.ts.
   */
  cold_calls: number | null;
  cold_emails: number | null;
  new_deals_worked: number | null;
  cold_leads_converted: number | null;
  active_client_reach_outs: number | null;
  fires_chased: number | null;
};

/** The six activity fields off a standings row, for `attainmentFor`'s extras. */
export function activityOf(s: Standing): ActivityActuals {
  return {
    cold_calls: s.cold_calls ?? null,
    cold_emails: s.cold_emails ?? null,
    new_deals_worked: s.new_deals_worked ?? null,
    cold_leads_converted: s.cold_leads_converted ?? null,
    active_client_reach_outs: s.active_client_reach_outs ?? null,
    fires_chased: s.fires_chased ?? null,
  };
}

export async function fetchStandings(
  from: Date,
  to: Date,
  locationIds?: string[] | null,
): Promise<Standing[]> {
  const { data, error } = await supabase.rpc("leaderboard_standings", {
    _from: from.toISOString(),
    _to: to.toISOString(),
    _location_ids: locationIds && locationIds.length ? locationIds : undefined,
  });
  if (error) throw error;
  return (data ?? []) as unknown as Standing[];
}

/** Chase and relationship are different jobs; they are never ranked together. */
export function motionOf(roles: AppRole[]): Motion {
  return roles.includes("field_chaser") || roles.includes("field") || roles.includes("crew")
    ? "chase"
    : "relationship";
}

/** The actual for each goal metric, read off a standings row. */
const ACTUAL: Record<GoalMetric, (s: Standing) => number | null> = {
  meetings_held: (s) => s.meetings_held,
  touchpoints: (s) => s.touchpoints,
  accounts_advanced: (s) => s.accounts_advanced,
  new_accounts: (s) => s.new_accounts,
  contracts_signed: (s) => s.contracts_signed,
  jobs_won: (s) => s.jobs_won,
  billed_value: (s) => s.billed_value,
  collected_value: (s) => s.collected_value,
  median_tta_minutes: (s) => s.median_tta_minutes,
  conversion_rate: (s) =>
    s.accounts_advanced ? (s.meetings_held / s.accounts_advanced) * 100 : null,
  // `?? null`, not `?? 0`: before 20260916130100 is applied the column is
  // simply absent, and absent is unmeasured.
  cold_calls: (s) => s.cold_calls ?? null,
  cold_emails: (s) => s.cold_emails ?? null,
  new_deals_worked: (s) => s.new_deals_worked ?? null,
  cold_leads_converted: (s) => s.cold_leads_converted ?? null,
  active_client_reach_outs: (s) => s.active_client_reach_outs ?? null,
  fires_chased: (s) => s.fires_chased ?? null,
};

export type StandingLine = {
  metric: GoalMetric;
  label: string;
  target: number;
  actual: number | null;
  ratio: number | null;
};

export type Ranked = {
  standing: Standing;
  motion: Motion;
  name: string;
  /** Null means "no active goals" — never rendered as 0%. */
  attainment: number | null;
  lines: StandingLine[];
  /** Headline value used as the tie-break, and shown in the standings. */
  headline: number | null;
};

export function displayNameOf(s: Standing) {
  return s.full_name?.trim() || "Unnamed user";
}

export function initialsOf(name: string) {
  const parts = name.split(/\s+/).filter(Boolean).slice(0, 2);
  return parts.map((p) => p[0]!.toUpperCase()).join("") || "?";
}

/**
 * Rank by attainment, tie-broken by the motion's headline value. People with
 * no goals are ranked last and shown as "no active goals" — nobody is placed
 * at 0% because nobody set them a target.
 */
export function rankStandings(standings: Standing[], goals: Goal[]): Ranked[] {
  const byUser = new Map<string, Goal[]>();
  for (const g of goals) {
    if (!g.subject_user_id) continue;
    const list = byUser.get(g.subject_user_id) ?? [];
    list.push(g);
    byUser.set(g.subject_user_id, list);
  }

  const ranked = standings.map<Ranked>((s) => {
    const motion = motionOf(s.roles);
    const lines = (byUser.get(s.user_id) ?? []).map<StandingLine>((g) => {
      const def = GOAL_METRICS[g.metric];
      const actual = ACTUAL[g.metric](s);
      const target = Number(g.target_value);
      let ratio: number | null = null;
      if (actual != null && target > 0) {
        ratio = def.direction === "lower" ? target / Math.max(actual, 0.0001) : actual / target;
      }
      return { metric: g.metric, label: def.label, target, actual, ratio };
    });
    const scored = lines.map((l) => l.ratio).filter((r): r is number => r != null);
    const headline =
      motion === "chase"
        ? s.contracts_signed
        : s.money_visible
          ? (s.billed_value ?? 0)
          : s.jobs_won;
    return {
      standing: s,
      motion,
      name: displayNameOf(s),
      attainment: scored.length ? scored.reduce((a, b) => a + b, 0) / scored.length : null,
      lines,
      headline,
    };
  });

  return ranked.sort((a, b) => {
    const av = a.attainment;
    const bv = b.attainment;
    if (av == null && bv == null) return (b.headline ?? 0) - (a.headline ?? 0);
    if (av == null) return 1;
    if (bv == null) return -1;
    if (bv !== av) return bv - av;
    return (b.headline ?? 0) - (a.headline ?? 0);
  });
}

export const pct = (v: number | null) => (v == null ? "—" : `${Math.round(v * 100)}%`);
export const num = (v: number | null) => (v == null ? "—" : Math.round(v).toLocaleString("en-US"));
export const usd = (v: number | null) =>
  v == null ? "—" : `$${Math.round(v).toLocaleString("en-US")}`;
