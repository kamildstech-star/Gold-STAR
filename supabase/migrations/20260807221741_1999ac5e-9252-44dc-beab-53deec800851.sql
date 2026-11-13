-- 1. Requirement types as a managed option list -----------------------------

INSERT INTO public.option_lists (key, label, description, allow_location_scope)
VALUES ('compliance_requirement_type', 'Compliance requirement',
        'What a property manager or client requires a vendor to hold and keep current.', false)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.option_list_values (list_id, key, label, sort_order)
SELECT l.id, v.key, v.label, v.sort
FROM public.option_lists l
CROSS JOIN (VALUES
  ('certificate_of_insurance', 'Certificate of Insurance', 10),
  ('general_liability', 'General Liability', 20),
  ('auto_liability', 'Auto Liability', 30),
  ('workers_compensation', 'Workers Compensation', 40),
  ('umbrella_excess', 'Umbrella / Excess', 50),
  ('professional_liability', 'Professional Liability', 60),
  ('w9', 'W9', 70),
  ('vendor_agreement', 'Signed Vendor Agreement', 80),
  ('business_license', 'Business License', 90),
  ('state_contractor_licence', 'State Contractor Licence', 100),
  ('background_check', 'Background Check', 110),
  ('drug_testing_policy', 'Drug Testing Policy', 120),
  ('safety_programme', 'Safety Programme', 130),
  ('msds_sds', 'MSDS / SDS', 140),
  ('additional_insured', 'Additional Insured Endorsement', 150),
  ('waiver_of_subrogation', 'Waiver of Subrogation', 160)
) AS v(key, label, sort)
WHERE l.key = 'compliance_requirement_type'
ON CONFLICT DO NOTHING;

-- 2. Documents gain the evidence fields --------------------------------------

ALTER TABLE public.vendor_documents
  ADD COLUMN IF NOT EXISTS issuer text,
  ADD COLUMN IF NOT EXISTS carrier text,
  ADD COLUMN IF NOT EXISTS policy_number text,
  ADD COLUMN IF NOT EXISTS effective_date date,
  ADD COLUMN IF NOT EXISTS covered_amount numeric(14,2),
  ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'USD',
  ADD COLUMN IF NOT EXISTS verified_by uuid REFERENCES public.profiles(user_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS verified_at timestamptz;

-- 3. What each account requires ----------------------------------------------

CREATE TABLE IF NOT EXISTS public.account_compliance_requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  requirement_type text NOT NULL,
  mandatory boolean NOT NULL DEFAULT true,
  required_amount numeric(14,2),
  required_currency text NOT NULL DEFAULT 'USD',
  -- Free-text only for requirements a number cannot express (e.g. a named form).
  required_value text,
  -- Additional Insured and Waiver of Subrogation must name the manager, so a
  -- generic certificate never satisfies them.
  must_name_account boolean NOT NULL DEFAULT false,
  renewal_lead_days integer NOT NULL DEFAULT 30,
  notes text,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES public.profiles(user_id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  is_demo boolean NOT NULL DEFAULT false,
  UNIQUE (account_id, requirement_type)
);

CREATE INDEX IF NOT EXISTS acr_account_idx ON public.account_compliance_requirements(account_id);
CREATE INDEX IF NOT EXISTS acr_is_demo_idx ON public.account_compliance_requirements(is_demo) WHERE is_demo;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.account_compliance_requirements TO authenticated;
GRANT ALL ON public.account_compliance_requirements TO service_role;
ALTER TABLE public.account_compliance_requirements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "acr_select" ON public.account_compliance_requirements FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = account_id
  AND (a.created_by = auth.uid() OR a.assigned_rep = auth.uid() OR public.can_view_location(auth.uid(), a.location_id))));

CREATE POLICY "acr_insert" ON public.account_compliance_requirements FOR INSERT TO authenticated
WITH CHECK (EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = account_id
  AND (a.assigned_rep = auth.uid() OR public.can_manage_location(auth.uid(), a.location_id))));

CREATE POLICY "acr_update" ON public.account_compliance_requirements FOR UPDATE TO authenticated
USING (EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = account_id
  AND (a.assigned_rep = auth.uid() OR public.can_manage_location(auth.uid(), a.location_id))));

CREATE POLICY "acr_delete" ON public.account_compliance_requirements FOR DELETE TO authenticated
USING (public.is_privileged(auth.uid()));

CREATE TRIGGER trg_acr_updated BEFORE UPDATE ON public.account_compliance_requirements
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 4. Which documents satisfy which requirement (one COI can cover several) ----

CREATE TABLE IF NOT EXISTS public.compliance_requirement_documents (
  requirement_id uuid NOT NULL REFERENCES public.account_compliance_requirements(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES public.vendor_documents(id) ON DELETE CASCADE,
  created_by uuid REFERENCES public.profiles(user_id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  is_demo boolean NOT NULL DEFAULT false,
  PRIMARY KEY (requirement_id, document_id)
);

GRANT SELECT, INSERT, DELETE ON public.compliance_requirement_documents TO authenticated;
GRANT ALL ON public.compliance_requirement_documents TO service_role;
ALTER TABLE public.compliance_requirement_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "crd_select" ON public.compliance_requirement_documents FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.account_compliance_requirements r JOIN public.accounts a ON a.id = r.account_id
  WHERE r.id = requirement_id
    AND (a.created_by = auth.uid() OR a.assigned_rep = auth.uid() OR public.can_view_location(auth.uid(), a.location_id))));

CREATE POLICY "crd_insert" ON public.compliance_requirement_documents FOR INSERT TO authenticated
WITH CHECK (EXISTS (SELECT 1 FROM public.account_compliance_requirements r JOIN public.accounts a ON a.id = r.account_id
  WHERE r.id = requirement_id
    AND (a.assigned_rep = auth.uid() OR public.can_manage_location(auth.uid(), a.location_id))));

CREATE POLICY "crd_delete" ON public.compliance_requirement_documents FOR DELETE TO authenticated
USING (EXISTS (SELECT 1 FROM public.account_compliance_requirements r JOIN public.accounts a ON a.id = r.account_id
  WHERE r.id = requirement_id
    AND (a.assigned_rep = auth.uid() OR public.can_manage_location(auth.uid(), a.location_id))));

-- 5. One definition of status, shared by every surface ------------------------

CREATE OR REPLACE FUNCTION public.compliance_status_of(
  _has_doc boolean, _expiry date, _covered numeric, _required numeric, _lead_days integer
) RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE
    WHEN NOT _has_doc THEN 'missing'
    WHEN _expiry IS NOT NULL AND _expiry < current_date THEN 'expired'
    WHEN _required IS NOT NULL AND (_covered IS NULL OR _covered < _required) THEN 'insufficient'
    WHEN _expiry IS NOT NULL
      AND _expiry <= current_date + GREATEST(COALESCE(_lead_days, 30), 0) THEN 'expiring_soon'
    ELSE 'satisfied'
  END;
$$;

-- The document that best answers a requirement is the one that stays valid
-- longest; a superseded certificate should not drag the status down.
CREATE OR REPLACE VIEW public.account_compliance_status
WITH (security_invoker = on) AS
SELECT
  r.id                AS requirement_id,
  r.account_id,
  a.name              AS account_name,
  a.location_id,
  r.requirement_type,
  r.mandatory,
  r.required_amount,
  r.required_currency,
  r.required_value,
  r.must_name_account,
  r.renewal_lead_days,
  r.notes,
  d.id                AS document_id,
  d.name              AS document_name,
  d.storage_path,
  d.issuer,
  d.carrier,
  d.policy_number,
  d.effective_date,
  d.expiry_date,
  d.covered_amount,
  d.currency,
  d.verified_by,
  d.verified_at,
  (d.expiry_date - current_date) AS days_to_expiry,
  public.compliance_status_of(d.id IS NOT NULL, d.expiry_date, d.covered_amount,
                              r.required_amount, r.renewal_lead_days) AS status
FROM public.account_compliance_requirements r
JOIN public.accounts a ON a.id = r.account_id
LEFT JOIN LATERAL (
  SELECT vd.*
  FROM public.compliance_requirement_documents l
  JOIN public.vendor_documents vd ON vd.id = l.document_id
  WHERE l.requirement_id = r.id
  ORDER BY vd.expiry_date DESC NULLS LAST, vd.created_at DESC
  LIMIT 1
) d ON true
WHERE r.active;

GRANT SELECT ON public.account_compliance_status TO authenticated;

-- Account-level rollup. Deliberately low-detail and SECURITY DEFINER so a
-- crew member on a job can see "this account's paperwork has lapsed" without
-- being able to read the certificates themselves.
CREATE OR REPLACE FUNCTION public.account_compliance_state(_account_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH s AS (
    SELECT r.mandatory,
           public.compliance_status_of(d.id IS NOT NULL, d.expiry_date, d.covered_amount,
                                       r.required_amount, r.renewal_lead_days) AS status
    FROM public.account_compliance_requirements r
    LEFT JOIN LATERAL (
      SELECT vd.* FROM public.compliance_requirement_documents l
      JOIN public.vendor_documents vd ON vd.id = l.document_id
      WHERE l.requirement_id = r.id
      ORDER BY vd.expiry_date DESC NULLS LAST, vd.created_at DESC LIMIT 1
    ) d ON true
    WHERE r.account_id = _account_id AND r.active
  )
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM s) THEN 'none'
    WHEN EXISTS (SELECT 1 FROM s WHERE mandatory AND status = 'expired') THEN 'expired'
    WHEN EXISTS (SELECT 1 FROM s WHERE mandatory AND status = 'insufficient') THEN 'insufficient'
    WHEN EXISTS (SELECT 1 FROM s WHERE mandatory AND status = 'missing') THEN 'missing'
    WHEN EXISTS (SELECT 1 FROM s WHERE status = 'expiring_soon') THEN 'expiring_soon'
    WHEN EXISTS (SELECT 1 FROM s WHERE status IN ('expired','insufficient','missing')) THEN 'attention'
    ELSE 'compliant'
  END;
$$;

REVOKE ALL ON FUNCTION public.account_compliance_state(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.account_compliance_state(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.compliance_status_of(boolean, date, numeric, numeric, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.compliance_status_of(boolean, date, numeric, numeric, integer) TO authenticated, service_role;

-- 6. Alerts: the account's own lead time, then 30 / 14 / 7 and expiry ---------

CREATE OR REPLACE FUNCTION public.run_compliance_alerts()
RETURNS TABLE(notified integer, tagged integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  rec record; u uuid; n_notified integer := 0; n_tagged integer := 0;
  coi_tag uuid; milestones integer[]; label text;
BEGIN
  SELECT id INTO coi_tag FROM public.tags WHERE name = 'COI EXPIRING' LIMIT 1;

  FOR rec IN
    SELECT r.id, r.account_id, r.requirement_type, r.renewal_lead_days, r.required_amount,
           r.required_currency, a.name AS account_name, a.assigned_rep, a.location_id,
           d.expiry_date, (d.expiry_date - current_date) AS days_left
    FROM public.account_compliance_requirements r
    JOIN public.accounts a ON a.id = r.account_id
    JOIN LATERAL (
      SELECT vd.* FROM public.compliance_requirement_documents l
      JOIN public.vendor_documents vd ON vd.id = l.document_id
      WHERE l.requirement_id = r.id
      ORDER BY vd.expiry_date DESC NULLS LAST, vd.created_at DESC LIMIT 1
    ) d ON true
    WHERE r.active AND d.expiry_date IS NOT NULL
  LOOP
    milestones := ARRAY[GREATEST(COALESCE(rec.renewal_lead_days, 30), 0), 30, 14, 7, 0];
    CONTINUE WHEN NOT (rec.days_left = ANY (milestones));

    label := COALESCE((SELECT v.label FROM public.option_list_values v
                       JOIN public.option_lists ol ON ol.id = v.list_id
                       WHERE ol.key = 'compliance_requirement_type' AND v.key = rec.requirement_type),
                      rec.requirement_type);

    FOR u IN
      SELECT DISTINCT x FROM (
        SELECT rec.assigned_rep AS x
        UNION SELECT ur.user_id FROM public.user_roles ur WHERE ur.role IN ('sales_head','admin','owner')
      ) t WHERE x IS NOT NULL
    LOOP
      CONTINUE WHEN EXISTS (
        SELECT 1 FROM public.notifications n
        WHERE n.user_id = u AND n.entity_type = 'compliance_requirement'
          AND n.entity_id = rec.id AND n.created_at > now() - interval '20 hours');

      INSERT INTO public.notifications (user_id, type, title, body, entity_type, entity_id, href, priority)
      VALUES (
        u, 'vendor_doc_expiring',
        CASE WHEN rec.days_left <= 0
             THEN format('%s expired: %s', label, rec.account_name)
             ELSE format('%s expires in %s days: %s', label, rec.days_left, rec.account_name) END,
        CASE WHEN rec.required_amount IS NOT NULL
             THEN format('%s requires %s %s of %s.', rec.account_name, rec.required_currency,
                         to_char(rec.required_amount, 'FM999,999,999'), label)
             ELSE format('%s requires a current %s.', rec.account_name, label) END,
        'compliance_requirement', rec.id, '/accounts/' || rec.account_id,
        CASE WHEN rec.days_left <= 7 THEN 'high'::notification_priority ELSE 'normal'::notification_priority END
      );
      n_notified := n_notified + 1;
    END LOOP;
  END LOOP;

  -- Keep the COI EXPIRING label truthful so list views can filter on it.
  IF coi_tag IS NOT NULL THEN
    WITH flagged AS (
      SELECT a.id FROM public.accounts a
      WHERE public.account_compliance_state(a.id) IN ('expired','expiring_soon','insufficient','missing','attention')
    ), ins AS (
      INSERT INTO public.account_tags (account_id, tag_id)
      SELECT id, coi_tag FROM flagged
      ON CONFLICT DO NOTHING
      RETURNING 1
    ), del AS (
      DELETE FROM public.account_tags t
      WHERE t.tag_id = coi_tag AND t.account_id NOT IN (SELECT id FROM flagged)
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM ins) + (SELECT count(*) FROM del) INTO n_tagged;
  END IF;

  notified := n_notified; tagged := COALESCE(n_tagged, 0); RETURN NEXT;
END; $$;

REVOKE ALL ON FUNCTION public.run_compliance_alerts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.run_compliance_alerts() TO service_role;

-- 7. Compliance is a stalled-record type like any other -----------------------

ALTER TYPE public.escalation_record_type ADD VALUE IF NOT EXISTS 'compliance';

CREATE OR REPLACE FUNCTION public.record_last_movement(_type escalation_record_type, _id uuid)
RETURNS timestamp with time zone
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $function$
DECLARE ts timestamptz;
BEGIN
  IF _type::text = 'invoice' THEN
    SELECT GREATEST(
      COALESCE(i.updated_at, i.created_at),
      COALESCE((SELECT max(p.created_at) FROM invoice_payments p WHERE p.invoice_id = i.id), 'epoch'::timestamptz),
      COALESCE((SELECT max(e.sent_at) FROM email_messages e WHERE e.invoice_id = i.id), 'epoch'::timestamptz),
      COALESCE(i.sent_at, 'epoch'::timestamptz)
    ) INTO ts FROM invoices i WHERE i.id = _id;
  ELSIF _type::text = 'estimate' THEN
    SELECT GREATEST(
      COALESCE(q.updated_at, q.created_at),
      COALESCE(q.submitted_at, 'epoch'::timestamptz),
      COALESCE((SELECT max(e.sent_at) FROM email_messages e WHERE e.job_id = q.job_id), 'epoch'::timestamptz)
    ) INTO ts FROM quotes q WHERE q.id = _id;
  ELSIF _type::text = 'job' THEN
    SELECT GREATEST(
      COALESCE(j.updated_at, j.created_at),
      COALESCE((SELECT max(h.changed_at) FROM job_status_history h WHERE h.job_id = j.id), 'epoch'::timestamptz),
      COALESCE((SELECT max(n.created_at) FROM job_notes n WHERE n.job_id = j.id), 'epoch'::timestamptz),
      COALESCE((SELECT max(e.sent_at) FROM email_messages e WHERE e.job_id = j.id), 'epoch'::timestamptz),
      COALESCE((SELECT max(t.created_at) FROM time_entries t WHERE t.job_id = j.id), 'epoch'::timestamptz)
    ) INTO ts FROM jobs j WHERE j.id = _id;
  ELSIF _type::text = 'account' THEN
    SELECT GREATEST(
      COALESCE(a.updated_at, a.created_at),
      COALESCE(a.stage_changed_at, 'epoch'::timestamptz),
      COALESCE((SELECT max(t.occurred_at) FROM touchpoints t WHERE t.account_id = a.id), 'epoch'::timestamptz),
      COALESCE((SELECT max(e.sent_at) FROM email_messages e WHERE e.account_id = a.id), 'epoch'::timestamptz)
    ) INTO ts FROM accounts a WHERE a.id = _id;
  ELSIF _type::text = 'lead' THEN
    SELECT GREATEST(
      COALESCE(l.updated_at, l.created_at),
      COALESCE(l.stage_changed_at, 'epoch'::timestamptz),
      COALESCE((SELECT max(c.created_at) FROM contact_attempts c WHERE c.lead_id = l.id), 'epoch'::timestamptz),
      COALESCE((SELECT max(n.created_at) FROM lead_notes n WHERE n.lead_id = l.id), 'epoch'::timestamptz)
    ) INTO ts FROM fire_leads l WHERE l.id = _id;
  ELSIF _type::text = 'compliance' THEN
    -- Movement on a compliance line is somebody editing it or attaching a
    -- newer document; the expiry date passing is not movement.
    SELECT GREATEST(
      COALESCE(r.updated_at, r.created_at),
      COALESCE((SELECT max(vd.updated_at)
                  FROM compliance_requirement_documents l
                  JOIN vendor_documents vd ON vd.id = l.document_id
                 WHERE l.requirement_id = r.id), 'epoch'::timestamptz)
    ) INTO ts FROM account_compliance_requirements r WHERE r.id = _id;
  END IF;
  RETURN ts;
END; $function$;