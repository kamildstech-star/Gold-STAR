import { useCallback, useEffect, useState } from "react";
import {
  elapsedShare,
  fetchGoals,
  goalWindow,
  type Goal,
  type GoalPeriod,
  type GoalWindow,
} from "@/lib/goals";
import { fetchStandings, rankStandings, type StandingLine } from "@/lib/leaderboard";

/**
 * One reader for goal progress.
 *
 * The dashboard widget and the My Goals tab both call this, so a rep can never
 * see two different numbers for the same target depending on which screen they
 * opened. Attainment stays null when nobody set a goal — see `src/lib/goals.ts`.
 */
export type GoalProgress = {
  loading: boolean;
  error: unknown;
  win: GoalWindow;
  goals: Goal[];
  lines: StandingLine[];
  attainment: number | null;
  /** The rep's stated reason for the target, from any goal that carries one. */
  why: string | null;
  /** Attainment has fallen behind the share of the period already spent. */
  behind: boolean;
  elapsed: number;
  reload: () => void;
};

export function useGoalProgress(userId: string | null, period: GoalPeriod = "month"): GoalProgress {
  const [win, setWin] = useState<GoalWindow>(() => goalWindow(period));
  const [goals, setGoals] = useState<Goal[]>([]);
  const [lines, setLines] = useState<StandingLine[]>([]);
  const [attainment, setAttainment] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [tick, setTick] = useState(0);

  const reload = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    const w = goalWindow(period);
    setWin(w);
    if (!userId) {
      setGoals([]);
      setLines([]);
      setAttainment(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([fetchStandings(w.from, w.to, null), fetchGoals({ period, window: w, userId })])
      .then(([standings, g]) => {
        if (cancelled) return;
        const mine = standings.find((s) => s.user_id === userId);
        const ranked = mine ? rankStandings([mine], g) : [];
        setGoals(g);
        setLines(ranked[0]?.lines ?? []);
        setAttainment(ranked[0]?.attainment ?? null);
      })
      .catch((e) => !cancelled && setError(e))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [userId, period, tick]);

  const elapsed = elapsedShare(period);
  const why = goals.find((g) => g.why && g.why.trim().length > 0)?.why ?? null;

  return {
    loading,
    error,
    win,
    goals,
    lines,
    attainment,
    why,
    behind: attainment != null && attainment < elapsed - 0.05,
    elapsed,
    reload,
  };
}
