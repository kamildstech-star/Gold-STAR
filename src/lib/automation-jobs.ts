/**
 * Job-stage automation rules, the pure half: which jobs match, the key that
 * makes each stay fire once, who the task or email is for, and what the email
 * says. The server half (automation-jobs.server.ts) reads and writes; this
 * decides, so every rule of it is a unit test.
 *
 * David, 22 Sep: "once a job is switched from this status to 'sent to
 * adjuster' or 'invoice pending payment', automatically seven days later,
 * five days, 14 days, whatever it is, I should get an email to follow up, or
 * I should get a task to follow up."
 */

import type { AssigneeMode, JobAssignmentRole, RuleAction } from "./automation";

export type JobCandidate = {
  id: string;
  job_number: string;
  job_name: string | null;
  customer_name: string | null;
  address: string | null;
  location_id: string;
  account_id: string | null;
  stage_id: string | null;
  stage_entered_at: string | null;
  crew_chief: string | null;
};

const DAY = 86_400_000;

/** Whole days the job has sat in its current stage, or null when unknown. */
export function daysInStage(job: Pick<JobCandidate, "stage_entered_at">, now: Date): number | null {
  if (!job.stage_entered_at) return null;
  const t = new Date(job.stage_entered_at).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor((now.getTime() - t) / DAY);
}

/**
 * Is the job still in one of the rule's stages, and has it been there long
 * enough? "Still" is the whole condition: the CURRENT stage is read on every
 * sweep, so a job that moved on before the days elapsed never matches. A rule
 * with no stages chosen matches nothing — never "every job".
 */
export function jobStageMatches(
  job: Pick<JobCandidate, "stage_id" | "stage_entered_at">,
  rule: { stageIds: readonly string[]; days: number },
  now: Date,
): boolean {
  if (!job.stage_id || rule.stageIds.length === 0) return false;
  if (!rule.stageIds.includes(job.stage_id)) return false;
  const days = daysInStage(job, now);
  return days != null && days >= Math.max(0, rule.days);
}

/**
 * One key per STAY in a stage. Leaving and coming back later is a new
 * `stage_entered_at`, so it counts again; sweeping every 15 minutes during one
 * stay is the same key, so it fires once.
 */
export function jobStageDedupe(job: Pick<JobCandidate, "stage_id" | "stage_entered_at">): string {
  return `jobstage:${job.stage_id}:${job.stage_entered_at}`;
}

/**
 * The same key, on the task itself. `tasks_cadence_uniq` then makes the task
 * insert idempotent in the database, so two sweeps racing each other cannot
 * both create it — the event log's check-then-insert alone could.
 */
export function jobRuleTaskCadenceKey(ruleId: string, jobId: string, dedupe: string): string {
  return `automation:${ruleId}:${jobId}:${dedupe}`;
}

export type RecipientContext = {
  job: Pick<JobCandidate, "id" | "location_id" | "crew_chief">;
  /** location_id → manager user ids, oldest membership first. */
  managersByLocation: Map<string, string[]>;
  /** job_id → assignments on it. */
  assignmentsByJob: Map<string, { user_id: string; role: JobAssignmentRole }[]>;
};

/**
 * Who a job rule's task or email is for, as user ids.
 *
 * Staff only, by construction: every mode resolves to people in the system,
 * and the database refuses a rule that carries a typed address.
 */
export function resolveJobRecipients(action: RuleAction, ctx: RecipientContext): string[] {
  const mode = (action.assignee_mode ?? "office_manager") as AssigneeMode;
  let ids: (string | null | undefined)[] = [];
  if (mode === "specific") ids = [action.assignee_user_id];
  else if (mode === "crew_chief") ids = [ctx.job.crew_chief];
  else if (mode === "job_role") {
    ids = (ctx.assignmentsByJob.get(ctx.job.id) ?? [])
      .filter((a) => a.role === action.job_role)
      .map((a) => a.user_id);
  } else ids = ctx.managersByLocation.get(ctx.job.location_id) ?? [];
  return [...new Set(ids.filter((x): x is string => !!x))];
}

/** A task has one assignee: the first recipient, or the office queue when none. */
export function taskAssignee(recipients: readonly string[]): string | null {
  return recipients[0] ?? null;
}

export function jobLabel(
  job: Pick<JobCandidate, "job_number" | "job_name" | "customer_name">,
): string {
  const name = job.job_name?.trim() || job.customer_name?.trim();
  return name ? `${job.job_number} — ${name}` : job.job_number;
}

/** The `job_followup` template's blanks. */
export function jobFollowupMergeData(input: {
  job: JobCandidate;
  stageName: string;
  days: number;
  ruleName: string;
  appOrigin: string;
  companyName: string;
  companyPhone: string | null;
}): Record<string, string> {
  const data: Record<string, string> = {
    rule_name: input.ruleName,
    job_number: input.job.job_number,
    job_name: input.job.job_name?.trim() || input.job.customer_name?.trim() || input.job.job_number,
    job_address: input.job.address?.trim() || "no address on file",
    stage_name: input.stageName,
    days_in_stage: String(input.days),
    job_link: `${input.appOrigin.replace(/\/$/, "")}/jobs/${input.job.id}`,
    company_name: input.companyName,
  };
  if (input.companyPhone) data.company_phone = input.companyPhone;
  return data;
}

/** The sentence a generated task and the run history carry. */
export function jobRuleReason(stageName: string, days: number): string {
  return `In ${stageName} for ${days} day${days === 1 ? "" : "s"}`;
}
