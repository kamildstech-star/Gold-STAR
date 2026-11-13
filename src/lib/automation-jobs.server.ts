/**
 * Job-stage automation rules, the server half. Called by the automation
 * engine for a rule whose trigger is `job_stage_age`, with the service role —
 * the engine's every-15-minutes pg_cron sweep ('run-automations-15min') is
 * what makes "seven days later" happen whether or not the app is open.
 *
 * Decisions live in automation-jobs.ts. This file reads jobs, claims each
 * (rule, job, stay, action) exactly once, and writes the task or the email.
 *
 * INTERNAL ONLY, still: a task, an in-app notification, and an email to STAFF
 * resolved from a role or a named person. No address is ever read off a rule.
 */

import { serverAppOrigin } from "./app-origin";
import { renderEmailTemplate } from "./email-templates";
import {
  daysInStage,
  jobFollowupMergeData,
  jobLabel,
  jobRuleReason,
  jobRuleTaskCadenceKey,
  jobStageDedupe,
  jobStageMatches,
  resolveJobRecipients,
  taskAssignee,
  type JobCandidate,
} from "./automation-jobs";
import type {
  JobAssignmentRole,
  RuleAction,
  RuleConditions,
  RuleTriggerConfig,
} from "./automation";

type Db = Awaited<typeof import("@/integrations/supabase/client.server")>["supabaseAdmin"];

type Rule = {
  id: string;
  name: string;
  location_id: string | null;
  trigger_config: unknown;
  conditions: unknown;
};

function isoDatePlus(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// The public address goes in every link an automation sends (job_link).
const appOrigin = () => serverAppOrigin();

export type DeliveryOutcome = { delivered: boolean; via: "queued" | "backend"; note: string };

/**
 * THE DELIVERY SEAM for automation email — one function, the only place that
 * decides whether a queued email leaves the building.
 *
 * TODAY it leaves the row 'queued'. Outbound sending is blocked on the email
 * backend being approved (the same block the vendor order's
 * deliverVendorOrder documents), and an automation that silently sent mail on
 * a server nobody signed off would be the wrong way round. The day sending is
 * approved, this becomes a call to sendViaResend (email.server.ts) and a
 * status update to 'sent' — nothing that composes or queues changes.
 */
export async function deliverAutomationEmail(_db: Db, _emailId: string): Promise<DeliveryOutcome> {
  return {
    delivered: false,
    via: "queued",
    note: "Queued. Outbound email is not switched on yet; it will send once it is.",
  };
}

export async function runJobStageRule(input: {
  db: Db;
  rule: Rule;
  actions: RuleAction[];
  runId: string | null;
  triggeredBy: string | null;
  now: Date;
}): Promise<{ evaluated: number; matched: number; actions: number }> {
  const { db, rule, actions, now } = input;
  const cfg = (rule.trigger_config ?? {}) as RuleTriggerConfig;
  const cond = (rule.conditions ?? {}) as RuleConditions;
  const stageIds = cond.stage_ids ?? [];
  const days = Math.max(0, Number(cfg.days ?? 7) || 0);
  if (stageIds.length === 0 || actions.length === 0)
    return { evaluated: 0, matched: 0, actions: 0 };

  // Only jobs that can match: in a chosen stage and in it since before the cutoff.
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  let jobsQ = db
    .from("jobs")
    .select(
      "id, job_number, job_name, customer_name, address, location_id, account_id, stage_id, stage_entered_at, crew_chief",
    )
    .in("stage_id", stageIds)
    .lte("stage_entered_at", cutoff);
  if (rule.location_id) jobsQ = jobsQ.eq("location_id", rule.location_id);
  const { data: jobRows, error: jobsErr } = await jobsQ;
  if (jobsErr) throw jobsErr;
  const jobs = ((jobRows ?? []) as JobCandidate[]).filter((j) =>
    jobStageMatches(j, { stageIds, days }, now),
  );
  if (jobs.length === 0) return { evaluated: (jobRows ?? []).length, matched: 0, actions: 0 };

  const locationIds = [...new Set(jobs.map((j) => j.location_id))];
  const jobIds = jobs.map((j) => j.id);
  const [
    { data: stages },
    { data: managers },
    { data: assignments },
    { data: offices },
    { data: templates },
  ] = await Promise.all([
    db.from("pipeline_stages").select("id, name").in("id", stageIds),
    db
      .from("location_members")
      .select("location_id, user_id, created_at")
      .in("location_id", locationIds)
      .eq("role", "manager")
      .order("created_at"),
    db.from("job_assignments").select("job_id, user_id, role").in("job_id", jobIds),
    db.from("locations").select("id, name, legal_entity_name, office_phone").in("id", locationIds),
    db
      .from("email_templates")
      .select("key, subject, body, is_active, location_id")
      .eq("key", "job_followup"),
  ]);

  const stageName = new Map((stages ?? []).map((s) => [s.id, s.name as string]));
  const managersByLocation = new Map<string, string[]>();
  for (const m of managers ?? []) {
    managersByLocation.set(m.location_id, [
      ...(managersByLocation.get(m.location_id) ?? []),
      m.user_id,
    ]);
  }
  const assignmentsByJob = new Map<string, { user_id: string; role: JobAssignmentRole }[]>();
  for (const a of assignments ?? []) {
    assignmentsByJob.set(a.job_id, [
      ...(assignmentsByJob.get(a.job_id) ?? []),
      { user_id: a.user_id, role: a.role as JobAssignmentRole },
    ]);
  }
  const officeById = new Map((offices ?? []).map((o) => [o.id, o]));

  let actionCount = 0;
  for (const job of jobs) {
    const dedupeBase = jobStageDedupe(job);
    const inDays = daysInStage(job, now) ?? days;
    const stage = stageName.get(job.stage_id ?? "") ?? "its stage";
    const reason = jobRuleReason(stage, inDays);
    const label = jobLabel(job);

    for (const action of actions) {
      const dedupe = `${dedupeBase}:${action.kind}`;
      const recipients = resolveJobRecipients(action, {
        job,
        managersByLocation,
        assignmentsByJob,
      });

      /*
       * CLAIM FIRST. The event row is the lock: its UNIQUE (rule_id,
       * record_id, dedupe_key) means only one sweep can insert it, and only
       * that sweep acts. The account branch checks then acts, which a cron
       * run and an event-driven run can both pass at once.
       */
      const { data: claimed, error: claimErr } = await db
        .from("automation_events")
        .insert({
          rule_id: rule.id,
          run_id: input.runId,
          record_type: "job",
          record_id: job.id,
          record_label: label,
          action_kind: action.kind as never,
          reason,
          target_user_id: recipients[0] ?? null,
          location_id: job.location_id,
          dedupe_key: dedupe,
        })
        .select("id")
        .single();
      if (claimErr) {
        if (claimErr.code === "23505") continue; // already done for this stay
        throw claimErr;
      }

      try {
        if (action.kind === "create_task" || action.kind === "assign_task") {
          const assignee = taskAssignee(recipients);
          const title = action.title?.trim() || `Follow up: ${label} — ${reason.toLowerCase()}`;
          const { data: task, error: taskErr } = await db
            .from("tasks")
            .insert({
              title,
              description: action.description ?? `${reason}. Rule: ${rule.name}.`,
              assignee,
              due_date: isoDatePlus(action.due_in_days ?? 0),
              priority: action.priority ?? "normal",
              status: "open",
              entity_type: "job",
              entity_id: job.id,
              job_id: job.id,
              account_id: job.account_id,
              location_id: job.location_id,
              source: "automation",
              automation_rule_id: rule.id,
              automation_reason: reason,
              cadence_key: jobRuleTaskCadenceKey(rule.id, job.id, dedupeBase),
              created_by: input.triggeredBy ?? null,
            })
            .select("id")
            .single();
          if (taskErr && taskErr.code !== "23505") throw taskErr;
          if (task?.id) {
            await db.from("automation_events").update({ task_id: task.id }).eq("id", claimed.id);
            if (assignee) {
              await db.from("notifications").insert({
                user_id: assignee,
                type: "automation_task",
                title,
                body: `${reason} (rule: ${rule.name})`,
                entity_type: "task",
                entity_id: task.id,
                href: `/jobs/${job.id}`,
                priority: "normal",
              });
            }
          }
        } else if (action.kind === "send_email") {
          const { data: people } = recipients.length
            ? await db.from("profiles").select("user_id, email").in("user_id", recipients)
            : { data: [] as { user_id: string; email: string | null }[] };
          const to = [
            ...new Set((people ?? []).map((p) => p.email?.trim()).filter(Boolean)),
          ] as string[];
          const office = officeById.get(job.location_id);
          // An office's own wording first, then the company's, then the default.
          const own = (templates ?? []).filter((t) => t.location_id === job.location_id);
          const shared = (templates ?? []).filter((t) => !t.location_id);
          const rendered = renderEmailTemplate(
            "job_followup",
            jobFollowupMergeData({
              job,
              stageName: stage,
              days: inDays,
              ruleName: rule.name,
              appOrigin: appOrigin(),
              companyName:
                office?.legal_entity_name?.trim() || office?.name || "Gold Star Restoration",
              companyPhone: office?.office_phone ?? null,
            }),
            own.length ? own : shared,
          );
          const { data: email, error: emailErr } = await db
            .from("email_messages")
            .insert({
              job_id: job.id,
              account_id: job.account_id,
              location_id: job.location_id,
              template_key: "job_followup",
              category: "notification",
              to_emails: to,
              subject: rendered.subject,
              body_html: rendered.body,
              status: "queued",
              error: to.length ? null : "No staff email on file for the chosen recipients.",
            })
            .select("id")
            .single();
          if (emailErr) throw emailErr;
          const outcome = await deliverAutomationEmail(db, email.id);
          // Today the email waits; the people it is for still hear about it now.
          for (const userId of recipients) {
            await db.from("notifications").insert({
              user_id: userId,
              type: "automation_task",
              title: `Follow up: ${label}`,
              body: `${reason} (rule: ${rule.name}). ${outcome.note}`,
              entity_type: "job",
              entity_id: job.id,
              href: `/jobs/${job.id}`,
              priority: "normal",
            });
          }
        } else if (action.kind === "notify") {
          for (const userId of recipients) {
            await db.from("notifications").insert({
              user_id: userId,
              type: "automation_task",
              title: `${rule.name}: ${label}`,
              body: action.message ? `${action.message} — ${reason}` : reason,
              entity_type: "job",
              entity_id: job.id,
              href: `/jobs/${job.id}`,
              priority: "normal",
            });
          }
        }
      } catch (err) {
        // Release the claim, so the next sweep retries instead of believing
        // this stay was handled. The run history records the error.
        await db.from("automation_events").delete().eq("id", claimed.id);
        throw err;
      }
      actionCount += 1;
    }
  }

  return { evaluated: (jobRows ?? []).length, matched: jobs.length, actions: actionCount };
}
