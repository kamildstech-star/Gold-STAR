import { supabase } from "@/integrations/supabase/client";

/**
 * Two pipelines, two clocks. Prospecting is worked by hand; Farming is
 * computed from what did or didn't happen. They are deliberately not one
 * board with extra stages.
 */
export const PROSPECTING_PIPELINE_ID = "22222222-2222-4222-8222-222222222222";
export const FARMING_PIPELINE_ID = "33333333-3333-4333-8333-333333333333";
/** @deprecated The client calls this motion "Farming". Kept for older imports. */
export const CLIENT_HEALTH_PIPELINE_ID = FARMING_PIPELINE_ID;

/** "Farming" is Gold Star's own word for working a client after the sale. */
export const FARMING_LABEL = "Active Clients";

export type PipelineKind = "prospecting" | "farming" | "other";

/* ------------------------------------------------------------ prospecting */

/**
 * Leads do not belong on the board. Intake — both Sales-Head-assigned leads
 * and rep-entered leads awaiting approval — lives in the Leads Inbox, and a
 * record only reaches the pipeline once it is a real opportunity at Ready.
 */
/*
 * The Ghosted stage key is still the misspelled "goasted". It is matched as a
 * string literal by pipeline_ghost_sweep, pipeline_ghost_manual and
 * tg_account_ghost_log, and stored as data in accounts.stage,
 * account_stage_history and account_fire_rollup — renaming it is a migration of
 * its own, not a spelling fix. Only the display name was corrected.
 */
export const PROSPECTING_STAGES = [
  "ready",
  "active_outreach",
  "conversation_established",
  "active_client",
  "no_service_needed",
  "goasted",
] as const;
export type ProspectingStage = (typeof PROSPECTING_STAGES)[number];

/** Retired: these two stages now live in the Leads Inbox. */
export const RETIRED_INTAKE_STAGES = ["leads", "new_lead_input"] as const;

/** The board starts here — conversion out of the inbox lands on Ready. */
export const INTAKE_STAGE: ProspectingStage = "ready";

/** Exits, not steps. */
export const PROSPECTING_EXITS: ProspectingStage[] = [
  "active_client",
  "no_service_needed",
  "goasted",
];

/** A rep-entered lead is workable immediately, but must be approved inside this window. */
export const NEW_LEAD_APPROVAL_DAYS = 7;
/** Ghosted sits this long before the Sales Head is asked to reassign or close. */
export const GHOSTED_REVIEW_DAYS = 30;

export type ApprovalState = "not_required" | "pending" | "approved" | "escalated";

export const APPROVAL_LABEL: Record<ApprovalState, string> = {
  not_required: "—",
  pending: "Awaiting Sales Head approval",
  approved: "Approved",
  escalated: "Escalated — approval overdue",
};

export function approvalDaysLeft(dueOn: string | null): number | null {
  if (!dueOn) return null;
  const due = new Date(`${dueOn}T00:00:00`).getTime();
  return Math.ceil((due - Date.now()) / 86400000);
}

/* -------------------------------------------------------------- farming */

export const HEALTH_STAGES = ["healthy", "needs_attention", "annual_meeting", "ghosted"] as const;
export type HealthStage = (typeof HEALTH_STAGES)[number];

export const HEALTH_STAGE_LABEL: Record<HealthStage, string> = {
  healthy: "Healthy",
  needs_attention: "Needs Attention",
  annual_meeting: "Annual In-Person Meeting",
  ghosted: "Ghosted",
};

export const HEALTH_STAGE_REASON: Record<HealthStage, string> = {
  healthy: "Nothing overdue and the annual meeting is not yet in window.",
  needs_attention: "A task on this account is 7 or more days past due. Our lapse, not theirs.",
  annual_meeting: "Inside the two weeks either side of the annual in-person deadline.",
  ghosted: "No response across repeated attempts, confirmed by the rep.",
};

/** A task this far past due drags the client into Needs Attention. */
export const NEEDS_ATTENTION_TASK_DAYS = 7;
/** The annual meeting window opens 2 weeks before and closes 2 weeks after. */
export const ANNUAL_WINDOW_DAYS = 14;

export type HealthInputs = {
  /** Most overdue task on the account, in days past due. */
  maxTaskDaysOverdue: number | null;
  /** Date the annual in-person meeting is due, ISO date. */
  annualDueOn: string | null;
  /** Rep has confirmed the client has gone dark. */
  ghostConfirmed: boolean;
};

export type HealthVerdict = {
  stage: HealthStage;
  reason: string;
  /** True when the annual window has closed with no meeting held. */
  annualMissed: boolean;
};

/**
 * Movement here is computed, never dragged. Ghosted still requires the rep
 * to confirm — the system proposes, a person agrees.
 */
export function computeHealth(input: HealthInputs): HealthVerdict {
  const dayMs = 86400000;
  let annualMissed = false;
  let inAnnualWindow = false;

  if (input.annualDueOn) {
    const due = new Date(`${input.annualDueOn}T00:00:00`).getTime();
    const now = Date.now();
    const openFrom = due - ANNUAL_WINDOW_DAYS * dayMs;
    const closeAfter = due + ANNUAL_WINDOW_DAYS * dayMs;
    inAnnualWindow = now >= openFrom && now <= closeAfter;
    annualMissed = now > closeAfter;
  }

  if (input.ghostConfirmed) {
    return { stage: "ghosted", reason: HEALTH_STAGE_REASON.ghosted, annualMissed };
  }
  if (inAnnualWindow) {
    return { stage: "annual_meeting", reason: HEALTH_STAGE_REASON.annual_meeting, annualMissed };
  }
  if (input.maxTaskDaysOverdue != null && input.maxTaskDaysOverdue >= NEEDS_ATTENTION_TASK_DAYS) {
    return {
      stage: "needs_attention",
      reason: `A task is ${input.maxTaskDaysOverdue} days past due. Our lapse, not theirs.`,
      annualMissed,
    };
  }
  if (annualMissed) {
    return {
      stage: "needs_attention",
      reason: "The annual in-person window closed with no meeting held.",
      annualMissed,
    };
  }
  return { stage: "healthy", reason: HEALTH_STAGE_REASON.healthy, annualMissed };
}

/** The documented path back: an answered touch clears a confirmed ghost. */
export const GHOST_RECOVERY_NOTE =
  "A ghosted client returns to Healthy when the rep logs an answered touchpoint — a returned call, a reply, or a meeting. Clearing the ghost flag is a deliberate action, not a side effect.";

/* -------------------------------------------------------------- reasons */

export type NoServiceReason = { code: string; label: string; sort_order: number };

export async function fetchNoServiceReasons(): Promise<NoServiceReason[]> {
  const { data, error } = await supabase
    .from("no_service_reasons")
    .select("code,label,sort_order")
    .eq("is_active", true)
    .order("sort_order");
  if (error) throw error;
  return (data ?? []) as NoServiceReason[];
}
