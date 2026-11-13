/**
 * Automatic stage progression.
 *
 * A sales manager's job is hiring, firing and following up — not dragging
 * cards. Each stage can declare the work that defines it; when the declared
 * conditions are satisfied the record advances itself and the move is written
 * to stage history with the rule that caused it, so the timeline reads
 * "Advanced to Conversation Established automatically — meeting scheduled".
 *
 * The engine itself lives in Postgres (stage_advance_evaluate), fired by
 * triggers on touchpoints, calendar events, estimates and signed documents —
 * so a move happens the moment the meeting is booked, not overnight.
 *
 * A rep can still drag manually. Automation never blocks a human move, only
 * moves forward, and every firing is reversible from the account page.
 */

import { supabase } from "@/integrations/supabase/client";

export type AdvanceConditionKind =
  | "attempt_logged"
  | "reply_received"
  | "call_logged"
  | "touch_logged"
  | "activity_logged"
  | "meeting_scheduled"
  | "meeting_held"
  | "estimate_sent"
  | "contract_signed"
  | "document_signed"
  | "days_in_stage"
  | "field_populated";

export type AdvanceCondition = {
  kind: AdvanceConditionKind;
  /** activity_logged: touchpoint type, or "any". */
  activity_type?: string;
  /** how many are needed. Defaults to 1. */
  min_count?: number;
  /** days_in_stage: how long the record must have sat here. */
  days?: number;
  /** field_populated: which account column must be non-empty. */
  field?: string;
};

export const ADVANCE_CONDITION_LABEL: Record<AdvanceConditionKind, string> = {
  // The two conditions the outreach rules arm (20260909120100): any outbound
  // touchpoint since the record entered the stage, and any reply since then.
  attempt_logged: "Contact attempt logged",
  reply_received: "Reply received",
  call_logged: "Call logged",
  touch_logged: "Conversation / touch logged",
  activity_logged: "Activity logged",
  meeting_scheduled: "Meeting scheduled",
  meeting_held: "Meeting held",
  estimate_sent: "Estimate sent",
  contract_signed: "Contract signed",
  document_signed: "Document signed",
  days_in_stage: "N days in stage",
  field_populated: "Field populated",
};

export const ADVANCE_ACTIVITY_TYPES = [
  { key: "any", label: "Any activity" },
  { key: "call", label: "Call" },
  { key: "email", label: "Email" },
  { key: "text", label: "Text" },
  { key: "meeting_in_person", label: "In-person meeting" },
  { key: "meeting_virtual", label: "Virtual meeting" },
  { key: "linkedin", label: "LinkedIn" },
  { key: "mail", label: "Mail" },
  { key: "other", label: "Other" },
] as const;

/** Account columns a stage may require before it advances. */
export const ADVANCE_FIELDS = [
  { key: "phone", label: "Phone" },
  { key: "email", label: "Email" },
  { key: "website", label: "Website" },
  { key: "address_line1", label: "Address" },
  { key: "estimated_annual_value", label: "Estimated annual value" },
  { key: "account_type_id", label: "Account type" },
  { key: "assigned_rep", label: "Assigned rep" },
] as const;

/** Conditions that count occurrences rather than a one-off state. */
export const COUNTABLE_KINDS: AdvanceConditionKind[] = [
  "call_logged",
  "touch_logged",
  "activity_logged",
  "meeting_scheduled",
  "meeting_held",
  "estimate_sent",
  "contract_signed",
  "document_signed",
];

export function describeCondition(c: AdvanceCondition): string {
  const n = c.min_count ?? 1;
  if (c.kind === "activity_logged") {
    const t = ADVANCE_ACTIVITY_TYPES.find((a) => a.key === (c.activity_type ?? "any"));
    return n > 1 ? `${n} × ${t?.label ?? "activity"} logged` : `${t?.label ?? "Activity"} logged`;
  }
  if (c.kind === "days_in_stage") return `${c.days ?? 1} days in stage`;
  if (c.kind === "field_populated") {
    const f = ADVANCE_FIELDS.find((x) => x.key === c.field);
    return `${f?.label ?? c.field ?? "Field"} populated`;
  }
  const base = ADVANCE_CONDITION_LABEL[c.kind] ?? c.kind;
  return n > 1 ? `${n} × ${base.toLowerCase()}` : base;
}

export function conditionsOfStage(raw: unknown): AdvanceCondition[] {
  return Array.isArray(raw) ? (raw as AdvanceCondition[]) : [];
}

export type AdvanceMatch = "all" | "any";

export type StageAdvanceConfig = {
  auto_advance: boolean;
  advance_to_stage_id: string | null;
  advance_conditions: AdvanceCondition[];
  advance_match: AdvanceMatch;
  advance_min_count: number;
};

export async function saveStageAdvance(stageId: string, cfg: StageAdvanceConfig): Promise<void> {
  const { error } = await supabase
    .from("pipeline_stages")
    .update({
      auto_advance: cfg.auto_advance,
      advance_to_stage_id: cfg.advance_to_stage_id,
      advance_conditions: cfg.advance_conditions as never,
      advance_match: cfg.advance_match,
      advance_min_count: Math.max(1, cfg.advance_min_count || 1),
    })
    .eq("id", stageId);
  if (error) throw error;
}

/** Master switch for a whole pipeline. */
export async function setPipelineAutoAdvance(pipelineId: string, on: boolean): Promise<void> {
  const { error } = await supabase
    .from("pipelines")
    .update({ auto_advance_enabled: on })
    .eq("id", pipelineId);
  if (error) throw error;
}

export type StageAutoAdvance = {
  id: string;
  account_id: string;
  from_stage_id: string | null;
  to_stage_id: string | null;
  note: string | null;
  fired_at: string;
  undone_at: string | null;
};

/** Most recent automatic move on an account, if it hasn't been undone. */
export async function fetchLatestAutoAdvance(accountId: string): Promise<StageAutoAdvance | null> {
  const { data, error } = await supabase
    .from("stage_auto_advances")
    .select("id, account_id, from_stage_id, to_stage_id, note, fired_at, undone_at")
    .eq("account_id", accountId)
    .is("undone_at", null)
    .order("fired_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as StageAutoAdvance | null) ?? null;
}

/** Puts the record back and stops the same rule firing again. */
export async function undoAutoAdvance(advanceId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("undo_stage_auto_advance", {
    _advance_id: advanceId,
  });
  if (error) throw error;
  return !!data;
}
