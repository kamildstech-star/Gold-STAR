-- Conversation Established -> Active Clients, and the onboarding popup.
--
-- The drop is manual (the board's job). What the board calls:
--
--   pipeline_activate_client(account, green_light_date)
--     Atomically: won stage, status active, green_light_date (default today,
--     editable — "reps often log something on Tuesday that happened last
--     Thursday"), the Farming pipeline's Healthy stage with its clock set to
--     the green-light date, and the annual in-person meeting due a year from
--     it when none is set. The inverse is move_account_back_to_pipeline
--     (20260908185502); this mirrors its shape: SECURITY INVOKER so the
--     accounts RLS policy stays authoritative, the reason rides through
--     lost_reason into stage history and is cleared in the same transaction.
--
--   pipeline_apply_onboarding(account, answers)
--     ONE call with the popup's answers (the catalogue, keyed by account
--     label, is src/lib/onboarding-questions.ts). It turns them into what the
--     office actually needs: compliance requirements on the deal (COI, W-9,
--     vendor agreement), tasks for the rep (credentialing, vendor packet,
--     paperwork, follow-up cadence), and the referral fee per contact in
--     account_referral_fees. Every answer is also kept verbatim in
--     accounts.onboarding_answers so nothing typed is lost. Nothing is
--     mandatory; an empty object is a valid, harmless call. Re-running does
--     not duplicate: requirements are skipped when an active one of the type
--     exists, tasks carry a cadence_key.

ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS onboarding_answers jsonb,
  ADD COLUMN IF NOT EXISTS onboarding_applied_at timestamptz,
  ADD COLUMN IF NOT EXISTS onboarding_applied_by uuid;

COMMENT ON COLUMN public.accounts.green_light_date IS
  'The day the client said yes. Set by pipeline_activate_client; starts the Farming clock.';

-- ---------------------------------------------------------------------------
-- Referral fee terms, per account and (optionally) per person.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.account_referral_fees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  basis text NOT NULL DEFAULT 'percent'
    CHECK (basis IN ('percent', 'flat', 'per_job', 'commission_per_job', 'none', 'other')),
  rate_percent numeric CHECK (rate_percent IS NULL OR (rate_percent >= 0 AND rate_percent <= 100)),
  amount numeric CHECK (amount IS NULL OR amount >= 0),
  notes text,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  is_demo boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS account_referral_fees_account_idx ON public.account_referral_fees(account_id);

DROP TRIGGER IF EXISTS trg_account_referral_fees_updated_at ON public.account_referral_fees;
CREATE TRIGGER trg_account_referral_fees_updated_at
  BEFORE UPDATE ON public.account_referral_fees
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.account_referral_fees ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.account_referral_fees FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.account_referral_fees TO authenticated;
GRANT ALL ON public.account_referral_fees TO service_role;

-- Same shape as contacts: see it if you can see the account, write it if you
-- own the account or manage its office.
DROP POLICY IF EXISTS account_referral_fees_select ON public.account_referral_fees;
CREATE POLICY account_referral_fees_select ON public.account_referral_fees
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.accounts a
    WHERE a.id = account_referral_fees.account_id
      AND (a.assigned_rep = (SELECT auth.uid())
           OR a.created_by = (SELECT auth.uid())
           OR public.can_view_location((SELECT auth.uid()), a.location_id))
  ));
DROP POLICY IF EXISTS account_referral_fees_write ON public.account_referral_fees;
CREATE POLICY account_referral_fees_write ON public.account_referral_fees
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.accounts a
    WHERE a.id = account_referral_fees.account_id
      AND (a.assigned_rep = (SELECT auth.uid())
           OR public.can_manage_location((SELECT auth.uid()), a.location_id))
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.accounts a
    WHERE a.id = account_referral_fees.account_id
      AND (a.assigned_rep = (SELECT auth.uid())
           OR public.can_manage_location((SELECT auth.uid()), a.location_id))
  ));

-- ---------------------------------------------------------------------------
-- The drop.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pipeline_activate_client(
  _account_id uuid,
  _green_light_date date DEFAULT current_date
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  won uuid;
  farming uuid;
  healthy uuid;
  glow date := coalesce(_green_light_date, current_date);
BEGIN
  IF glow > current_date THEN
    RAISE EXCEPTION 'The green-light date cannot be in the future.' USING ERRCODE = '22023';
  END IF;

  SELECT w.id INTO won
    FROM public.accounts a
    JOIN public.pipeline_stages s ON s.id = a.stage_id
    JOIN public.pipeline_stages w ON w.pipeline_id = s.pipeline_id AND w.is_won AND w.is_active
   WHERE a.id = _account_id
   ORDER BY (w.key = 'active_client') DESC, w.sort_order
   LIMIT 1;
  IF won IS NULL THEN
    RAISE EXCEPTION 'This pipeline has no Active Client stage.' USING ERRCODE = '22023';
  END IF;

  SELECT h.pipeline_id, h.id INTO farming, healthy
    FROM public.pipeline_stages h
    JOIN public.pipelines p ON p.id = h.pipeline_id
   WHERE h.key = 'healthy' AND h.is_active AND p.is_active
   ORDER BY (p.id = '33333333-3333-4333-8333-333333333333'::uuid) DESC
   LIMIT 1;

  UPDATE public.accounts
     SET stage_id = won,
         status = 'active',
         green_light_date = glow,
         health_pipeline_id = coalesce(farming, health_pipeline_id),
         health_stage_id = coalesce(healthy, health_stage_id),
         health_changed_at = glow::timestamptz,
         annual_meeting_due_on = coalesce(annual_meeting_due_on, (glow + interval '1 year')::date),
         lost_reason = 'Green light ' || to_char(glow, 'YYYY-MM-DD')
   WHERE id = _account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The account could not be activated.' USING ERRCODE = '42501';
  END IF;

  -- The stage-history trigger has copied the reason from the first update.
  UPDATE public.accounts SET lost_reason = NULL WHERE id = _account_id;
END;
$$;
REVOKE ALL ON FUNCTION public.pipeline_activate_client(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pipeline_activate_client(uuid, date) TO authenticated, service_role;

-- Helpers for pipeline_apply_onboarding. Same SECURITY INVOKER: RLS on tasks
-- and account_compliance_requirements decides, exactly as if the UI wrote them.
CREATE OR REPLACE FUNCTION public.onboarding_answer_true(_ans jsonb, _key text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE jsonb_typeof(_ans -> _key)
           WHEN 'boolean' THEN (_ans ->> _key)::boolean
           WHEN 'string' THEN lower(_ans ->> _key) IN ('true', 'yes', 'y', '1')
           WHEN 'number' THEN (_ans ->> _key)::numeric <> 0
           ELSE false END;
$$;

CREATE OR REPLACE FUNCTION public.onboarding_add_requirement(
  _account_id uuid, _type text, _required_value text, _wording text, _is_demo boolean
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE new_id uuid;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.account_compliance_requirements r
     WHERE r.account_id = _account_id AND r.requirement_type = _type AND r.active
  ) THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.account_compliance_requirements
    (account_id, requirement_type, mandatory, required_value, must_name_account, notes, active, created_by, is_demo)
  VALUES
    (_account_id, _type, true, _required_value, _wording IS NOT NULL,
     CASE WHEN _wording IS NOT NULL THEN 'Additional insured wording: ' || _wording END,
     true, auth.uid(), _is_demo)
  RETURNING id INTO new_id;
  RETURN new_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.onboarding_add_task(
  _account_id uuid, _location_id uuid, _assignee uuid, _is_demo boolean,
  _key text, _title text, _description text, _due_in_days integer
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  new_id uuid;
  ck text := 'onboarding:' || _account_id::text || ':' || _key;
BEGIN
  IF EXISTS (SELECT 1 FROM public.tasks t WHERE t.cadence_key = ck) THEN RETURN NULL; END IF;
  INSERT INTO public.tasks
    (title, description, assignee, due_date, priority, status, entity_type, entity_id,
     account_id, location_id, source, cadence_key, automation_reason, created_by, is_demo)
  VALUES
    (_title, _description, _assignee, current_date + greatest(_due_in_days, 0), 'normal', 'open',
     'account', _account_id, _account_id, _location_id, 'onboarding', ck,
     'Created from the Active Client onboarding answers.', auth.uid(), _is_demo)
  RETURNING id INTO new_id;
  RETURN new_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- The popup's answers -> tasks, compliance, referral fees.
-- Keys are those of src/lib/onboarding-questions.ts; unknown keys are kept
-- in onboarding_answers and otherwise ignored.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pipeline_apply_onboarding(_account_id uuid, _answers jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  ans jsonb := coalesce(_answers, '{}'::jsonb);
  acct record;
  me uuid := auth.uid();
  assignee uuid;
  task_ids uuid[] := '{}';
  req_ids uuid[] := '{}';
  fee_ids uuid[] := '{}';
  new_id uuid;
  fee jsonb;
  fees jsonb;
  txt text;
  n integer;
BEGIN
  IF jsonb_typeof(ans) <> 'object' THEN
    RAISE EXCEPTION 'Answers must be an object.' USING ERRCODE = '22023';
  END IF;

  SELECT a.id, a.name, a.location_id, a.assigned_rep, a.is_demo INTO acct
    FROM public.accounts a WHERE a.id = _account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The account could not be found.' USING ERRCODE = '42501';
  END IF;
  assignee := coalesce(acct.assigned_rep, me);

  -- ---- compliance items on the deal -------------------------------------
  IF public.onboarding_answer_true(ans, 'coi_needed') THEN
    new_id := public.onboarding_add_requirement(acct.id, 'certificate_of_insurance',
                nullif(btrim(coalesce(ans->>'coi_limits', '')), ''),
                nullif(btrim(coalesce(ans->>'coi_additional_insured', '')), ''),
                acct.is_demo);
    IF new_id IS NOT NULL THEN req_ids := req_ids || new_id; END IF;
  END IF;
  IF public.onboarding_answer_true(ans, 'w9_needed') THEN
    new_id := public.onboarding_add_requirement(acct.id, 'w9', NULL, NULL, acct.is_demo);
    IF new_id IS NOT NULL THEN req_ids := req_ids || new_id; END IF;
  END IF;
  IF public.onboarding_answer_true(ans, 'vendor_agreement_needed') THEN
    new_id := public.onboarding_add_requirement(acct.id, 'vendor_agreement', NULL, NULL, acct.is_demo);
    IF new_id IS NOT NULL THEN req_ids := req_ids || new_id; END IF;
  END IF;

  -- ---- tasks for the rep --------------------------------------------------
  txt := nullif(btrim(coalesce(ans->>'credentialing_platform_name', '')), '');
  IF txt IS NOT NULL OR public.onboarding_answer_true(ans, 'credentialing_platform') THEN
    new_id := public.onboarding_add_task(acct.id, acct.location_id, assignee, acct.is_demo, 'credentialing',
                'Complete vendor credentialing' || coalesce(' on ' || txt, '') || ' — ' || acct.name,
                'From the Active Client onboarding answers: they use a vendor credentialing platform' || coalesce(' (' || txt || ')', '') || '.',
                7);
    IF new_id IS NOT NULL THEN task_ids := task_ids || new_id; END IF;
  END IF;
  IF public.onboarding_answer_true(ans, 'vendor_packet_required') THEN
    new_id := public.onboarding_add_task(acct.id, acct.location_id, assignee, acct.is_demo, 'vendor_packet',
                'Complete onboarding / vendor packet — ' || acct.name,
                'From the Active Client onboarding answers: an onboarding or vendor packet is required.', 7);
    IF new_id IS NOT NULL THEN task_ids := task_ids || new_id; END IF;
  END IF;
  IF public.onboarding_answer_true(ans, 'onboarding_into_system') THEN
    new_id := public.onboarding_add_task(acct.id, acct.location_id, assignee, acct.is_demo, 'their_system',
                'Get set up in their system — ' || acct.name,
                'From the Active Client onboarding answers: they are onboarding us into their system.', 7);
    IF new_id IS NOT NULL THEN task_ids := task_ids || new_id; END IF;
  END IF;
  txt := nullif(btrim(coalesce(ans->>'paperwork', '')), '');
  IF txt IS NOT NULL THEN
    new_id := public.onboarding_add_task(acct.id, acct.location_id, assignee, acct.is_demo, 'paperwork',
                'Paperwork — ' || acct.name, 'From the Active Client onboarding answers: ' || txt, 7);
    IF new_id IS NOT NULL THEN task_ids := task_ids || new_id; END IF;
  END IF;
  txt := nullif(btrim(coalesce(ans->>'after_hours_protocol', '')), '');
  IF txt IS NOT NULL THEN
    new_id := public.onboarding_add_task(acct.id, acct.location_id, assignee, acct.is_demo, 'after_hours',
                'Confirm after-hours / emergency protocol — ' || acct.name,
                'Recorded at onboarding: ' || txt || '. Make sure dispatch has it.', 3);
    IF new_id IS NOT NULL THEN task_ids := task_ids || new_id; END IF;
  END IF;
  n := NULL;
  BEGIN
    n := (ans->>'followup_cadence_days')::int;
  EXCEPTION WHEN OTHERS THEN n := NULL; END;
  IF n IS NOT NULL AND n > 0 THEN
    new_id := public.onboarding_add_task(acct.id, acct.location_id, assignee, acct.is_demo, 'followup',
                'Follow up — ' || acct.name,
                'First follow-up on the cadence agreed at onboarding (every ' || n || ' days).', least(n, 365));
    IF new_id IS NOT NULL THEN task_ids := task_ids || new_id; END IF;
  END IF;

  -- ---- referral fee per contact/person ------------------------------------
  fees := CASE WHEN jsonb_typeof(ans->'referral_fees') = 'array' THEN ans->'referral_fees'
               WHEN jsonb_typeof(ans->'referral_fee') = 'object' THEN jsonb_build_array(ans->'referral_fee')
               ELSE '[]'::jsonb END;
  FOR fee IN SELECT * FROM jsonb_array_elements(fees) LOOP
    CONTINUE WHEN jsonb_typeof(fee) <> 'object';
    CONTINUE WHEN coalesce(fee->>'basis', '') = '' AND fee->>'rate_percent' IS NULL
                  AND fee->>'amount' IS NULL AND nullif(btrim(coalesce(fee->>'notes', '')), '') IS NULL;
    INSERT INTO public.account_referral_fees
      (account_id, contact_id, basis, rate_percent, amount, notes, created_by, is_demo)
    VALUES
      (acct.id,
       CASE WHEN coalesce(fee->>'contact_id', '') ~ '^[0-9a-f-]{36}$' THEN (fee->>'contact_id')::uuid END,
       CASE WHEN fee->>'basis' IN ('percent', 'flat', 'per_job', 'commission_per_job', 'none', 'other')
            THEN fee->>'basis' ELSE 'other' END,
       CASE WHEN (fee->>'rate_percent') ~ '^[0-9]+(\.[0-9]+)?$' THEN (fee->>'rate_percent')::numeric END,
       CASE WHEN (fee->>'amount') ~ '^[0-9]+(\.[0-9]+)?$' THEN (fee->>'amount')::numeric END,
       nullif(btrim(coalesce(fee->>'notes', '')), ''),
       me, acct.is_demo)
    RETURNING id INTO new_id;
    fee_ids := fee_ids || new_id;
  END LOOP;

  -- ---- keep everything typed ----------------------------------------------
  UPDATE public.accounts
     SET onboarding_answers = coalesce(onboarding_answers, '{}'::jsonb) || ans,
         onboarding_applied_at = now(),
         onboarding_applied_by = me
   WHERE id = acct.id;

  RETURN jsonb_build_object(
    'tasks', to_jsonb(task_ids),
    'compliance_requirements', to_jsonb(req_ids),
    'referral_fees', to_jsonb(fee_ids)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.pipeline_apply_onboarding(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pipeline_apply_onboarding(uuid, jsonb) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.onboarding_add_requirement(uuid, text, text, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.onboarding_add_requirement(uuid, text, text, text, boolean) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.onboarding_add_task(uuid, uuid, uuid, boolean, text, text, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.onboarding_add_task(uuid, uuid, uuid, boolean, text, text, text, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.onboarding_answer_true(jsonb, text) TO authenticated, service_role;
