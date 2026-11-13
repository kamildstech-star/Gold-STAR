-- Automations for JOBS: "in this stage for N days" -> a task and/or an email.
--
-- David, 22 Sep: "New rule — I can't create my rules that I want to create.
-- Like: once a job is switched from this status to 'sent to adjuster' or
-- 'invoice pending payment', automatically seven days later, five days, 14
-- days, whatever it is, I should get an email to follow up, or I should get a
-- task to follow up."
--
-- The Automations engine (20260806173113) only ever looked at sales accounts.
-- This adds one trigger and one action to the SAME engine, rules table, run
-- history and event log — not a second automation system:
--
--   * trigger `job_stage_age`: the job's CURRENT stage is one of the rule's
--     stages and it entered it at least N days ago (jobs.stage_entered_at).
--     Evaluated by the existing every-15-minutes pg_cron sweep
--     ('run-automations-15min', 20260903200000), so it fires whether or not
--     anybody has the app open. Reading the current stage each sweep is what
--     makes "if the job is still in that status" true: a job that moved on is
--     simply not a match.
--   * action `send_email`: to STAFF — a role on the job or a named person.
--     Composed through the email template engine (key 'job_followup') into
--     email_messages as 'queued'. Nothing leaves the building until the
--     outbound email backend is approved; the delivery seam is
--     deliverAutomationEmail in src/lib/automation-jobs.server.ts.

-- 1. The enum values. Added, never used, in this migration, so they need no
-- second transaction.
ALTER TYPE public.automation_trigger ADD VALUE IF NOT EXISTS 'job_stage_age';
ALTER TYPE public.automation_action_kind ADD VALUE IF NOT EXISTS 'send_email';

-- 2. The validator keeps "internal only" true.
-- It used to refuse any action that could send anything. An email to a
-- colleague is internal, so send_email is allowed — but ONLY with a recipient
-- the engine resolves to staff itself (a role on the job, the office's
-- managers, or a named user id). A rule can never carry an address typed into
-- it, so no rule can ever email a client, which was the point of the block.
CREATE OR REPLACE FUNCTION public.tg_automation_rules_validate()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $$
DECLARE a jsonb;
BEGIN
  IF jsonb_typeof(NEW.actions) <> 'array' THEN
    RAISE EXCEPTION 'actions must be a JSON array';
  END IF;
  FOR a IN SELECT * FROM jsonb_array_elements(NEW.actions) LOOP
    IF NOT ((a->>'kind') = ANY (ARRAY['create_task','assign_task','set_due_date','notify','move_stage','apply_flag','escalate','send_email'])) THEN
      RAISE EXCEPTION 'Unsupported automation action "%". Automation is internal-only: it may never contact a client.', a->>'kind';
    END IF;
    IF (a->>'kind') = 'send_email' THEN
      IF a ? 'to' OR a ? 'to_emails' OR a ? 'email' THEN
        RAISE EXCEPTION 'An automation email goes to staff chosen by role or person, never to a typed address.';
      END IF;
      IF NOT (coalesce(a->>'assignee_mode', '') = ANY (ARRAY['office_manager','crew_chief','job_role','specific'])) THEN
        RAISE EXCEPTION 'An automation email needs a staff recipient: a role on the job, the office managers or a named person.';
      END IF;
    END IF;
  END LOOP;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- 3. The wording, seeded like every other engine key (20260918140000), and
-- the same strings as EMAIL_TEMPLATE_DEFAULTS.job_followup. An office that
-- writes its own keeps it.
INSERT INTO public.email_templates (key, name, category, subject, body, is_active)
VALUES
  (
    'job_followup',
    'Job follow-up (automation)',
    'notification',
    'Follow up: job {{job_number}} has been {{stage_name}} for {{days_in_stage}} days',
    concat_ws(E'\n',
      '<p>Job {{job_number}} ({{job_name}}, {{job_address}}) has been in <b>{{stage_name}}</b> for {{days_in_stage}} days.</p>',
      '<p>Time to follow up. Open the job: {{job_link}}</p>',
      '<p>Sent by the automation rule {{rule_name}}.</p>',
      '<p>{{company_name}}</p>'
    ),
    true
  )
ON CONFLICT DO NOTHING;

-- 4. Nothing else changes shape. A job rule is an automation_rules row with
-- trigger_type 'job_stage_age', its stages in conditions.stage_ids and its
-- delay in trigger_config.days; RLS on rules, runs and events is untouched.
-- One event per (rule, job, stage entry, action) — the UNIQUE key the table
-- already has — so re-entering the stage later fires again, and nothing fires
-- twice for one stay.
