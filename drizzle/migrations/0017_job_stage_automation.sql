ALTER TYPE public.automation_trigger ADD VALUE IF NOT EXISTS 'job_stage_age';
ALTER TYPE public.automation_action_kind ADD VALUE IF NOT EXISTS 'send_email';
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