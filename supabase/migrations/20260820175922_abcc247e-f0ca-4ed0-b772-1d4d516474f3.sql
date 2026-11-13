-- Classification lists become free text keys backed by option_list_values.
-- True state machines (job_status, invoice_status, incident_status, ...) stay enums.

DROP VIEW IF EXISTS public.account_fire_rollup;
DROP INDEX IF EXISTS public.account_notes_pending_idx;
DROP TRIGGER IF EXISTS trg_jobs_sync_loss_type ON public.jobs;
DROP TRIGGER IF EXISTS trg_projects_sync_loss_type ON public.projects;
DROP TRIGGER IF EXISTS incidents_classify_trg ON public.incidents;

-- accounts.account_type
ALTER TABLE public.accounts ALTER COLUMN account_type DROP DEFAULT;
ALTER TABLE public.accounts ALTER COLUMN account_type TYPE text USING account_type::text;
ALTER TABLE public.accounts ALTER COLUMN account_type SET DEFAULT 'property_management';

-- jobs / projects loss_type
ALTER TABLE public.jobs ALTER COLUMN loss_type TYPE text USING loss_type::text;
ALTER TABLE public.projects ALTER COLUMN loss_type TYPE text USING loss_type::text;

-- equipment
ALTER TABLE public.equipment ALTER COLUMN equipment_type TYPE text USING equipment_type::text;

-- contacts
ALTER TABLE public.contacts ALTER COLUMN decision_role TYPE text USING decision_role::text;

-- job assignments
ALTER TABLE public.job_assignments ALTER COLUMN role TYPE text USING role::text;

-- incidents
ALTER TABLE public.incidents ALTER COLUMN incident_type DROP DEFAULT;
ALTER TABLE public.incidents ALTER COLUMN incident_type TYPE text USING incident_type::text;
ALTER TABLE public.incidents ALTER COLUMN incident_type SET DEFAULT 'fire';

-- quote line items
ALTER TABLE public.quote_line_items ALTER COLUMN category DROP DEFAULT;
ALTER TABLE public.quote_line_items ALTER COLUMN category TYPE text USING category::text;
ALTER TABLE public.quote_line_items ALTER COLUMN category SET DEFAULT 'other';

-- gifts
ALTER TABLE public.gift_campaigns ALTER COLUMN occasion DROP DEFAULT;
ALTER TABLE public.gift_campaigns ALTER COLUMN occasion TYPE text USING occasion::text;
ALTER TABLE public.gift_campaigns ALTER COLUMN occasion SET DEFAULT 'birthday';
ALTER TABLE public.seasonal_sends ALTER COLUMN occasion DROP DEFAULT;
ALTER TABLE public.seasonal_sends ALTER COLUMN occasion TYPE text USING occasion::text;
ALTER TABLE public.seasonal_sends ALTER COLUMN occasion SET DEFAULT 'seasonal';

-- expenses
ALTER TABLE public.expense_requests ALTER COLUMN kind DROP DEFAULT;
ALTER TABLE public.expense_requests ALTER COLUMN kind TYPE text USING kind::text;
ALTER TABLE public.expense_requests ALTER COLUMN kind SET DEFAULT 'company_card';
ALTER TABLE public.expenses ALTER COLUMN kind TYPE text USING kind::text;

-- reassignments
ALTER TABLE public.deal_reassignments ALTER COLUMN reason TYPE text USING reason::text;
ALTER TABLE public.reassignment_batches ALTER COLUMN reason TYPE text USING reason::text;

-- account note triggers
ALTER TABLE public.account_notes ALTER COLUMN trigger_type DROP DEFAULT;
ALTER TABLE public.account_notes ALTER COLUMN trigger_type TYPE text USING trigger_type::text;
ALTER TABLE public.account_notes ALTER COLUMN trigger_type SET DEFAULT 'none';

-- sales type
ALTER TABLE public.sales_type_assignments ALTER COLUMN sales_type TYPE text USING sales_type::text;

CREATE INDEX account_notes_pending_idx
  ON public.account_notes (trigger_type)
  WHERE fired_at IS NULL AND trigger_type <> 'none';

CREATE TRIGGER incidents_classify_trg BEFORE INSERT OR UPDATE OF postal_code, address, incident_type
  ON public.incidents FOR EACH ROW EXECUTE FUNCTION public.incidents_classify();

-- Loss-type helpers now speak text on both sides.
DROP FUNCTION IF EXISTS public.enum_for_loss_type_key(text);
DROP FUNCTION IF EXISTS public.loss_type_key_for_enum(public.job_loss_type);

CREATE FUNCTION public.enum_for_loss_type_key(_k text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE _k
    WHEN 'water_mitigation' THEN 'water'
    WHEN 'fire_smoke_cleaning' THEN 'fire'
    WHEN 'sewer_cat3' THEN 'sewer'
    WHEN 'mold_remediation' THEN 'mold'
    WHEN 'biohazard_trauma' THEN 'biohazard'
    WHEN 'emergency_services' THEN 'storm'
    WHEN 'board_up_tarp' THEN 'storm'
    WHEN 'general_cleaning' THEN 'cleaning'
    WHEN 'contents_packout' THEN 'cleaning'
    WHEN 'reconstruction' THEN 'cleaning'
    WHEN 'asbestos_lead' THEN 'cleaning'
    ELSE NULL
  END
$$;

CREATE FUNCTION public.loss_type_key_for_enum(_v text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE _v
    WHEN 'water' THEN 'water_mitigation'
    WHEN 'fire' THEN 'fire_smoke_cleaning'
    WHEN 'smoke' THEN 'fire_smoke_cleaning'
    WHEN 'sewer' THEN 'sewer_cat3'
    WHEN 'mold' THEN 'mold_remediation'
    WHEN 'biohazard' THEN 'biohazard_trauma'
    WHEN 'storm' THEN 'emergency_services'
    WHEN 'cleaning' THEN 'general_cleaning'
    ELSE NULL
  END
$$;

-- Account type sync no longer collapses unknown kinds to 'other'.
CREATE OR REPLACE FUNCTION public.trg_accounts_sync_account_type()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_key text;
BEGIN
  IF NEW.account_type_id IS NOT NULL THEN
    SELECT olv.key INTO v_key FROM public.option_list_values olv WHERE olv.id = NEW.account_type_id;
    IF v_key IS NOT NULL THEN
      NEW.account_type := v_key;
    END IF;
  ELSIF TG_OP = 'INSERT' OR NEW.account_type IS DISTINCT FROM OLD.account_type THEN
    SELECT olv.id INTO NEW.account_type_id
    FROM public.option_list_values olv
    JOIN public.option_lists ol ON ol.id = olv.list_id AND ol.key = 'account_type'
    WHERE olv.key = NEW.account_type;
  END IF;
  RETURN NEW;
END;
$$;

CREATE VIEW public.account_fire_rollup AS
 SELECT a.id AS account_id,
    a.name,
    a.status,
    a.stage,
    a.stage_id,
    a.pipeline_id,
    a.priority,
    a.estimated_annual_value,
    a.account_type,
    a.location_id,
    a.assigned_rep,
    a.notes,
    a.updated_at,
    COALESCE(l.lead_count, 0::bigint) AS lead_count,
    COALESCE(l.open_count, 0::bigint) AS open_count,
    l.last_loss_date,
    COALESCE(l.units_vacated, 0::bigint) AS units_vacated,
    l.mailing_address,
    c.primary_contact_id,
    c.primary_contact_name,
    c.primary_contact_email,
    c.primary_contact_phone,
    t.last_touch_at,
    t.last_in_person_at,
    COALESCE(t.touch_count, 0::bigint) AS touch_count,
    a.approval_state,
    a.approval_due_on
   FROM accounts a
     LEFT JOIN LATERAL ( SELECT count(*) AS lead_count,
            count(*) FILTER (WHERE fl.status = 'open'::lead_status AND fl.rescind_date IS NULL) AS open_count,
            max(fl.incident_date) AS last_loss_date,
            COALESCE(sum(fl.units_vacated), 0::bigint) AS units_vacated,
            (array_remove(array_agg(fl.owner_mailing_address ORDER BY fl.incident_date DESC NULLS LAST), NULL::text))[1] AS mailing_address
           FROM fire_leads fl
          WHERE fl.account_id = a.id) l ON true
     LEFT JOIN LATERAL ( SELECT ct.id AS primary_contact_id,
            ct.full_name AS primary_contact_name,
            ct.email AS primary_contact_email,
            ct.phone AS primary_contact_phone
           FROM contacts ct
          WHERE ct.account_id = a.id
          ORDER BY ct.is_primary DESC, ct.created_at
         LIMIT 1) c ON true
     LEFT JOIN LATERAL ( SELECT max(tp.occurred_at) AS last_touch_at,
            max(tp.occurred_at) FILTER (WHERE tp.type = 'meeting_in_person'::touchpoint_type) AS last_in_person_at,
            count(*) AS touch_count
           FROM touchpoints tp
          WHERE tp.account_id = a.id) t ON true;

GRANT SELECT ON public.account_fire_rollup TO authenticated;
GRANT ALL ON public.account_fire_rollup TO service_role;

-- New managed lists for the classifications that had no option list yet.
INSERT INTO public.option_lists (key, label, description, allow_location_scope) VALUES
  ('incident_type', 'Incident type', 'Kind of loss a chase incident is.', false),
  ('quote_category', 'Quote category', 'Grouping for quote and estimate line items.', false),
  ('gift_occasion', 'Gift occasion', 'Why a gift or seasonal send goes out.', false),
  ('expense_kind', 'Expense kind', 'How a spend is classified on expenses and company cards.', false),
  ('reassignment_reason', 'Reassignment reason', 'Why a deal or book of business moved to another rep.', false),
  ('note_trigger', 'Note trigger', 'When a saved note should resurface.', false),
  ('sales_type', 'Sales type', 'How a person sells — drives pay and commission plans.', false),
  ('job_assignment_role', 'Job assignment role', 'Role a person plays on a job assignment.', false)
ON CONFLICT (key) DO NOTHING;

-- Seed each new list from the values already in use.
INSERT INTO public.option_list_values (list_id, key, label, sort_order)
SELECT l.id, s.key, s.label, s.ord
FROM (VALUES
  ('incident_type','fire','Fire',10),
  ('incident_type','water','Water',20),
  ('incident_type','smoke','Smoke',30),
  ('incident_type','storm','Storm',40),
  ('incident_type','other','Other',50),
  ('quote_category','labor','Labor',10),
  ('quote_category','equipment','Equipment',20),
  ('quote_category','materials','Materials',30),
  ('quote_category','disposal','Disposal',40),
  ('quote_category','mitigation','Mitigation',50),
  ('quote_category','reconstruction','Reconstruction',60),
  ('quote_category','other','Other',70),
  ('gift_occasion','birthday','Birthday',10),
  ('gift_occasion','jewish_holiday','Jewish holiday',20),
  ('gift_occasion','seasonal','Seasonal',30),
  ('gift_occasion','thank_you','Thank you',40),
  ('gift_occasion','other','Other',50),
  ('expense_kind','car_payment','Car payment',10),
  ('expense_kind','auto_stipend','Auto stipend',20),
  ('expense_kind','gas_card','Gas card',30),
  ('expense_kind','company_card','Company card',40),
  ('expense_kind','general','General',50),
  ('expense_kind','reimbursement','Reimbursement',60),
  ('reassignment_reason','no_close_6_months','Hasn''t closed in 6 months',10),
  ('reassignment_reason','rep_departed','Rep departed',20),
  ('reassignment_reason','territory_change','Territory change',30),
  ('reassignment_reason','account_request','Account requested it',40),
  ('reassignment_reason','other','Other',50),
  ('note_trigger','none','No reminder',10),
  ('note_trigger','next_call','Surface on the next call',20),
  ('note_trigger','next_meeting','Surface at the next meeting',30),
  ('note_trigger','next_stage_change','Surface at the next stage change',40),
  ('note_trigger','on_date','Surface on a date',50),
  ('sales_type','in_house','In-house',10),
  ('sales_type','cold_caller','Cold caller',20),
  ('sales_type','field','Field',30),
  ('sales_type','outside_referral','Outside referral',40),
  ('job_assignment_role','crew_chief','Crew Chief',10),
  ('job_assignment_role','technician','Technician',20),
  ('job_assignment_role','lead_technician','Lead Technician',30),
  ('job_assignment_role','account_rep','Account Rep',40),
  ('job_assignment_role','project_manager','Project Manager',50),
  ('job_assignment_role','estimator','Estimator',60),
  ('job_assignment_role','collector','Collector',70)
) AS s(list_key, key, label, ord)
JOIN public.option_lists l ON l.key = s.list_key
ON CONFLICT DO NOTHING;

-- These lists are no longer enum-locked.
UPDATE public.option_lists SET backed_by_enum = NULL
 WHERE key IN ('account_type','contact_decision_role','equipment_type','loss_type','job_type');
