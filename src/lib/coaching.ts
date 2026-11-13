import { supabase } from "@/integrations/supabase/client";
import { attainmentFor, fetchGoals, fetchNewAccounts, goalWindow, elapsedShare } from "@/lib/goals";
import type { Attainment } from "@/lib/goals";
import { activityOf, fetchStandings } from "@/lib/leaderboard";
import {
  fetchMetrics,
  fetchPersonStalled,
  fetchTeamMedians,
  rangeFor,
  previousRange,
  type PersonMetrics,
  type PersonStalled,
  type TeamMedians,
} from "@/lib/scorecard";

/**
 * Coaching: nudges and the 1:1 pack.
 *
 * Two ideas run through this file.
 *
 * 1. The rep is reminded, not the manager. A nudge belongs to the person who
 *    can fix it, and only surfaces upward once it has been ignored.
 * 2. Comparison is to the rep's own last month and to an anonymous team
 *    median — never to a named peer's figures.
 *
 * Everything reads through the caller's authenticated client, so RLS decides
 * what a manager can see. No money figure reaches a rep-facing view.
 */

export type Nudge = {
  id: string;
  user_id: string;
  kind: string;
  entity_type: string;
  entity_id: string | null;
  dedupe_key: string;
  title: string;
  reason: string;
  href: string | null;
  location_id: string | null;
  nudge_count: number;
  last_nudged_at: string;
  escalated_at: string | null;
  resolved_at: string | null;
  created_at: string;
};

export const NUDGE_KIND_LABEL: Record<string, string> = {
  meeting_notes: "Meeting without notes",
  no_next_activity: "No next activity",
  stale_stage: "Stalled stage",
  missing_outcome: "Missing outcome",
  idle_account: "Idle account",
  goal_pace: "Behind pace",
  quick_ghosting: "Ghosting after barely trying",
};

export async function fetchMyNudges(userId: string): Promise<Nudge[]> {
  const { data, error } = await supabase
    .from("rep_nudges")
    .select("*")
    .eq("user_id", userId)
    .is("resolved_at", null)
    .order("last_nudged_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as Nudge[];
}

/**
 * What the manager sees: only nudges that escalated. A rep's first reminder is
 * their own business.
 */
export async function fetchEscalatedNudges(): Promise<Nudge[]> {
  const { data, error } = await supabase
    .from("rep_nudges")
    .select("*")
    .is("resolved_at", null)
    .not("escalated_at", "is", null)
    .order("escalated_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as Nudge[];
}

export async function resolveNudge(id: string): Promise<void> {
  const { error } = await supabase
    .from("rep_nudges")
    .update({ resolved_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

/** Idle-account rotation is always a person's decision, never automatic. */
export async function reassignAccount(accountId: string, repId: string): Promise<void> {
  const { error } = await supabase
    .from("accounts")
    .update({ assigned_rep: repId })
    .eq("id", accountId);
  if (error) throw error;
}

/* ------------------------------------------------------------------ */
/* 1:1 coaching pack                                                   */
/* ------------------------------------------------------------------ */

export type CoachingPack = {
  userId: string;
  name: string;
  current: PersonMetrics | null;
  previous: PersonMetrics | null;
  medians: TeamMedians | null;
  attainment: Attainment;
  elapsed: number;
  stalled: PersonStalled[];
  lostReasons: { reason: string; count: number }[];
  openNudges: Nudge[];
  conversion: {
    touchToMeeting: number | null;
    meetingToAdvance: number | null;
    advanceToWon: number | null;
  };
};

export async function buildCoachingPack(userId: string, name: string): Promise<CoachingPack> {
  const range = rangeFor("30d");
  const prev = previousRange(range);
  const win = goalWindow("month");

  const [currentRows, previousRows, stalled, goals, newAccounts, nudges, lost, standings] =
    await Promise.all([
      fetchMetrics(range, userId),
      fetchMetrics(prev, userId),
      fetchPersonStalled(userId),
      fetchGoals({ period: "month", window: win, userId }),
      fetchNewAccounts(win.from, win.to),
      fetchMyNudges(userId),
      fetchLostReasons(userId, prev.from),
      // The six activity actuals live on the standings row, not on
      // scorecard_metrics; a read that fails leaves them unmeasured, not zero.
      fetchStandings(win.from, win.to, null).catch(() => []),
    ]);

  const current = currentRows[0] ?? null;
  const previous = previousRows[0] ?? null;
  const medians = current
    ? await fetchTeamMedians(range, current.location_ids[0] ?? null).catch(() => null)
    : null;

  const standing = standings.find((s) => s.user_id === userId);
  const attainment = current
    ? attainmentFor(goals, current, {
        newAccounts: newAccounts[userId] ?? 0,
        activity: standing ? activityOf(standing) : null,
      })
    : { pct: null, lines: [] };

  const ratio = (a: number | undefined, b: number | undefined) =>
    a == null || b == null || b === 0 ? null : a / b;

  return {
    userId,
    name,
    current,
    previous,
    medians,
    attainment,
    elapsed: elapsedShare("month"),
    stalled,
    lostReasons: lost,
    openNudges: nudges,
    conversion: {
      touchToMeeting: ratio(current?.meetings_held, current?.touchpoints),
      meetingToAdvance: ratio(current?.accounts_advanced, current?.meetings_held),
      advanceToWon: ratio(current?.jobs_won, current?.accounts_advanced),
    },
  };
}

async function fetchLostReasons(
  userId: string,
  since: Date,
): Promise<{ reason: string; count: number }[]> {
  const { data: accountIds } = await supabase
    .from("accounts")
    .select("id")
    .eq("assigned_rep", userId);
  const ids = ((accountIds ?? []) as { id: string }[]).map((a) => a.id);
  if (!ids.length) return [];

  const { data } = await supabase
    .from("account_stage_history")
    .select("reason,to_stage,changed_at,account_id")
    .in("account_id", ids)
    .gte("changed_at", since.toISOString())
    .in("to_stage", ["lost", "no_service_needed", "goasted"]);

  const counts = new Map<string, number>();
  for (const row of (data ?? []) as { reason: string | null; to_stage: string }[]) {
    const key = (row.reason ?? "").trim() || row.to_stage.replace(/_/g, " ");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);
}
