-- ============ ENUMS ============
CREATE TYPE public.automation_trigger AS ENUM (
  'stage_enter','stage_leave','stage_rot','task_past_due','no_activity',
  'date_reached','deal_created','deal_won','deal_lost'
);
CREATE TYPE public.automation_action_kind AS ENUM (
  'create_task','assign_task','set_due_date','notify','move_stage','apply_flag','escalate'
);
CREATE TYPE public.sales_type AS ENUM ('in_house','cold_caller','field','outside_referral');
CREATE TYPE public.pay_type AS ENUM ('salary','draw','commission','combination');
CREATE TYPE public.expense_kind AS ENUM ('car_payment','auto_stipend','gas_card','company_card','general','reimbursement');
CREATE TYPE public.expense_request_status AS ENUM ('pending','approved','declined','auto_approved','cancelled');
CREATE TYPE public.offboarding_status AS ENUM ('open','complete','cancelled');
CREATE TYPE public.reassignment_reason AS ENUM ('no_close_6_months','rep_departed','territory_change','account_request','other');

ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'automation_task';
ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'automation_escalation';
ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'expense_approval_request';
ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'expense_decision';
ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'book_reassigned';

-- ============ HELPERS ============
CREATE OR REPLACE FUNCTION public.is_sales_lead(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role::text IN ('owner','admin','dev','sales_head')
  );
$$;

-- ============ 11. AUTOMATION ENGINE ============
CREATE TABLE public.automation_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid REFERENCES public.locations(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  trigger_type public.automation_trigger NOT NULL,
  -- days, date_field, stage_id, task filters
  trigger_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- pipeline_id, stage_ids[], owner_ids[], lead_sources[], account_types[]
  conditions jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- [{kind, title, assignee_mode, assignee_user_id, due_in_days, message, stage_id, flag, priority}]
  actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  run_order integer NOT NULL DEFAULT 100,
  is_active boolean NOT NULL DEFAULT true,
  is_system boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.automation_rules TO authenticated;
GRANT ALL ON public.automation_rules TO service_role;
ALTER TABLE public.automation_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "automation_rules_select" ON public.automation_rules FOR SELECT TO authenticated
  USING (location_id IS NULL OR public.can_view_location(auth.uid(), location_id));
CREATE POLICY "automation_rules_write" ON public.automation_rules FOR ALL TO authenticated
  USING (public.is_sales_lead(auth.uid())) WITH CHECK (public.is_sales_lead(auth.uid()));

-- Automation is internal only: reject any action that is not one of the
-- internal action kinds. No client-facing send can ever be configured.
CREATE OR REPLACE FUNCTION public.tg_automation_rules_validate()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $$
DECLARE a jsonb;
BEGIN
  IF jsonb_typeof(NEW.actions) <> 'array' THEN
    RAISE EXCEPTION 'actions must be a JSON array';
  END IF;
  FOR a IN SELECT * FROM jsonb_array_elements(NEW.actions) LOOP
    IF NOT ((a->>'kind') = ANY (ARRAY['create_task','assign_task','set_due_date','notify','move_stage','apply_flag','escalate'])) THEN
      RAISE EXCEPTION 'Unsupported automation action "%". Automation is internal-only: it may never contact a client.', a->>'kind';
    END IF;
  END LOOP;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER trg_automation_rules_validate BEFORE INSERT OR UPDATE ON public.automation_rules
  FOR EACH ROW EXECUTE FUNCTION public.tg_automation_rules_validate();

-- Per-stage rot windows: one global timer is useless.
CREATE TABLE public.automation_stage_windows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id uuid NOT NULL REFERENCES public.pipelines(id) ON DELETE CASCADE,
  stage_id uuid NOT NULL REFERENCES public.pipeline_stages(id) ON DELETE CASCADE,
  rot_days integer NOT NULL DEFAULT 14,
  escalate_days integer,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (stage_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.automation_stage_windows TO authenticated;
GRANT ALL ON public.automation_stage_windows TO service_role;
ALTER TABLE public.automation_stage_windows ENABLE ROW LEVEL SECURITY;
CREATE POLICY "asw_select" ON public.automation_stage_windows FOR SELECT TO authenticated USING (true);
CREATE POLICY "asw_write" ON public.automation_stage_windows FOR ALL TO authenticated
  USING (public.is_sales_lead(auth.uid())) WITH CHECK (public.is_sales_lead(auth.uid()));

CREATE TABLE public.automation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id uuid REFERENCES public.automation_rules(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  evaluated_count integer NOT NULL DEFAULT 0,
  matched_count integer NOT NULL DEFAULT 0,
  action_count integer NOT NULL DEFAULT 0,
  error text,
  triggered_by uuid REFERENCES auth.users(id)
);
GRANT SELECT ON public.automation_runs TO authenticated;
GRANT ALL ON public.automation_runs TO service_role;
ALTER TABLE public.automation_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "automation_runs_select" ON public.automation_runs FOR SELECT TO authenticated
  USING (public.is_sales_lead(auth.uid()));

CREATE TABLE public.automation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id uuid NOT NULL REFERENCES public.automation_rules(id) ON DELETE CASCADE,
  run_id uuid REFERENCES public.automation_runs(id) ON DELETE SET NULL,
  record_type text NOT NULL,
  record_id uuid NOT NULL,
  record_label text,
  action_kind public.automation_action_kind NOT NULL,
  reason text NOT NULL,
  task_id uuid REFERENCES public.tasks(id) ON DELETE SET NULL,
  target_user_id uuid REFERENCES auth.users(id),
  location_id uuid REFERENCES public.locations(id) ON DELETE SET NULL,
  dedupe_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rule_id, record_id, dedupe_key)
);
GRANT SELECT ON public.automation_events TO authenticated;
GRANT ALL ON public.automation_events TO service_role;
ALTER TABLE public.automation_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "automation_events_select" ON public.automation_events FOR SELECT TO authenticated
  USING (public.is_sales_lead(auth.uid()) OR target_user_id = auth.uid()
         OR (location_id IS NOT NULL AND public.can_view_location(auth.uid(), location_id)));

-- Rules must be visible on the task they produced.
ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS automation_rule_id uuid REFERENCES public.automation_rules(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS automation_reason text;
CREATE INDEX IF NOT EXISTS idx_tasks_automation_rule ON public.tasks(automation_rule_id);

-- ============ 12. REASSIGNMENT & OFFBOARDING ============
CREATE TABLE public.reassignment_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_user_id uuid NOT NULL REFERENCES auth.users(id),
  to_user_id uuid NOT NULL REFERENCES auth.users(id),
  reason public.reassignment_reason NOT NULL,
  reason_note text,
  do_differently text,
  account_count integer NOT NULL DEFAULT 0,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.reassignment_batches TO authenticated;
GRANT ALL ON public.reassignment_batches TO service_role;
ALTER TABLE public.reassignment_batches ENABLE ROW LEVEL SECURITY;
CREATE POLICY "rb_select" ON public.reassignment_batches FOR SELECT TO authenticated
  USING (public.is_sales_lead(auth.uid()) OR from_user_id = auth.uid() OR to_user_id = auth.uid());
CREATE POLICY "rb_insert" ON public.reassignment_batches FOR INSERT TO authenticated
  WITH CHECK (public.is_sales_lead(auth.uid()));

CREATE TABLE public.deal_reassignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid REFERENCES public.reassignment_batches(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  from_user_id uuid REFERENCES auth.users(id),
  to_user_id uuid NOT NULL REFERENCES auth.users(id),
  reason public.reassignment_reason NOT NULL,
  reason_note text,
  do_differently text,
  stage_at_transfer text,
  days_in_pipeline integer,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.deal_reassignments TO authenticated;
GRANT ALL ON public.deal_reassignments TO service_role;
ALTER TABLE public.deal_reassignments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "dr_select" ON public.deal_reassignments FOR SELECT TO authenticated
  USING (public.is_sales_lead(auth.uid()) OR from_user_id = auth.uid() OR to_user_id = auth.uid()
         OR EXISTS (
              SELECT 1 FROM public.accounts a
               WHERE a.id = deal_reassignments.account_id
                 AND public.can_view_location(auth.uid(), a.location_id)
            ));
CREATE POLICY "dr_insert" ON public.deal_reassignments FOR INSERT TO authenticated
  WITH CHECK (public.is_sales_lead(auth.uid()));

CREATE TABLE public.offboarding_checklists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status public.offboarding_status NOT NULL DEFAULT 'open',
  reason text,
  initiated_by uuid REFERENCES auth.users(id),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.offboarding_checklists TO authenticated;
GRANT ALL ON public.offboarding_checklists TO service_role;
ALTER TABLE public.offboarding_checklists ENABLE ROW LEVEL SECURITY;
CREATE POLICY "obc_select" ON public.offboarding_checklists FOR SELECT TO authenticated
  USING (public.is_sales_lead(auth.uid()));
CREATE POLICY "obc_write" ON public.offboarding_checklists FOR ALL TO authenticated
  USING (public.is_sales_lead(auth.uid())) WITH CHECK (public.is_sales_lead(auth.uid()));

CREATE TABLE public.offboarding_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  checklist_id uuid NOT NULL REFERENCES public.offboarding_checklists(id) ON DELETE CASCADE,
  step_key text NOT NULL,
  label text NOT NULL,
  detail text,
  sort_order integer NOT NULL DEFAULT 0,
  completed_at timestamptz,
  completed_by uuid REFERENCES auth.users(id),
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (checklist_id, step_key)
);
GRANT SELECT, INSERT, UPDATE ON public.offboarding_steps TO authenticated;
GRANT ALL ON public.offboarding_steps TO service_role;
ALTER TABLE public.offboarding_steps ENABLE ROW LEVEL SECURITY;
CREATE POLICY "obs_select" ON public.offboarding_steps FOR SELECT TO authenticated
  USING (public.is_sales_lead(auth.uid()));
CREATE POLICY "obs_write" ON public.offboarding_steps FOR ALL TO authenticated
  USING (public.is_sales_lead(auth.uid())) WITH CHECK (public.is_sales_lead(auth.uid()));

ALTER TABLE public.integration_connections
  ADD COLUMN IF NOT EXISTS revocation_pending boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS revocation_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS revocation_for_user uuid REFERENCES auth.users(id);

-- One action: kill the login and flag every linked integration for revocation.
CREATE OR REPLACE FUNCTION public.deactivate_user_now(_user_id uuid, _reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _checklist_id uuid; _flagged integer := 0;
BEGIN
  IF NOT public.is_sales_lead(auth.uid()) THEN
    RAISE EXCEPTION 'Not permitted';
  END IF;
  IF _user_id = auth.uid() THEN
    RAISE EXCEPTION 'You cannot deactivate yourself';
  END IF;

  UPDATE public.profiles
     SET is_active = false, deactivated_at = now(), deactivated_by = auth.uid(), updated_at = now()
   WHERE user_id = _user_id;

  UPDATE public.integration_connections
     SET revocation_pending = true, revocation_requested_at = now(), revocation_for_user = _user_id
   WHERE created_by = _user_id AND revocation_pending = false;
  GET DIAGNOSTICS _flagged = ROW_COUNT;

  INSERT INTO public.offboarding_checklists (user_id, reason, initiated_by)
  VALUES (_user_id, _reason, auth.uid())
  RETURNING id INTO _checklist_id;

  INSERT INTO public.offboarding_steps (checklist_id, step_key, label, detail, sort_order) VALUES
    (_checklist_id, 'revoke_access',   'Revoke system access',        'Login disabled and sessions revoked', 1),
    (_checklist_id, 'revoke_mailbox',  'Revoke mailbox and dialer',   'Disconnect linked integrations flagged for revocation', 2),
    (_checklist_id, 'transfer_number', 'Transfer company number',     'Move the direct line to the covering rep', 3),
    (_checklist_id, 'reassign_book',   'Reassign the book',           'Bulk-reassign every open account with a reason and next steps', 4),
    (_checklist_id, 'export_log',      'Confirm export log is clean', 'Review export_audit for this user before close-out', 5),
    (_checklist_id, 'close_expenses',  'Close out expenses and card', 'Settle outstanding expenses and cancel the company card', 6);

  RETURN jsonb_build_object('checklist_id', _checklist_id, 'integrations_flagged', _flagged);
END $$;

-- ============ 13. PEOPLE AND PAY (effective-dated) ============
CREATE TABLE public.sales_type_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  sales_type public.sales_type NOT NULL,
  effective_from date NOT NULL DEFAULT CURRENT_DATE,
  effective_to date,
  note text,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sales_type_assignments TO authenticated;
GRANT ALL ON public.sales_type_assignments TO service_role;
ALTER TABLE public.sales_type_assignments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "sta_select" ON public.sales_type_assignments FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_sales_lead(auth.uid()));
CREATE POLICY "sta_write" ON public.sales_type_assignments FOR ALL TO authenticated
  USING (public.is_sales_lead(auth.uid())) WITH CHECK (public.is_sales_lead(auth.uid()));

CREATE TABLE public.pay_structures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  pay_type public.pay_type NOT NULL,
  base_salary_annual numeric(12,2),
  draw_amount numeric(12,2),
  draw_period text CHECK (draw_period IN ('weekly','biweekly','semimonthly','monthly')),
  draw_recoverable boolean NOT NULL DEFAULT true,
  effective_from date NOT NULL DEFAULT CURRENT_DATE,
  effective_to date,
  note text,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pay_structures TO authenticated;
GRANT ALL ON public.pay_structures TO service_role;
ALTER TABLE public.pay_structures ENABLE ROW LEVEL SECURITY;
CREATE POLICY "pay_select" ON public.pay_structures FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_sales_lead(auth.uid()));
CREATE POLICY "pay_write" ON public.pay_structures FOR ALL TO authenticated
  USING (public.is_sales_lead(auth.uid())) WITH CHECK (public.is_sales_lead(auth.uid()));

CREATE TABLE public.commission_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  deal_source text NOT NULL DEFAULT 'default',
  basis text NOT NULL DEFAULT 'collected' CHECK (basis IN ('collected','billed','gross_profit')),
  rate_percent numeric(6,3),
  flat_amount numeric(12,2),
  tiers jsonb NOT NULL DEFAULT '[]'::jsonb,
  effective_from date NOT NULL DEFAULT CURRENT_DATE,
  effective_to date,
  note text,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.commission_plans TO authenticated;
GRANT ALL ON public.commission_plans TO service_role;
ALTER TABLE public.commission_plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY "cp_select" ON public.commission_plans FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_sales_lead(auth.uid()));
CREATE POLICY "cp_write" ON public.commission_plans FOR ALL TO authenticated
  USING (public.is_sales_lead(auth.uid())) WITH CHECK (public.is_sales_lead(auth.uid()));

CREATE INDEX idx_pay_structures_user ON public.pay_structures(user_id, effective_from DESC);
CREATE INDEX idx_commission_plans_user ON public.commission_plans(user_id, deal_source, effective_from DESC);
CREATE INDEX idx_sales_type_user ON public.sales_type_assignments(user_id, effective_from DESC);

-- Terms in force on a given date: March stays March after a June change.
CREATE OR REPLACE FUNCTION public.commission_terms_on(_user_id uuid, _source text, _on date)
RETURNS TABLE(plan_id uuid, basis text, rate_percent numeric, flat_amount numeric, tiers jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT id, basis, rate_percent, flat_amount, tiers
    FROM public.commission_plans
   WHERE user_id = _user_id
     AND effective_from <= _on
     AND (effective_to IS NULL OR effective_to >= _on)
     AND deal_source IN (COALESCE(_source,'default'), 'default')
   ORDER BY (deal_source = COALESCE(_source,'default')) DESC, effective_from DESC
   LIMIT 1;
$$;

-- ============ 14. EXPENSES AND COMPANY CARDS ============
CREATE TABLE public.expense_thresholds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role,
  amount numeric(12,2) NOT NULL DEFAULT 50,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (user_id IS NOT NULL OR role IS NOT NULL)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.expense_thresholds TO authenticated;
GRANT ALL ON public.expense_thresholds TO service_role;
ALTER TABLE public.expense_thresholds ENABLE ROW LEVEL SECURITY;
CREATE POLICY "et_select" ON public.expense_thresholds FOR SELECT TO authenticated USING (true);
CREATE POLICY "et_write" ON public.expense_thresholds FOR ALL TO authenticated
  USING (public.is_sales_lead(auth.uid())) WITH CHECK (public.is_sales_lead(auth.uid()));

CREATE OR REPLACE FUNCTION public.expense_threshold_for(_user_id uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT COALESCE(
    (SELECT amount FROM public.expense_thresholds WHERE user_id = _user_id AND is_active LIMIT 1),
    (SELECT t.amount FROM public.expense_thresholds t
       JOIN public.user_roles ur ON ur.user_id = _user_id AND ur.role = t.role
      WHERE t.is_active AND t.user_id IS NULL
      ORDER BY t.amount ASC LIMIT 1),
    50
  );
$$;

CREATE TABLE public.expense_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  location_id uuid REFERENCES public.locations(id) ON DELETE SET NULL,
  kind public.expense_kind NOT NULL DEFAULT 'company_card',
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  merchant text,
  purpose text NOT NULL,
  account_id uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  job_id uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
  threshold_at_request numeric(12,2),
  status public.expense_request_status NOT NULL DEFAULT 'pending',
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES auth.users(id),
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.expense_requests TO authenticated;
GRANT ALL ON public.expense_requests TO service_role;
ALTER TABLE public.expense_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "er_select" ON public.expense_requests FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_sales_lead(auth.uid())
         OR (location_id IS NOT NULL AND public.can_manage_location(auth.uid(), location_id)));
CREATE POLICY "er_insert" ON public.expense_requests FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());
CREATE POLICY "er_update_own" ON public.expense_requests FOR UPDATE TO authenticated
  USING (user_id = auth.uid() AND status = 'pending') WITH CHECK (user_id = auth.uid());
CREATE POLICY "er_update_lead" ON public.expense_requests FOR UPDATE TO authenticated
  USING (public.is_sales_lead(auth.uid())) WITH CHECK (public.is_sales_lead(auth.uid()));

CREATE TABLE public.expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  location_id uuid REFERENCES public.locations(id) ON DELETE SET NULL,
  kind public.expense_kind NOT NULL,
  amount numeric(12,2) NOT NULL,
  spent_on date NOT NULL DEFAULT CURRENT_DATE,
  merchant text,
  description text,
  card_last4 text,
  request_id uuid REFERENCES public.expense_requests(id) ON DELETE SET NULL,
  account_id uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  job_id uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
  reimbursed boolean NOT NULL DEFAULT false,
  reimbursed_at timestamptz,
  receipt_path text,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.expenses TO authenticated;
GRANT ALL ON public.expenses TO service_role;
ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "exp_select" ON public.expenses FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_sales_lead(auth.uid())
         OR (location_id IS NOT NULL AND public.can_manage_location(auth.uid(), location_id)));
CREATE POLICY "exp_insert" ON public.expenses FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() OR public.is_sales_lead(auth.uid()));
CREATE POLICY "exp_update" ON public.expenses FOR UPDATE TO authenticated
  USING (user_id = auth.uid() OR public.is_sales_lead(auth.uid()))
  WITH CHECK (user_id = auth.uid() OR public.is_sales_lead(auth.uid()));
CREATE POLICY "exp_delete" ON public.expenses FOR DELETE TO authenticated
  USING (user_id = auth.uid() OR public.is_sales_lead(auth.uid()));

CREATE INDEX idx_expenses_user_date ON public.expenses(user_id, spent_on DESC);
CREATE INDEX idx_expense_requests_status ON public.expense_requests(status, requested_at DESC);

-- Under threshold goes straight through; above it waits for the Sales Head.
CREATE OR REPLACE FUNCTION public.tg_expense_request_route()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _threshold numeric; _approver record; _name text;
BEGIN
  _threshold := public.expense_threshold_for(NEW.user_id);
  NEW.threshold_at_request := _threshold;
  SELECT full_name INTO _name FROM public.profiles WHERE user_id = NEW.user_id;

  IF NEW.amount <= _threshold THEN
    NEW.status := 'auto_approved';
    NEW.decided_at := now();
  ELSE
    NEW.status := 'pending';
    FOR _approver IN
      SELECT ur.user_id FROM public.user_roles ur
       WHERE ur.role::text IN ('sales_head','owner')
    LOOP
      INSERT INTO public.notifications (user_id, type, title, body, entity_type, entity_id, href, priority)
      VALUES (_approver.user_id, 'expense_approval_request',
              COALESCE(_name,'A rep') || ' needs approval: $' || NEW.amount::text,
              COALESCE(NEW.merchant,'') || ' — ' || NEW.purpose,
              'expense_request', NEW.id, '/expenses/approvals', 'high');
    END LOOP;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_expense_request_route BEFORE INSERT ON public.expense_requests
  FOR EACH ROW EXECUTE FUNCTION public.tg_expense_request_route();

CREATE OR REPLACE FUNCTION public.tg_expense_request_decided()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('approved','declined') THEN
    NEW.decided_by := COALESCE(NEW.decided_by, auth.uid());
    NEW.decided_at := COALESCE(NEW.decided_at, now());
    INSERT INTO public.notifications (user_id, type, title, body, entity_type, entity_id, href, priority)
    VALUES (NEW.user_id, 'expense_decision',
            CASE WHEN NEW.status = 'approved' THEN 'Expense approved' ELSE 'Expense declined' END
              || ': $' || NEW.amount::text,
            COALESCE(NEW.decision_note, COALESCE(NEW.merchant,'') || ' — ' || NEW.purpose),
            'expense_request', NEW.id, '/expenses', 'high');
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER trg_expense_request_decided BEFORE UPDATE ON public.expense_requests
  FOR EACH ROW EXECUTE FUNCTION public.tg_expense_request_decided();

-- updated_at triggers
CREATE TRIGGER trg_asw_updated BEFORE UPDATE ON public.automation_stage_windows
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_obc_updated BEFORE UPDATE ON public.offboarding_checklists
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_sta_updated BEFORE UPDATE ON public.sales_type_assignments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_pay_updated BEFORE UPDATE ON public.pay_structures
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_cp_updated BEFORE UPDATE ON public.commission_plans
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_et_updated BEFORE UPDATE ON public.expense_thresholds
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_exp_updated BEFORE UPDATE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();