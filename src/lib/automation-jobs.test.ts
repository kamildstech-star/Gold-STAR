import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { EMAIL_TEMPLATE_DEFAULTS, renderEmailTemplate } from "./email-templates";
import {
  jobFollowupMergeData,
  jobRuleTaskCadenceKey,
  jobStageDedupe,
  jobStageMatches,
  resolveJobRecipients,
  taskAssignee,
  type JobCandidate,
} from "./automation-jobs";
import { TRIGGERS, isJobTrigger, describeRule } from "./automation";

/**
 * David, 22 Sep: "once a job is switched from this status to 'sent to
 * adjuster' or 'invoice pending payment', automatically seven days later, five
 * days, 14 days, whatever it is, I should get an email to follow up, or I
 * should get a task to follow up."
 */

const now = new Date("2026-09-30T15:00:00Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();
const PENDING = "stage-invoice-pending";
const job = (over: Partial<JobCandidate> = {}): JobCandidate => ({
  id: "j1",
  job_number: "J-1001",
  job_name: "1309 Ridge Avenue",
  customer_name: "Smith",
  address: "1309 Ridge Ave, Lakewood, NJ",
  location_id: "lw",
  account_id: null,
  stage_id: PENDING,
  stage_entered_at: daysAgo(7),
  crew_chief: "chief",
  ...over,
});
const rule = { stageIds: [PENDING], days: 7 };

describe("when a job rule fires", () => {
  it("fires N days after the job entered the stage", () => {
    expect(jobStageMatches(job({ stage_entered_at: daysAgo(7) }), rule, now)).toBe(true);
    expect(jobStageMatches(job({ stage_entered_at: daysAgo(6) }), rule, now)).toBe(false);
  });

  it("does not fire for a job that moved on before the days elapsed", () => {
    expect(jobStageMatches(job({ stage_id: "stage-paid" }), rule, now)).toBe(false);
  });

  it("never matches every job when no stage was chosen", () => {
    expect(jobStageMatches(job(), { stageIds: [], days: 0 }, now)).toBe(false);
  });

  it("fires once per stay, and again on a new stay", () => {
    const first = jobStageDedupe(job({ stage_entered_at: "2026-09-01T00:00:00Z" }));
    expect(jobStageDedupe(job({ stage_entered_at: "2026-09-01T00:00:00Z" }))).toBe(first);
    expect(jobStageDedupe(job({ stage_entered_at: "2026-09-20T00:00:00Z" }))).not.toBe(first);
    expect(jobRuleTaskCadenceKey("r1", "j1", first)).toBe(`automation:r1:j1:${first}`);
  });
});

describe("who it is for — staff only", () => {
  const ctx = {
    job: job(),
    managersByLocation: new Map([["lw", ["mgr-1", "mgr-2"]]]),
    assignmentsByJob: new Map([["j1", [{ user_id: "pm-1", role: "project_manager" as const }]]]),
  };

  it("office manager: the office's managers, first one gets the task", () => {
    const r = resolveJobRecipients({ kind: "create_task", assignee_mode: "office_manager" }, ctx);
    expect(r).toEqual(["mgr-1", "mgr-2"]);
    expect(taskAssignee(r)).toBe("mgr-1");
  });

  it("crew chief, a role on the job, or a named person", () => {
    expect(resolveJobRecipients({ kind: "send_email", assignee_mode: "crew_chief" }, ctx)).toEqual([
      "chief",
    ]);
    expect(
      resolveJobRecipients(
        { kind: "send_email", assignee_mode: "job_role", job_role: "project_manager" },
        ctx,
      ),
    ).toEqual(["pm-1"]);
    expect(
      resolveJobRecipients(
        { kind: "send_email", assignee_mode: "specific", assignee_user_id: "u9" },
        ctx,
      ),
    ).toEqual(["u9"]);
  });

  it("an office with no manager gets an unassigned task, not a crash", () => {
    const none = { ...ctx, managersByLocation: new Map() };
    expect(taskAssignee(resolveJobRecipients({ kind: "create_task" }, none))).toBeNull();
  });
});

describe("the follow-up email", () => {
  it("renders the default wording with every blank filled", () => {
    const data = jobFollowupMergeData({
      job: job(),
      stageName: "Invoice pending payment",
      days: 7,
      ruleName: "Unpaid invoice follow-up",
      appOrigin: "https://hub.example/",
      companyName: "Gold Star Restoration",
      companyPhone: null,
    });
    const out = renderEmailTemplate("job_followup", data);
    expect(out.unresolved).toEqual([]);
    expect(out.subject).toBe("Follow up: job J-1001 has been Invoice pending payment for 7 days");
    expect(out.body).toContain("https://hub.example/jobs/j1");
    expect(EMAIL_TEMPLATE_DEFAULTS.job_followup.category).toBe("notification");
  });
});

describe("the vocabulary", () => {
  it("offers the job trigger beside the sales ones", () => {
    expect(TRIGGERS).toContain("job_stage_age");
    expect(isJobTrigger("job_stage_age")).toBe(true);
    expect(isJobTrigger("stage_rot")).toBe(false);
  });

  it("describes a job rule in words", () => {
    const d = describeRule({
      trigger_type: "job_stage_age",
      trigger_config: { days: 7 },
      conditions: { stage_ids: ["a"] },
      actions: [{ kind: "create_task" }],
    } as never);
    expect(d).toBe("When a job has been in the chosen stage for 7 days → create a task.");
  });
});

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const SQL = read("supabase/migrations/20260926121000_job_stage_automation.sql");
const SERVER = read("src/lib/automation-jobs.server.ts");
const ENGINE = read("src/lib/automation-engine.server.ts");
const HOOK = read("src/routes/api/public/hooks/run-automations.ts");

describe("the database keeps email internal", () => {
  it("adds the trigger and the action", () => {
    expect(SQL).toContain(
      "ALTER TYPE public.automation_trigger ADD VALUE IF NOT EXISTS 'job_stage_age';",
    );
    expect(SQL).toContain(
      "ALTER TYPE public.automation_action_kind ADD VALUE IF NOT EXISTS 'send_email';",
    );
  });

  it("refuses a typed address and demands a staff recipient", () => {
    const fn = SQL.match(
      /CREATE OR REPLACE FUNCTION public\.tg_automation_rules_validate[\s\S]*?END \$\$;/,
    )![0];
    expect(fn).toContain("IF a ? 'to' OR a ? 'to_emails' OR a ? 'email' THEN");
    expect(fn).toContain("ARRAY['office_manager','crew_chief','job_role','specific']");
  });
});

describe("the evaluator", () => {
  it("is the engine's own sweep, reached from the cron hook", () => {
    expect(ENGINE).toContain('if ((rule.trigger_type as TriggerType) === "job_stage_age") {');
    expect(HOOK).toContain('"job_stage_age",');
  });

  it("claims each (rule, job, stay, action) before acting, and releases on failure", () => {
    const claim = SERVER.indexOf('.from("automation_events")\n        .insert({');
    const task = SERVER.indexOf('.from("tasks")');
    expect(claim).toBeGreaterThan(-1);
    expect(task).toBeGreaterThan(claim);
    expect(SERVER).toContain('if (claimErr.code === "23505") continue;');
    expect(SERVER).toContain('await db.from("automation_events").delete().eq("id", claimed.id);');
  });

  it("queues the email and goes through the one delivery seam", () => {
    expect(SERVER).toContain('status: "queued",');
    expect(SERVER).toContain("const outcome = await deliverAutomationEmail(db, email.id);");
    expect(SERVER).toMatch(/renderEmailTemplate\(\s*"job_followup",/);
  });
});
