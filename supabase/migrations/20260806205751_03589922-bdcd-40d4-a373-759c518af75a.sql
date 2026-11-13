-- 1. Leads Inbox holds both kinds of intake record.
ALTER TABLE public.fire_leads
  ADD COLUMN IF NOT EXISTS intake_kind text NOT NULL DEFAULT 'sourced',
  ADD COLUMN IF NOT EXISTS approval_state text NOT NULL DEFAULT 'not_required',
  ADD COLUMN IF NOT EXISTS approval_due_on date,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES public.profiles(user_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;

ALTER TABLE public.fire_leads DROP CONSTRAINT IF EXISTS fire_leads_intake_kind_check;
ALTER TABLE public.fire_leads ADD CONSTRAINT fire_leads_intake_kind_check
  CHECK (intake_kind IN ('sourced','rep_entered'));
ALTER TABLE public.fire_leads DROP CONSTRAINT IF EXISTS fire_leads_approval_state_check;
ALTER TABLE public.fire_leads ADD CONSTRAINT fire_leads_approval_state_check
  CHECK (approval_state IN ('not_required','pending','approved','escalated'));

CREATE INDEX IF NOT EXISTS fire_leads_approval_idx
  ON public.fire_leads (approval_state) WHERE approval_state IN ('pending','escalated');
CREATE INDEX IF NOT EXISTS fire_leads_is_demo_idx ON public.fire_leads (is_demo) WHERE is_demo;

-- 2. Demo flags so the one-action purge still reaches every seeded module.
ALTER TABLE public.projects          ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;
ALTER TABLE public.project_members   ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;
ALTER TABLE public.photo_folders     ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;
ALTER TABLE public.photos            ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;
ALTER TABLE public.vehicles          ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;
ALTER TABLE public.vehicle_positions ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;
ALTER TABLE public.email_messages    ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;
ALTER TABLE public.calendar_events   ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;
ALTER TABLE public.escalation_rules  ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;
ALTER TABLE public.job_reports       ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;
ALTER TABLE public.commission_plans  ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;
ALTER TABLE public.pay_structures    ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;
ALTER TABLE public.reminders         ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;
ALTER TABLE public.share_links       ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;

-- 3. Purge order: children before parents.
CREATE OR REPLACE FUNCTION public.demo_tables()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ARRAY[
    'feature_request_status_history','feature_request_comments','feature_request_votes','feature_requests',
    'gift_campaign_recipients','gift_sends','gift_campaigns','gift_catalog',
    'automation_events','automation_rules',
    'escalation_events','escalation_rules',
    'incident_events','incidents',
    'money_events','invoice_payments','invoices',
    'quote_line_items','quotes',
    'share_links','documents','vendor_documents',
    'photos','photo_folders','project_members','projects',
    'equipment_placements','equipment',
    'time_entries','shifts',
    'vehicle_positions','vehicles',
    'commission_plans','pay_structures',
    'reminders','tasks','notifications',
    'job_reports','job_assignments','job_contacts','job_notes','job_status_history','jobs',
    'email_messages','calendar_events',
    'captured_communications','touchpoints','account_notes','account_stage_history','contacts',
    'goals','expense_requests','expenses',
    'accounts',
    'lead_tags','contact_attempts','lead_notes','fire_leads',
    'location_members','user_roles','profiles'
  ]::text[];
$$;

-- 4. The Prospecting board starts at Ready; intake lives in the inbox.
UPDATE public.pipeline_stages
   SET is_active = false
 WHERE pipeline_id = '22222222-2222-4222-8222-222222222222'
   AND key IN ('leads','new_lead_input');

-- 5. Conversion is the boundary between inbox and board.
CREATE OR REPLACE FUNCTION public.convert_lead_to_opportunity(_lead_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _lead public.fire_leads%ROWTYPE;
  _uid uuid := auth.uid();
  _account_id uuid;
  _origin uuid;
  _name text;
  _pipeline uuid;
  _stage uuid;
BEGIN
  SELECT * INTO _lead FROM public.fire_leads WHERE id = _lead_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Lead not found'; END IF;
  IF NOT public.can_view_lead(_uid, _lead_id) THEN RAISE EXCEPTION 'Not permitted'; END IF;
  IF _lead.account_id IS NOT NULL THEN RETURN _lead.account_id; END IF;
  IF _lead.location_id IS NULL THEN RAISE EXCEPTION 'Lead has no location; assign one before converting'; END IF;

  _pipeline := public.default_pipeline_for(_lead.location_id, 'account');
  SELECT id INTO _stage FROM public.pipeline_stages
   WHERE pipeline_id = _pipeline AND key = 'ready';
  IF _stage IS NULL THEN
    SELECT id INTO _stage FROM public.pipeline_stages
     WHERE pipeline_id = _pipeline AND is_active ORDER BY sort_order LIMIT 1;
  END IF;

  _origin := NULLIF(_lead.source_ref->>'origin_account_id','')::uuid;

  IF _origin IS NOT NULL AND EXISTS (SELECT 1 FROM public.accounts WHERE id = _origin) THEN
    -- Migrated intake record: the account already carries the history.
    UPDATE public.accounts
       SET stage_id = _stage,
           pipeline_id = _pipeline,
           status = 'prospect',
           approval_state = CASE WHEN approval_state = 'not_required' THEN 'not_required' ELSE 'approved' END,
           approved_at = CASE WHEN approval_state = 'not_required' THEN approved_at ELSE now() END,
           approved_by = CASE WHEN approval_state = 'not_required' THEN approved_by ELSE _uid END,
           assigned_rep = COALESCE(assigned_rep, _lead.assigned_rep, _uid),
           archived_at = NULL,
           archived_by = NULL
     WHERE id = _origin;
    _account_id := _origin;
  ELSE
    _name := COALESCE(NULLIF(btrim(_lead.org_name), ''), NULLIF(btrim(_lead.title), ''),
                      NULLIF(btrim(_lead.owner_name), ''), NULLIF(btrim(_lead.address), ''), 'Untitled opportunity');

    INSERT INTO public.accounts (name, location_id, assigned_rep, status, stage_id, pipeline_id,
                                 estimated_annual_value, notes, created_by, is_demo,
                                 approval_state, approved_at, approved_by)
    VALUES (_name, _lead.location_id, COALESCE(_lead.assigned_rep, _uid), 'prospect', _stage, _pipeline,
            _lead.value_amount, NULLIF(btrim(concat_ws(E'\n',
              CASE WHEN _lead.address IS NOT NULL THEN 'Property: ' || _lead.address END,
              CASE WHEN _lead.source_system <> 'manual' THEN 'Source: ' || _lead.source_system END)), ''),
            _uid, _lead.is_demo,
            CASE WHEN _lead.approval_state IN ('pending','escalated') THEN 'approved' ELSE 'not_required' END,
            CASE WHEN _lead.approval_state IN ('pending','escalated') THEN now() ELSE NULL END,
            CASE WHEN _lead.approval_state IN ('pending','escalated') THEN _uid ELSE NULL END)
    RETURNING id INTO _account_id;

    IF COALESCE(btrim(_lead.contact_name), '') <> '' THEN
      INSERT INTO public.contacts (account_id, full_name, email, phone, is_primary, created_by, is_demo)
      VALUES (_account_id, _lead.contact_name, _lead.contact_email, _lead.contact_phone, true, _uid, _lead.is_demo);
    END IF;
  END IF;

  INSERT INTO public.account_tags (account_id, tag_id, created_by)
  SELECT _account_id, lt.tag_id, _uid FROM public.lead_tags lt WHERE lt.lead_id = _lead_id
  ON CONFLICT DO NOTHING;

  INSERT INTO public.account_notes (account_id, body, created_by, created_at, is_demo)
  SELECT _account_id, ln.body, ln.author_id, ln.created_at, ln.is_demo
  FROM public.lead_notes ln WHERE ln.lead_id = _lead_id;

  INSERT INTO public.account_notes (account_id, body, created_by, is_demo)
  VALUES (_account_id,
          'Converted from the Leads Inbox at Ready' ||
          CASE WHEN _lead.intake_kind = 'rep_entered' THEN ' (rep-entered lead, approved by Sales Head)' ELSE '' END ||
          CASE WHEN _lead.address IS NOT NULL THEN ' — ' || _lead.address ELSE '' END,
          _uid, _lead.is_demo);

  UPDATE public.fire_leads
     SET account_id = _account_id,
         approval_state = CASE WHEN approval_state IN ('pending','escalated') THEN 'approved' ELSE approval_state END,
         approved_at = COALESCE(approved_at, now()),
         approved_by = COALESCE(approved_by, _uid),
         archived_at = COALESCE(archived_at, now()),
         archived_by = COALESCE(archived_by, _uid)
   WHERE id = _lead_id;

  RETURN _account_id;
END;
$$;