import { supabase } from "@/integrations/supabase/client";
import { queueDecline, queueOutcome } from "@/lib/chase-offline";
import type { Database } from "@/integrations/supabase/types";

/**
 * Chase outcomes. Two lifecycles live here and they are deliberately kept
 * apart:
 *
 *   per chaser, per incident — accepted / declined / no_action
 *   per incident             — live / claimed / dead / won
 *
 * A chaser declining clears their own board. It does not touch the incident.
 * Whether the lead survives an outcome is decided by the reason row in the
 * database (so the lists stay editable), never by a branch in this file.
 */

export type OutcomeReason = Database["public"]["Tables"]["incident_outcome_reasons"]["Row"];
export type IncidentAttempt = Database["public"]["Tables"]["incident_attempts"]["Row"];
export type Lifecycle = Database["public"]["Enums"]["incident_lifecycle"];

export type ReasonNode = OutcomeReason & { children: OutcomeReason[] };

export const LIFECYCLE_LABEL: Record<Lifecycle, string> = {
  live: "Live",
  claimed: "Claimed",
  dead: "Dead",
  won: "Won",
};

/** Top-level reasons with their sub-options, active only, in admin order. */
export async function fetchReasonTree(): Promise<ReasonNode[]> {
  const { data, error } = await supabase
    .from("incident_outcome_reasons")
    .select("*")
    .eq("is_active", true)
    .order("sort_order");
  if (error) throw error;
  const rows = data ?? [];
  const parents = rows.filter((r) => !r.parent_id);
  return parents.map((p) => ({
    ...p,
    children: rows.filter((c) => c.parent_id === p.id),
  }));
}

/** Attempt history travels with a living lead — newest first. */
export async function fetchAttempts(incidentId: string): Promise<IncidentAttempt[]> {
  const { data, error } = await supabase
    .from("incident_attempts")
    .select("*")
    .eq("incident_id", incidentId)
    .order("attended_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function fetchAttemptsFor(
  incidentIds: string[],
): Promise<Record<string, IncidentAttempt[]>> {
  if (incidentIds.length === 0) return {};
  const { data, error } = await supabase
    .from("incident_attempts")
    .select("*")
    .in("incident_id", incidentIds)
    .order("attended_at", { ascending: false });
  if (error) throw error;
  const out: Record<string, IncidentAttempt[]> = {};
  for (const a of data ?? []) (out[a.incident_id] ??= []).push(a);
  return out;
}

export type LogOutcomeInput = {
  incidentId: string;
  reasonId: string;
  subReasonId?: string | null;
  /** Sub-option taken from a managed list (competitor, TPA) rather than the tree. */
  subLabel?: string | null;
  note?: string | null;
  worthAnotherTry?: boolean;
  revisitAfter?: string | null;
};

export type LogOutcomeResult = { lifecycle: Lifecycle; kept_live: boolean };

export async function logOutcome(
  input: LogOutcomeInput & { keptLiveHint?: boolean; label?: string },
): Promise<LogOutcomeResult & { queued?: boolean }> {
  // On a doorstep with no bars the outcome is captured locally and confirmed
  // instantly; `apply_offline_op` replays it once, keyed by the queue item id.
  const { queued, result } = await queueOutcome(input);
  if (queued) {
    const kept = input.keptLiveHint ?? false;
    return { lifecycle: kept ? "live" : "dead", kept_live: kept, queued: true };
  }
  return { ...(result as LogOutcomeResult), queued: false };
}

/** Per-chaser decline. Removes it from this board only. */
export async function declineWithReason(incidentId: string, reason?: string | null): Promise<void> {
  await queueDecline(incidentId, reason?.trim() ? reason.trim() : null);
}

/** Short decline reasons — this is about the chaser, not the lead. */
export const DECLINE_REASONS = [
  "Too far",
  "On another chase",
  "Finishing shift",
  "No vehicle",
  "Not safe",
  "Other",
] as const;

export function attemptLine(a: IncidentAttempt, name?: string | null): string {
  const when = new Date(a.attended_at).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const who = name ?? "A chaser";
  const what = [a.reason_label, a.sub_reason_label].filter(Boolean).join(" · ");
  return `${who} attended ${when} — ${what || "outcome logged"}`;
}

/**
 * Guidance, not enforcement. A 3am no-answer says nothing except "asleep";
 * the next chaser should knock in daylight. Anything the chaser wrote in the
 * note wins over the clock.
 */
export function suggestedRetry(a: IncidentAttempt): string | null {
  if (!a.kept_live) return null;
  const note = (a.note ?? "").toLowerCase();
  const m = note.match(/(?:after|before|try)\s+(\d{1,2})\s*(am|pm)/);
  if (m) return `Note says try ${m[1]}${m[2]}`;
  if (/tomorrow|next day/.test(note)) return "Note says try tomorrow";
  if (/evening|tonight/.test(note)) return "Note says try in the evening";
  const hour = new Date(a.attended_at).getHours();
  if (hour >= 22 || hour < 8) return "Attended overnight — retry after 9am";
  if (hour >= 8 && hour < 12) return "Attended morning — retry late afternoon";
  return null;
}

/** Repeat no-shows stop cycling and go to a manager instead. */
export function needsManagerReview(attempts: IncidentAttempt[], limit: number): boolean {
  return attempts.length >= Math.max(1, limit) && attempts.every((a) => a.kept_live);
}
