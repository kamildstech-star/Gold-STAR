import { supabase } from "@/integrations/supabase/client";
import { notifyUsers } from "@/lib/notifications.functions";

/**
 * Achievements / badges.
 *
 * Definitions are admin-editable rows in `leaderboard_achievements`; earned
 * badges live in `user_achievements` and are awarded automatically by the
 * database routine `award_achievements()` off real data. The only badge a
 * human may grant is the Director's Award (`rule_key = 'manual'`).
 *
 * Rarity is a live figure — how many of the eligible sales people hold the
 * badge — because a rare badge only feels rare when you can see that.
 */

export type Rarity = "common" | "uncommon" | "rare" | "legendary";

export type BadgeDef = {
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
  rarity: Rarity;
  window_kind: string;
  rule_key: string;
};

export type EarnedBadge = {
  id: string;
  user_id: string;
  achievement_id: string;
  period_key: string;
  earned_at: string;
  value: number | null;
  note: string | null;
  granted_by: string | null;
  badge: BadgeDef | null;
};

export type Kudos = {
  id: string;
  to_user_id: string;
  from_user_id: string;
  body: string;
  user_achievement_id: string | null;
  created_at: string;
};

export const RARITY_META: Record<Rarity, { label: string; ring: string; text: string }> = {
  common: { label: "Common", ring: "border-border", text: "text-muted-foreground" },
  uncommon: { label: "Uncommon", ring: "border-[var(--success)]", text: "text-[var(--success)]" },
  rare: { label: "Rare", ring: "border-primary", text: "text-primary" },
  legendary: { label: "Legendary", ring: "border-[var(--warning)]", text: "text-[var(--warning)]" },
};

export const RARITY_ORDER: Rarity[] = ["common", "uncommon", "rare", "legendary"];

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

export async function fetchBadgeDefs(): Promise<BadgeDef[]> {
  const { data, error } = await supabase
    .from("leaderboard_achievements")
    .select("*")
    .eq("active", true)
    .order("sort_order");
  if (error) throw error;
  return (data ?? []) as unknown as BadgeDef[];
}

/** Every earned badge (the board is peer-visible, and rarity needs the whole set). */
export async function fetchEarnedBadges(userId?: string): Promise<EarnedBadge[]> {
  let q = supabase
    .from("user_achievements")
    .select("*, badge:leaderboard_achievements(*)")
    .order("earned_at", { ascending: false });
  if (userId) q = q.eq("user_id", userId);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as unknown as EarnedBadge[];
}

/** How many people the badges are open to — the denominator for rarity. */
export async function fetchRepUniverse(): Promise<number> {
  const { data, error } = await supabase.from("user_roles").select("user_id, role");
  if (error) throw error;
  const excluded = new Set(["field_chaser", "crew", "field"]);
  const byUser = new Map<string, string[]>();
  for (const r of data ?? []) {
    const list = byUser.get(r.user_id) ?? [];
    list.push(String(r.role));
    byUser.set(r.user_id, list);
  }
  let n = 0;
  for (const roles of byUser.values()) {
    if (!roles.some((r) => excluded.has(r))) n += 1;
  }
  return Math.max(n, 1);
}

/** "held by 8% of reps" */
export function rarityPct(earned: EarnedBadge[], badgeId: string, universe: number): number {
  const holders = new Set(earned.filter((e) => e.achievement_id === badgeId).map((e) => e.user_id))
    .size;
  return Math.round((holders / Math.max(universe, 1)) * 100);
}

export type BadgeProgress = { current: number; target: number; label: string };

/**
 * Progress toward the badges a person has not earned yet, from real data.
 * Only the countable rules get a bar; one-off rules ("won back a Ghosted
 * account") simply show as locked.
 */
export async function fetchBadgeProgress(userId: string): Promise<Record<string, BadgeProgress>> {
  const since = new Date(Date.now() - 60 * 86400000).toISOString();
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);

  const [jobsRes, tpRes, meetRes] = await Promise.all([
    supabase
      .from("jobs")
      .select("agreed_price,billed_amount,estimated_amount,status")
      .eq("created_by", userId),
    supabase
      .from("touchpoints")
      .select("occurred_at")
      .eq("created_by", userId)
      .gte("occurred_at", since),
    supabase
      .from("touchpoints")
      .select("id", { count: "exact", head: true })
      .eq("created_by", userId)
      .eq("meeting_held", true)
      .gte("occurred_at", monthStart.toISOString()),
  ]);

  const jobs = (jobsRes.data ?? []).filter((j) => String(j.status) !== "cancelled");
  const values = jobs.map(
    (j) => Number(j.agreed_price ?? j.billed_amount ?? j.estimated_amount ?? 0) || 0,
  );
  const jobCount = jobs.length;
  const totalValue = values.reduce((a, b) => a + b, 0);
  const biggest = values.length ? Math.max(...values) : 0;

  // Longest run of consecutive days with activity in the last 60 days.
  const days = [
    ...new Set((tpRes.data ?? []).map((t) => String(t.occurred_at).slice(0, 10))),
  ].sort();
  let streak = days.length ? 1 : 0;
  let run = streak;
  for (let i = 1; i < days.length; i += 1) {
    const prev = new Date(days[i - 1]!).getTime();
    const cur = new Date(days[i]!).getTime();
    run = cur - prev === 86400000 ? run + 1 : 1;
    streak = Math.max(streak, run);
  }

  return {
    jobs_signed_lifetime: { current: jobCount, target: 0, label: "jobs signed" },
    signed_value_lifetime: { current: totalValue, target: 0, label: "signed" },
    single_deal_value: { current: biggest, target: 0, label: "biggest deal" },
    activity_streak_days: { current: streak, target: 0, label: "day streak" },
    most_meetings_month: { current: meetRes.count ?? 0, target: 0, label: "meetings this month" },
  };
}

/* ------------------------------------------------------------------ */
/* Writes                                                              */
/* ------------------------------------------------------------------ */

/** The one badge a human may award. */
export async function grantDirectorAward(
  userId: string,
  note: string,
  grantedBy: string,
): Promise<void> {
  const { data: def, error: defErr } = await supabase
    .from("leaderboard_achievements")
    .select("id")
    .eq("rule_key", "manual")
    .eq("active", true)
    .limit(1)
    .maybeSingle();
  if (defErr) throw defErr;
  if (!def) throw new Error("No manual award badge is configured.");
  const { error } = await supabase.from("user_achievements").insert({
    user_id: userId,
    achievement_id: def.id,
    period_key: new Date().toISOString().slice(0, 10),
    note: note || null,
    granted_by: grantedBy,
  });
  if (error) throw error;
}

export async function addKudos(input: {
  toUserId: string;
  fromUserId: string;
  body: string;
  userAchievementId?: string | null;
  jobId?: string | null;
}): Promise<void> {
  const { error } = await supabase.from("leaderboard_kudos").insert({
    to_user_id: input.toUserId,
    from_user_id: input.fromUserId,
    body: input.body,
    user_achievement_id: input.userAchievementId ?? null,
    job_id: input.jobId ?? null,
  });
  if (error) throw error;
  // The recipient is someone else, and `notifications` only lets you insert
  // rows for yourself — so this goes through the server function, which
  // checks the sender may reach them and writes with the service role.
  await notifyUsers({
    data: {
      userIds: [input.toUserId],
      type: "achievement_unlocked",
      title: "Kudos from your director",
      body: input.body,
      entityType: "kudos",
      href: "/leaderboard",
      priority: "normal",
    },
  });
}

export async function fetchKudos(limit = 10): Promise<Kudos[]> {
  const { data, error } = await supabase
    .from("leaderboard_kudos")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as unknown as Kudos[];
}
