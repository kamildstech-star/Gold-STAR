// Task automation — a rules engine the Sales Head configures without a
// developer. This module owns the vocabulary (triggers, conditions, actions)
// and the client-side CRUD. Evaluation lives server-side in
// automation.functions.ts.
//
// Two constraints are structural, not cosmetic:
//  1. Automation is INTERNAL ONLY. The action vocabulary below contains no
//     client-facing send, and the database rejects any action outside it —
//     that holds even for pre-written human templates.
//  2. Every generated task carries the rule that created it and a plain
//     sentence saying why. Tasks that appear from nowhere get ignored.

import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";

export type AutomationRule = Database["public"]["Tables"]["automation_rules"]["Row"];
export type AutomationRun = Database["public"]["Tables"]["automation_runs"]["Row"];
export type AutomationEvent = Database["public"]["Tables"]["automation_events"]["Row"];
export type StageWindow = Database["public"]["Tables"]["automation_stage_windows"]["Row"];
/*
 * `job_stage_age` and `send_email` arrive with 20260926121000. The generated
 * types lag a migration applied by hand after merge, so they are added here
 * rather than by widening the generated file.
 */
export type TriggerType = Database["public"]["Enums"]["automation_trigger"] | "job_stage_age";
export type ActionKind = Database["public"]["Enums"]["automation_action_kind"] | "send_email";
export type JobAssignmentRole = Database["public"]["Enums"]["job_assignment_role"];

export const TRIGGERS: TriggerType[] = [
  "stage_enter",
  "stage_leave",
  "stage_rot",
  "task_past_due",
  "no_activity",
  "date_reached",
  "deal_created",
  "deal_won",
  "deal_lost",
  "job_stage_age",
];

/**
 * Triggers that watch JOBS rather than sales accounts. David, 22 Sep, on the
 * old screen: "it looks like it's more on the sales end for tracking sale
 * items." These are the job half.
 */
export const JOB_TRIGGERS: ReadonlySet<TriggerType> = new Set<TriggerType>(["job_stage_age"]);
export const isJobTrigger = (t: TriggerType | null | undefined) => !!t && JOB_TRIGGERS.has(t);

export const TRIGGER_LABEL: Record<TriggerType, string> = {
  stage_enter: "Deal enters a stage",
  stage_leave: "Deal leaves a stage",
  stage_rot: "Deal sits in the same stage too long (rotting)",
  task_past_due: "Task is past due",
  no_activity: "No activity on an account for N days",
  date_reached: "A date is reached",
  deal_created: "Deal created",
  deal_won: "Deal won",
  deal_lost: "Deal lost",
  job_stage_age: "Job has been in a stage for N days",
};

export const TRIGGER_HINT: Record<TriggerType, string> = {
  stage_enter: "Fires once per account each time it lands in a matching stage.",
  stage_leave: "Fires once per account each time it moves out of a matching stage.",
  stage_rot:
    "Uses the per-stage rot window. Active Outreach should rot far faster than Conversation Established — one global timer is useless.",
  task_past_due: "Fires when an open task is N days past its due date.",
  no_activity: "Counts touch points that qualify for cadence, not just outbound attempts.",
  date_reached:
    "Annual meeting window, reactivation date, the 7-day new-lead approval deadline, or the 1-month Ghosted mark.",
  deal_created: "Fires on the account's first appearance in the pipeline.",
  deal_won: "Fires when the account reaches a won stage.",
  deal_lost: "Fires when the account reaches a lost stage.",
  job_stage_age:
    "Fires once per stay: N days after a job enters one of the chosen stages, but only if it is still there. A job that moved on does not fire; one that comes back starts a new count.",
};

export const ACTIONS: ActionKind[] = [
  "create_task",
  "assign_task",
  "set_due_date",
  "notify",
  "move_stage",
  "apply_flag",
  "escalate",
  "send_email",
];

/** What a job rule can do. Stage moves and flags are account things. */
export const JOB_ACTIONS: ActionKind[] = ["create_task", "send_email", "notify"];

export const ACTION_LABEL: Record<ActionKind, string> = {
  create_task: "Create a task",
  assign_task: "Assign it",
  set_due_date: "Set a due date",
  notify: "Send an internal notification",
  move_stage: "Move the deal's stage",
  apply_flag: "Apply a flag",
  escalate: "Escalate to the Sales Head",
  send_email: "Email staff",
};

/**
 * Said wherever an email action is offered or shown. Outbound email is not
 * switched on yet (the backend is waiting on approval), so an automation email
 * is composed and QUEUED — visible on the job's Communications and in the run
 * history — and goes out on its own the day sending exists.
 */
export const EMAIL_ACTION_HONESTY =
  "Email sending is not switched on yet. The email is written and queued now — you can see it on the job — and it goes out automatically once sending is enabled. The recipients also get an in-app notification today.";

/** Date fields a date_reached rule can watch on an account. */
export const DATE_FIELDS = [
  { key: "annual_meeting_due_on", label: "Annual meeting window" },
  { key: "reactivate_on", label: "Reactivation date" },
  { key: "approval_due_on", label: "New-lead approval deadline (7 days)" },
  { key: "ghosted_at", label: "Ghosted mark (1 month)" },
] as const;

export type DateFieldKey = (typeof DATE_FIELDS)[number]["key"];

export type AssigneeMode =
  | "account_owner"
  | "specific"
  | "sales_head"
  /** Job rules: the managers of the job's office. */
  | "office_manager"
  /** Job rules: the job's crew chief. */
  | "crew_chief"
  /** Job rules: whoever holds `job_role` on the job's assignments. */
  | "job_role";

export const JOB_ASSIGNEE_LABEL: Record<
  "office_manager" | "crew_chief" | "job_role" | "specific",
  string
> = {
  office_manager: "The office manager",
  crew_chief: "The job's crew chief",
  job_role: "A role on the job",
  specific: "A specific person",
};

export const JOB_ROLE_LABEL: Record<JobAssignmentRole, string> = {
  crew_chief: "Crew chief",
  technician: "Technician",
  lead_technician: "Lead technician",
  account_rep: "Account rep",
  project_manager: "Project manager",
  estimator: "Estimator",
  collector: "Collector",
};

export type RuleAction = {
  kind: ActionKind;
  /** create_task */
  title?: string;
  description?: string;
  priority?: Database["public"]["Enums"]["task_priority"];
  /** assign_task */
  assignee_mode?: AssigneeMode;
  assignee_user_id?: string | null;
  /** assignee_mode "job_role": which role on the job's assignments. */
  job_role?: JobAssignmentRole;
  /** set_due_date */
  due_in_days?: number;
  /** notify */
  message?: string;
  /** move_stage */
  stage_id?: string | null;
  /** apply_flag */
  flag?: string;
  /** escalate */
  after_days?: number;
};

export type RuleConditions = {
  pipeline_id?: string | null;
  stage_ids?: string[];
  owner_ids?: string[];
  lead_sources?: string[];
  account_types?: string[];
};

export type RuleTriggerConfig = {
  days?: number;
  date_field?: DateFieldKey;
  offset_days?: number;
};

/**
 * Actions have been written in two shapes over time — `{ kind, assignee_mode }`
 * from the rule editor and `{ type, assign_to, target }` from the seeded rules.
 * Everything reads them through this normaliser so an older rule still fires.
 */
export function normalizeAction(raw: unknown): RuleAction {
  const a = (raw ?? {}) as Record<string, unknown>;
  const rawKind = String(a["kind"] ?? a["type"] ?? "");
  const LEGACY: Record<string, ActionKind> = {
    flag: "apply_flag",
    task: "create_task",
    note: "notify",
    notification: "notify",
  };
  const kind = (LEGACY[rawKind] ?? rawKind) as ActionKind;
  const legacyAssign = (a["assign_to"] ?? a["target"]) as string | undefined;
  const assignee_mode =
    (a["assignee_mode"] as AssigneeMode | undefined) ??
    (legacyAssign === "record_owner" || legacyAssign === "account_owner"
      ? "account_owner"
      : legacyAssign === "sales_head" || legacyAssign === "location_manager"
        ? "sales_head"
        : undefined);
  return {
    ...(a as object),
    kind,
    ...(assignee_mode ? { assignee_mode } : {}),
    ...(a["flag"] === undefined && kind === "apply_flag" ? { flag: "high" } : {}),
  } as RuleAction;
}

export function actionsOf(rule: AutomationRule): RuleAction[] {
  return Array.isArray(rule.actions)
    ? (rule.actions as unknown[]).map(normalizeAction).filter((a) => Boolean(a.kind))
    : [];
}

export function conditionsOf(rule: AutomationRule): RuleConditions {
  return (rule.conditions ?? {}) as RuleConditions;
}

export function triggerConfigOf(rule: AutomationRule): RuleTriggerConfig {
  return (rule.trigger_config ?? {}) as RuleTriggerConfig;
}

/** One-line human summary shown on the rule card and on generated tasks. */
export function describeRule(rule: AutomationRule): string {
  const cfg = triggerConfigOf(rule);
  const acts = actionsOf(rule)
    .map((a) => ACTION_LABEL[a.kind].toLowerCase())
    .join(", ");
  const trigger = rule.trigger_type as TriggerType;
  let when = TRIGGER_LABEL[trigger].toLowerCase();
  if (trigger === "job_stage_age") {
    const n = conditionsOf(rule).stage_ids?.length ?? 0;
    when = `a job has been in ${n === 1 ? "the chosen stage" : `one of ${n} chosen stages`} for ${cfg.days ?? 7} days`;
  }
  if (rule.trigger_type === "no_activity" || rule.trigger_type === "task_past_due") {
    when = when.replace("n days", `${cfg.days ?? 14} days`);
  }
  if (rule.trigger_type === "date_reached" && cfg.date_field) {
    const f = DATE_FIELDS.find((d) => d.key === cfg.date_field);
    when = `${f?.label ?? cfg.date_field} is reached`;
  }
  return `When ${when} → ${acts || "no actions yet"}.`;
}

// ---------- CRUD ----------
export async function listRules(locationId: string | null): Promise<AutomationRule[]> {
  let q = supabase.from("automation_rules").select("*").order("run_order").order("name");
  if (locationId) q = q.or(`location_id.is.null,location_id.eq.${locationId}`);
  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}

export async function upsertRule(
  rule: Partial<AutomationRule> & { name: string; trigger_type: TriggerType },
): Promise<AutomationRule> {
  const { data, error } = await supabase
    .from("automation_rules")
    .upsert(rule as never)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function setRuleActive(id: string, isActive: boolean) {
  const { error } = await supabase
    .from("automation_rules")
    .update({ is_active: isActive })
    .eq("id", id);
  if (error) throw error;
}

export async function deleteRule(id: string) {
  const { error } = await supabase.from("automation_rules").delete().eq("id", id);
  if (error) throw error;
}

export async function listStageWindows(): Promise<StageWindow[]> {
  const { data, error } = await supabase.from("automation_stage_windows").select("*");
  if (error) throw error;
  return data ?? [];
}

export async function saveStageWindow(input: {
  id?: string;
  pipeline_id: string;
  stage_id: string;
  rot_days: number;
  escalate_days: number | null;
}) {
  const { error } = await supabase
    .from("automation_stage_windows")
    .upsert(input as never, { onConflict: "stage_id" });
  if (error) throw error;
}

export async function listRuns(limit = 20): Promise<AutomationRun[]> {
  const { data, error } = await supabase
    .from("automation_runs")
    .select("*")
    .order("started_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}

export async function listEventsForRule(ruleId: string, limit = 50): Promise<AutomationEvent[]> {
  const { data, error } = await supabase
    .from("automation_events")
    .select("*")
    .eq("rule_id", ruleId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}

/** Per-rule proof of life for the Automations page: last run, fire count. */
export type RuleStats = {
  lastRunAt: string | null;
  lastError: string | null;
  runCount: number;
  fireCount: number;
  lastFiredAt: string | null;
};

export async function ruleStats(): Promise<Record<string, RuleStats>> {
  const [runs, events] = await Promise.all([
    supabase
      .from("automation_runs")
      .select("rule_id, started_at, error")
      .order("started_at", { ascending: false })
      .limit(2000),
    supabase
      .from("automation_events")
      .select("rule_id, created_at")
      .order("created_at", { ascending: false })
      .limit(2000),
  ]);
  const out: Record<string, RuleStats> = {};
  const get = (id: string) =>
    (out[id] ??= {
      lastRunAt: null,
      lastError: null,
      runCount: 0,
      fireCount: 0,
      lastFiredAt: null,
    });
  for (const r of runs.data ?? []) {
    if (!r.rule_id) continue;
    const s = get(r.rule_id);
    s.runCount += 1;
    if (!s.lastRunAt) {
      s.lastRunAt = r.started_at;
      s.lastError = r.error;
    }
  }
  for (const e of events.data ?? []) {
    const s = get(e.rule_id);
    s.fireCount += 1;
    if (!s.lastFiredAt) s.lastFiredAt = e.created_at;
  }
  return out;
}

/** Newest automation actions across every rule — the run-history feed. */
export async function listRecentEvents(limit = 50): Promise<AutomationEvent[]> {
  const { data, error } = await supabase
    .from("automation_events")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}
