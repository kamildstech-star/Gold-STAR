ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'rep_nudge';
ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'goal_pace';
ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'account_idle';

CREATE TABLE public.rep_nudges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(user_id) ON DELETE CASCADE,
  kind text NOT NULL,
  entity_type text NOT NULL DEFAULT 'account',
  entity_id uuid,
  dedupe_key text NOT NULL,
  title text NOT NULL,
  reason text NOT NULL,
  href text,
  location_id uuid REFERENCES public.locations(id) ON DELETE SET NULL,
  nudge_count integer NOT NULL DEFAULT 1,
  last_nudged_at timestamptz NOT NULL DEFAULT now(),
  escalated_at timestamptz,
  resolved_at timestamptz,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, dedupe_key)
);

CREATE INDEX rep_nudges_open_idx ON public.rep_nudges (user_id, resolved_at);
CREATE INDEX rep_nudges_location_idx ON public.rep_nudges (location_id, resolved_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.rep_nudges TO authenticated;
GRANT ALL ON public.rep_nudges TO service_role;
ALTER TABLE public.rep_nudges ENABLE ROW LEVEL SECURITY;

CREATE POLICY rep_nudges_select ON public.rep_nudges FOR SELECT TO authenticated
USING (
  user_id = (SELECT auth.uid())
  OR public.is_privileged((SELECT auth.uid()))
  OR (location_id IS NOT NULL AND location_id IN (SELECT public.my_visible_location_ids()))
);

CREATE POLICY rep_nudges_update ON public.rep_nudges FOR UPDATE TO authenticated
USING (
  user_id = (SELECT auth.uid())
  OR public.is_privileged((SELECT auth.uid()))
  OR (location_id IS NOT NULL AND location_id IN (SELECT public.my_visible_location_ids()))
)
WITH CHECK (
  user_id = (SELECT auth.uid())
  OR public.is_privileged((SELECT auth.uid()))
  OR (location_id IS NOT NULL AND location_id IN (SELECT public.my_visible_location_ids()))
);

CREATE POLICY rep_nudges_manage ON public.rep_nudges FOR ALL TO authenticated
USING (public.is_privileged((SELECT auth.uid())))
WITH CHECK (public.is_privileged((SELECT auth.uid())));

CREATE TRIGGER touch_rep_nudges BEFORE UPDATE ON public.rep_nudges
FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

CREATE TABLE public.followup_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  trigger_event text NOT NULL CHECK (trigger_event IN ('touchpoint', 'estimate_sent')),
  touchpoint_type public.touchpoint_type,
  require_meeting_held boolean NOT NULL DEFAULT false,
  task_title text NOT NULL,
  task_description text,
  due_in_days integer NOT NULL DEFAULT 1,
  priority public.task_priority NOT NULL DEFAULT 'normal',
  is_active boolean NOT NULL DEFAULT true,
  run_order integer NOT NULL DEFAULT 100,
  created_by uuid REFERENCES public.profiles(user_id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.followup_rules TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.followup_rules TO authenticated;
GRANT ALL ON public.followup_rules TO service_role;
ALTER TABLE public.followup_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY followup_rules_select ON public.followup_rules FOR SELECT TO authenticated USING (true);
CREATE POLICY followup_rules_manage ON public.followup_rules FOR ALL TO authenticated
USING (public.is_privileged((SELECT auth.uid())))
WITH CHECK (public.is_privileged((SELECT auth.uid())));

CREATE TRIGGER touch_followup_rules BEFORE UPDATE ON public.followup_rules
FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

-- Logging a call or meeting creates the follow-up task the rule describes.
CREATE OR REPLACE FUNCTION public.tg_followup_from_touchpoint()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.followup_rules%ROWTYPE;
  acct_name text;
  acct_location uuid;
BEGIN
  IF NEW.account_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT name, location_id INTO acct_name, acct_location
  FROM public.accounts WHERE id = NEW.account_id;

  FOR r IN
    SELECT * FROM public.followup_rules
    WHERE is_active
      AND trigger_event = 'touchpoint'
      AND (touchpoint_type IS NULL OR touchpoint_type = NEW.type)
      AND (NOT require_meeting_held OR COALESCE(NEW.meeting_held, false))
    ORDER BY run_order
  LOOP
    INSERT INTO public.tasks (
      title, description, assignee, due_date, priority, status,
      entity_type, entity_id, account_id, contact_id, location_id,
      source, automation_reason, created_by, is_demo
    ) VALUES (
      replace(r.task_title, '{account}', COALESCE(acct_name, 'this account')),
      r.task_description,
      NEW.created_by,
      (CURRENT_DATE + r.due_in_days)::date,
      r.priority,
      'open',
      'account', NEW.account_id, NEW.account_id, NEW.contact_id, acct_location,
      'followup_rule',
      'Created automatically by the follow-up rule "' || r.name || '".',
      NEW.created_by,
      COALESCE(NEW.is_demo, false)
    );
  END LOOP;

  RETURN NEW;
END;
$$;

CREATE TRIGGER followup_from_touchpoint
AFTER INSERT ON public.touchpoints
FOR EACH ROW EXECUTE FUNCTION public.tg_followup_from_touchpoint();

-- Sending an estimate creates its own follow-up task.
CREATE OR REPLACE FUNCTION public.tg_followup_from_estimate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.followup_rules%ROWTYPE;
BEGIN
  IF NEW.status <> 'sent' OR OLD.status = 'sent' THEN
    RETURN NEW;
  END IF;

  FOR r IN
    SELECT * FROM public.followup_rules
    WHERE is_active AND trigger_event = 'estimate_sent'
    ORDER BY run_order
  LOOP
    INSERT INTO public.tasks (
      title, description, assignee, due_date, priority, status,
      entity_type, entity_id, account_id, job_id, location_id,
      source, automation_reason, created_by
    ) VALUES (
      replace(r.task_title, '{account}', COALESCE(NEW.customer_name, 'this estimate')),
      r.task_description,
      COALESCE(NEW.created_by, NEW.owner_id),
      (CURRENT_DATE + r.due_in_days)::date,
      r.priority,
      'open',
      'estimate', NEW.id, NEW.account_id, NEW.job_id, NEW.location_id,
      'followup_rule',
      'Created automatically by the follow-up rule "' || r.name || '".',
      COALESCE(NEW.created_by, NEW.owner_id)
    );
  END LOOP;

  RETURN NEW;
END;
$$;

CREATE TRIGGER followup_from_estimate
AFTER UPDATE OF status ON public.estimates
FOR EACH ROW EXECUTE FUNCTION public.tg_followup_from_estimate();