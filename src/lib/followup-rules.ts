import { supabase } from "@/integrations/supabase/client";

/**
 * Follow-up rules.
 *
 * Logging a meeting or sending an estimate should produce the next task by
 * itself — a rep should never be relying on memory for "send the recap".
 * Rules are admin-editable so the office can change the cadence without a
 * developer. Database triggers do the actual creation; this is the CRUD layer.
 *
 * These rules only ever create internal tasks. Nothing here contacts a client.
 */

export type FollowupTrigger = "touchpoint" | "estimate_sent";
export type TouchpointType =
  | "call"
  | "email"
  | "text"
  | "meeting_in_person"
  | "meeting_virtual"
  | "linkedin"
  | "mail"
  | "gift"
  | "seasonal_send"
  | "other";
export type TaskPriority = "low" | "normal" | "high" | "urgent";

export type FollowupRule = {
  id: string;
  name: string;
  trigger_event: FollowupTrigger;
  touchpoint_type: TouchpointType | null;
  require_meeting_held: boolean;
  task_title: string;
  task_description: string | null;
  due_in_days: number;
  priority: TaskPriority;
  is_active: boolean;
  run_order: number;
};

export const TOUCHPOINT_TYPES = [
  { value: "meeting_in_person", label: "Meeting — in person" },
  { value: "meeting_virtual", label: "Meeting — virtual" },
  { value: "call", label: "Call" },
  { value: "email", label: "Email" },
  { value: "text", label: "Text" },
  { value: "linkedin", label: "LinkedIn" },
  { value: "mail", label: "Mail" },
  { value: "gift", label: "Gift" },
  { value: "other", label: "Other" },
] as const;

export async function fetchFollowupRules(): Promise<FollowupRule[]> {
  const { data, error } = await supabase
    .from("followup_rules")
    .select("*")
    .order("run_order", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as FollowupRule[];
}

export type FollowupRuleInput = Omit<FollowupRule, "id"> & { id?: string };

export async function saveFollowupRule(input: FollowupRuleInput): Promise<void> {
  const { id, ...rest } = input;
  if (id) {
    const { error } = await supabase.from("followup_rules").update(rest).eq("id", id);
    if (error) throw error;
    return;
  }
  const { error } = await supabase.from("followup_rules").insert(rest);
  if (error) throw error;
}

export async function deleteFollowupRule(id: string): Promise<void> {
  const { error } = await supabase.from("followup_rules").delete().eq("id", id);
  if (error) throw error;
}

export function describeRule(r: FollowupRule): string {
  const when =
    r.trigger_event === "estimate_sent"
      ? "Estimate sent"
      : r.touchpoint_type
        ? (TOUCHPOINT_TYPES.find((t) => t.value === r.touchpoint_type)?.label ?? r.touchpoint_type)
        : "Any touchpoint";
  const held = r.require_meeting_held ? " (held)" : "";
  const due =
    r.due_in_days === 0 ? "today" : r.due_in_days === 1 ? "tomorrow" : `in ${r.due_in_days} days`;
  return `${when}${held} → "${r.task_title}" due ${due}`;
}
