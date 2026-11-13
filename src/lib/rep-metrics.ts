import { supabase } from "@/integrations/supabase/client";

/**
 * Sales leaderboard.
 *
 * Sales only, by explicit instruction: chasers are never ranked against each
 * other. Figures here are activity and count based — no money, so the money
 * rule is never in play.
 */

export type RepMetrics = {
  user_id: string;
  full_name: string | null;
  jobs_signed_insurance: number;
  jobs_signed_cash: number;
  calls_made: number;
  stage_advances: number;
  meetings_held: number;
  proposals_sent: number;
  accounts_closed: number;
};

export type RankKey =
  "accounts_closed" | "proposals_sent" | "jobs_signed" | "calls_made" | "meetings_held";

export const RANK_OPTIONS: { key: RankKey; label: string }[] = [
  { key: "accounts_closed", label: "Accounts closed" },
  { key: "proposals_sent", label: "Proposals sent" },
  { key: "jobs_signed", label: "Jobs signed" },
  { key: "calls_made", label: "Calls made" },
  { key: "meetings_held", label: "Meetings held" },
];

export function jobsSigned(m: RepMetrics): number {
  return m.jobs_signed_insurance + m.jobs_signed_cash;
}

export function rankValue(m: RepMetrics, key: RankKey): number {
  if (key === "jobs_signed") return jobsSigned(m);
  return m[key];
}

export async function fetchRepMetrics(from: Date, to: Date): Promise<RepMetrics[]> {
  const { data, error } = await supabase.rpc("sales_rep_metrics", {
    _from: from.toISOString(),
    _to: to.toISOString(),
  });
  if (error) throw error;
  return (data ?? []).map((r) => ({
    user_id: r.user_id as string,
    full_name: r.full_name as string | null,
    jobs_signed_insurance: Number(r.jobs_signed_insurance ?? 0),
    jobs_signed_cash: Number(r.jobs_signed_cash ?? 0),
    calls_made: Number(r.calls_made ?? 0),
    stage_advances: Number(r.stage_advances ?? 0),
    meetings_held: Number(r.meetings_held ?? 0),
    proposals_sent: Number(r.proposals_sent ?? 0),
    accounts_closed: Number(r.accounts_closed ?? 0),
  }));
}

export function rankBy(rows: RepMetrics[], key: RankKey): RepMetrics[] {
  return [...rows].sort((a, b) => rankValue(b, key) - rankValue(a, key));
}
