import type { SupabaseClient } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import type { HealthTrack, HealthTrackKey } from "@/lib/client-health-tracks";
import { isMissingSchema } from "@/lib/schema-fallback";

/**
 * The Critical workflow — what happens the day a client goes Critical.
 *
 * Melly, GSR Edits: "The day an account goes Critical, three things happen
 * automatically. A recovery task is created and assigned to the rep with a
 * hard deadline. The account lands on the manager's Critical list and cannot
 * be dismissed. And the account stops counting toward the rep's leaderboard
 * numbers until it is fixed. The rep then has thirty days. Only a real
 * acknowledged response fixes it. They cannot clear it by claiming they
 * called."
 *
 * THE EPISODE IS THE RECORD. `client_critical_episodes` holds one row per
 * stretch of Critical (migration 20261110160000). It is opened and closed by
 * the nightly sweep from the SAME verdict the Active Clients board draws —
 * `fetchActiveClients` computes the band, `planCriticalSweep` below decides
 * what to open and what to close, and nothing here restates a threshold.
 *
 * WHY A REP CANNOT CLEAR IT. Nothing in the app writes `resolved_at` except
 * the sweep (on a band that is no longer Critical) and the manager's
 * decision function. Ticking the recovery task done does not touch the
 * episode; the task is the reminder and the episode is the truth.
 */

export const CRITICAL_CURE_WINDOW_DAYS = 30;
/** More than a fifth of a rep's clients Critical at once stops new assignments. */
export const CRITICAL_REP_CAP_SHARE = 0.2;
export const CRITICAL_TASK_SOURCE = "critical";
export const CRITICAL_LIST_PATH = "/farming/critical";

export type CriticalResolution = "recovered" | "reassigned" | "dormant" | "no_service" | "closed";
export type CriticalDecision = "extend" | "reassign" | "dormant" | "no_service";

export const CRITICAL_DECISION_META: Record<
  CriticalDecision,
  { label: string; description: string; noteRequired: boolean }
> = {
  extend: {
    label: "Extend the cure window",
    description:
      "Thirty more days. Write down why — the contact is on leave, the property is seasonal, a construction freeze.",
    noteRequired: true,
  },
  reassign: {
    label: "Reassign to a different rep",
    description:
      "The new rep gets all future work and a fresh thirty days. The original rep keeps every dollar from every job already signed.",
    noteRequired: false,
  },
  dormant: {
    label: "Demote to Dormant",
    description:
      "Off the client screen and into a light win-back rotation: back to Active Outreach in six months with a task. Save this for structural reasons.",
    noteRequired: false,
  },
  no_service: {
    label: "Close as No Service Needed",
    description: "They do not need Gold Star. Optionally try again in 6 or 12 months.",
    noteRequired: false,
  },
};

export const CRITICAL_RESOLUTION_LABEL: Record<CriticalResolution, string> = {
  recovered: "Recovered",
  reassigned: "Reassigned",
  dormant: "Dormant",
  no_service: "No Service Needed",
  closed: "Left Active Clients",
};

export type CriticalEpisodeRow = Database["public"]["Tables"]["client_critical_episodes"]["Row"];

/* ------------------------------------------------------------ the sweep */

/** What the sweep needs from one Active Clients row, and nothing more. */
export type CriticalSweepRow = {
  accountId: string;
  name: string;
  assignedRep: string | null;
  locationId: string | null;
  isDemo: boolean;
  healthTracked: boolean;
  health: string;
  healthTracks: readonly Pick<HealthTrack, "key" | "health" | "reason">[];
};

export type CriticalOpenEpisode = Pick<
  CriticalEpisodeRow,
  "id" | "account_id" | "recovery_task_id" | "deadline"
>;

export type CriticalOpenPlan = {
  account_id: string;
  name: string;
  assigned_rep: string | null;
  location_id: string | null;
  track: HealthTrackKey;
  reason: string;
  /** "YYYY-MM-DD" — thirty days from today. */
  deadline: string;
  is_demo: boolean;
};

export type CriticalSweepPlan = {
  /** Accounts Critical today with no open episode: open one. */
  open: CriticalOpenPlan[];
  /** Open episodes whose account is no longer Critical: the client answered. */
  recovered: CriticalOpenEpisode[];
  /** Open episodes whose account is no longer an active client at all. */
  closed: CriticalOpenEpisode[];
  /** Still open after this run, past the deadline: the manager must decide. */
  decisionDue: CriticalOpenEpisode[];
};

const DAY_MS = 86_400_000;

export function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The hard deadline: thirty days from the day it went Critical. */
export function criticalDeadline(openedAtMs: number): string {
  return isoDate(openedAtMs + CRITICAL_CURE_WINDOW_DAYS * DAY_MS);
}

/** True when the board's verdict for this row is Critical on either track. */
export function rowIsCritical(row: Pick<CriticalSweepRow, "healthTracked" | "health">): boolean {
  return row.healthTracked && row.health === "critical";
}

/**
 * Which track to name on the episode. Both can be Critical at once; the
 * relationship is named first because it is the one the rep can act on
 * tonight, and the reason line carries the other if there is one.
 */
export function criticalTrack(tracks: readonly Pick<HealthTrack, "key" | "health" | "reason">[]): {
  track: HealthTrackKey;
  reason: string;
} {
  const critical = tracks.filter((t) => t.health === "critical");
  const first = critical.find((t) => t.key === "relationship") ?? critical[0] ?? tracks[0] ?? null;
  if (!first) return { track: "relationship", reason: "Critical" };
  const rest = critical.filter((t) => t !== first).map((t) => t.reason);
  return { track: first.key, reason: [first.reason, ...rest].join(" · ") };
}

export function planCriticalSweep(input: {
  rows: readonly CriticalSweepRow[];
  open: readonly CriticalOpenEpisode[];
  now: number;
}): CriticalSweepPlan {
  const today = isoDate(input.now);
  const deadline = criticalDeadline(input.now);
  const rowsById = new Map(input.rows.map((r) => [r.accountId, r]));
  const openByAccount = new Set(input.open.map((e) => e.account_id));

  const open: CriticalOpenPlan[] = [];
  for (const row of input.rows) {
    if (!rowIsCritical(row) || openByAccount.has(row.accountId)) continue;
    const { track, reason } = criticalTrack(row.healthTracks);
    open.push({
      account_id: row.accountId,
      name: row.name,
      assigned_rep: row.assignedRep,
      location_id: row.locationId,
      track,
      reason,
      deadline,
      is_demo: row.isDemo,
    });
  }

  const recovered: CriticalOpenEpisode[] = [];
  const closed: CriticalOpenEpisode[] = [];
  const decisionDue: CriticalOpenEpisode[] = [];
  for (const ep of input.open) {
    const row = rowsById.get(ep.account_id);
    if (!row) {
      closed.push(ep);
    } else if (!rowIsCritical(row)) {
      recovered.push(ep);
    } else if (ep.deadline < today) {
      decisionDue.push(ep);
    }
  }

  return { open, recovered, closed, decisionDue };
}

/** The recovery task, shaped for insert into `public.tasks`. */
export function recoveryTaskRow(plan: CriticalOpenPlan, episodeId: string, assignee: string) {
  const trackWord = plan.track === "relationship" ? "Relationship" : "Compliance";
  return {
    title: `Recover critical client — ${plan.name}`,
    description:
      `${trackWord}: ${plan.reason}. You have thirty days, until ${plan.deadline}. ` +
      "Only a real acknowledged response — or the missing paperwork landing — clears it; completing this task does not.",
    assignee,
    due_date: plan.deadline,
    priority: "urgent" as const,
    status: "open" as const,
    source: CRITICAL_TASK_SOURCE,
    cadence_key: `critical:${episodeId}`,
    automation_reason: "Created automatically: the client went Critical.",
    account_id: plan.account_id,
    location_id: plan.location_id,
    entity_type: "account",
    entity_id: plan.account_id,
    created_by: assignee,
    is_demo: plan.is_demo,
  };
}

/* ---------------------------------------------------------- the window */

export type CriticalWindow = {
  /** Whole days since the episode opened. */
  dayOf: number;
  /** Days until the deadline; negative once it has passed. */
  daysLeft: number;
  /** True once the deadline has passed and no decision has closed it. */
  decisionDue: boolean;
};

export function criticalWindow(
  ep: Pick<CriticalEpisodeRow, "opened_at" | "deadline">,
  now: number = Date.now(),
): CriticalWindow {
  const opened = new Date(ep.opened_at).getTime();
  const dayOf = Math.max(1, Math.floor((now - opened) / DAY_MS) + 1);
  const today = isoDate(now);
  const daysLeft = Math.round(
    (new Date(`${ep.deadline}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime()) /
      DAY_MS,
  );
  return { dayOf, daysLeft, decisionDue: daysLeft < 0 };
}

/* ------------------------------------------------------------- reading */

type Client = Pick<SupabaseClient<Database>, "from" | "rpc">;

/** Every open episode, or none when the table has not been migrated in yet. */
export async function fetchOpenCriticalEpisodes(
  client: Client = supabase,
): Promise<CriticalEpisodeRow[]> {
  const res = await client
    .from("client_critical_episodes")
    .select("*")
    .is("resolved_at", null)
    .order("deadline")
    .limit(1000);
  if (res.error) {
    if (isMissingSchema(res.error)) return [];
    throw res.error;
  }
  return res.data ?? [];
}

export type CriticalListEntry = {
  episode: CriticalEpisodeRow;
  accountName: string;
  repName: string | null;
  window: CriticalWindow;
  lastDecision: { decision: CriticalDecision; note: string | null; at: string } | null;
};

export type CriticalList = {
  open: CriticalListEntry[];
  /** Closed in the last ninety days, newest first. */
  recent: (CriticalListEntry & { resolution: CriticalResolution })[];
  caps: {
    user_id: string;
    full_name: string;
    clients: number;
    critical: number;
    over_cap: boolean;
  }[];
  /**
   * Melly: "The manager gets one number per rep — what percentage of their
   * clients were cleared by the rep saying so rather than the system
   * detecting it." Of the clients whose clock was last reset by a counting
   * touch, how many were reset by a hand-logged one. Keyed by rep.
   */
  selfCleared: Record<string, { cleared: number; selfCleared: number }>;
};

/** Self-cleared share, or null when nothing has been cleared yet. */
export function selfClearedShare(
  s: { cleared: number; selfCleared: number } | undefined,
): number | null {
  if (!s || s.cleared === 0) return null;
  return s.selfCleared / s.cleared;
}

/** At or above this share the number is drawn as a warning. Melly set none; half is the line here. */
export const SELF_CLEARED_WARN_SHARE = 0.5;

/** The manager's Critical list: open episodes, recent outcomes, the rep cap. */
export async function fetchCriticalList(now: number = Date.now()): Promise<CriticalList> {
  const since = new Date(now - 90 * DAY_MS).toISOString();
  const [openRes, recentRes, capsRes] = await Promise.all([
    supabase
      .from("client_critical_episodes")
      .select("*")
      .is("resolved_at", null)
      .order("deadline")
      .limit(500),
    supabase
      .from("client_critical_episodes")
      .select("*")
      .not("resolved_at", "is", null)
      .gte("resolved_at", since)
      .order("resolved_at", { ascending: false })
      .limit(200),
    supabase.rpc("rep_critical_caps"),
  ]);
  // Its own read: a database without 20261110190000 still shows the list.
  const selfRes = await supabase.rpc("rep_self_cleared_shares");
  const selfCleared: CriticalList["selfCleared"] = {};
  for (const r of selfRes.error ? [] : (selfRes.data ?? [])) {
    selfCleared[r.user_id] = { cleared: r.cleared, selfCleared: r.self_cleared };
  }
  for (const r of [openRes, recentRes]) {
    if (r.error) {
      if (isMissingSchema(r.error)) return { open: [], recent: [], caps: [], selfCleared: {} };
      throw r.error;
    }
  }
  const episodes = [...(openRes.data ?? []), ...(recentRes.data ?? [])];
  const accountIds = [...new Set(episodes.map((e) => e.account_id))];
  const repIds = [...new Set(episodes.map((e) => e.assigned_rep).filter(Boolean))] as string[];
  const episodeIds = episodes.map((e) => e.id);

  const [accRes, profRes, decRes] = await Promise.all([
    accountIds.length
      ? supabase.from("accounts").select("id,name").in("id", accountIds)
      : Promise.resolve({ data: [] as { id: string; name: string }[], error: null }),
    repIds.length
      ? supabase.from("profiles").select("user_id,full_name").in("user_id", repIds)
      : Promise.resolve({
          data: [] as { user_id: string; full_name: string | null }[],
          error: null,
        }),
    episodeIds.length
      ? supabase
          .from("client_critical_decisions")
          .select("episode_id,decision,note,decided_at")
          .in("episode_id", episodeIds)
          .order("decided_at", { ascending: false })
      : Promise.resolve({
          data: [] as {
            episode_id: string;
            decision: string;
            note: string | null;
            decided_at: string;
          }[],
          error: null,
        }),
  ]);
  const names = new Map((accRes.data ?? []).map((a) => [a.id, a.name]));
  const reps = new Map((profRes.data ?? []).map((p) => [p.user_id, p.full_name ?? null]));
  const lastDecision = new Map<string, CriticalListEntry["lastDecision"]>();
  for (const d of decRes.data ?? []) {
    if (lastDecision.has(d.episode_id)) continue;
    lastDecision.set(d.episode_id, {
      decision: d.decision as CriticalDecision,
      note: d.note,
      at: d.decided_at,
    });
  }
  const entry = (e: CriticalEpisodeRow): CriticalListEntry => ({
    episode: e,
    accountName: names.get(e.account_id) ?? "—",
    repName: e.assigned_rep ? (reps.get(e.assigned_rep) ?? null) : null,
    window: criticalWindow(e, now),
    lastDecision: lastDecision.get(e.id) ?? null,
  });

  return {
    open: (openRes.data ?? []).map(entry),
    recent: (recentRes.data ?? []).map((e) => ({
      ...entry(e),
      resolution: (e.resolution ?? "closed") as CriticalResolution,
    })),
    caps: capsRes.error ? [] : (capsRes.data ?? []),
    selfCleared,
  };
}

/** The open episode on one account, for its record page. */
export async function fetchCriticalEpisodeFor(
  accountId: string,
): Promise<CriticalEpisodeRow | null> {
  const res = await supabase
    .from("client_critical_episodes")
    .select("*")
    .eq("account_id", accountId)
    .is("resolved_at", null)
    .maybeSingle();
  if (res.error) {
    if (isMissingSchema(res.error)) return null;
    throw res.error;
  }
  return res.data ?? null;
}

/* ------------------------------------------------------------ deciding */

export async function decideCritical(input: {
  episodeId: string;
  decision: CriticalDecision;
  note?: string | null;
  reassignTo?: string | null;
  retryMonths?: number | null;
}): Promise<string> {
  const { data, error } = await supabase.rpc("client_critical_decide", {
    _episode_id: input.episodeId,
    _decision: input.decision,
    _note: input.note ?? undefined,
    _reassign_to: input.reassignTo ?? undefined,
    _retry_months: input.retryMonths ?? undefined,
  });
  if (error) throw error;
  return String(data);
}

export const CRITICAL_QUERY_KEY = ["critical-clients"] as const;
