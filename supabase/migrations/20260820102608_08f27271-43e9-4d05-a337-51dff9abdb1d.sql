
-- 1. Send log ---------------------------------------------------------------
CREATE TABLE public.compliance_send_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  requirement_id uuid REFERENCES public.account_compliance_requirements(id) ON DELETE SET NULL,
  file_id uuid REFERENCES public.compliance_requirement_files(id) ON DELETE SET NULL,
  requirement_label text,
  file_name text,
  to_email text NOT NULL,
  subject text,
  status text NOT NULL DEFAULT 'sent',
  note text,
  sent_by uuid,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.compliance_send_log TO authenticated;
GRANT ALL ON public.compliance_send_log TO service_role;

ALTER TABLE public.compliance_send_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY csl_select ON public.compliance_send_log FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = account_id
  AND (a.created_by = (SELECT auth.uid()) OR a.assigned_rep = (SELECT auth.uid())
       OR public.can_view_location((SELECT auth.uid()), a.location_id))));

CREATE POLICY csl_insert ON public.compliance_send_log FOR INSERT TO authenticated
WITH CHECK (EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = account_id
  AND (a.assigned_rep = (SELECT auth.uid()) OR public.can_manage_location((SELECT auth.uid()), a.location_id))));

CREATE POLICY csl_update ON public.compliance_send_log FOR UPDATE TO authenticated
USING (sent_by = (SELECT auth.uid()) OR public.is_privileged((SELECT auth.uid())));

CREATE POLICY csl_delete ON public.compliance_send_log FOR DELETE TO authenticated
USING (public.is_privileged((SELECT auth.uid())));

CREATE INDEX csl_account_idx ON public.compliance_send_log (account_id, created_at DESC);

CREATE TRIGGER compliance_send_log_updated
BEFORE UPDATE ON public.compliance_send_log
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 2. Lead days default + expiry-day semantics --------------------------------
ALTER TABLE public.account_compliance_requirements ALTER COLUMN renewal_lead_days SET DEFAULT 7;

CREATE OR REPLACE FUNCTION public.compliance_status_of(_has_doc boolean, _expiry date, _covered numeric, _required numeric, _lead_days integer)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path TO 'public' AS $function$
  SELECT CASE
    WHEN NOT _has_doc THEN 'missing'
    WHEN _expiry IS NOT NULL AND _expiry <= current_date THEN 'expired'
    WHEN _required IS NOT NULL AND (_covered IS NULL OR _covered < _required) THEN 'insufficient'
    WHEN _expiry IS NOT NULL
      AND _expiry <= current_date + GREATEST(COALESCE(_lead_days, 7), 0) THEN 'expiring_soon'
    ELSE 'satisfied'
  END;
$function$;

-- 3. View also reads the certificate uploaded against the account ------------
DROP VIEW IF EXISTS public.account_compliance_status;
CREATE VIEW public.account_compliance_status
WITH (security_invoker = true) AS
SELECT r.id AS requirement_id,
  r.account_id,
  a.name AS account_name,
  a.location_id,
  r.requirement_type,
  r.mandatory,
  r.required_amount,
  r.required_currency,
  r.required_value,
  r.must_name_account,
  r.renewal_lead_days,
  r.notes,
  c.id AS credential_id,
  c.category,
  c.kind,
  c.name AS credential_name,
  c.document_id,
  c.issuer,
  c.carrier,
  c.policy_number,
  c.effective_date,
  c.expiry_date,
  c.limit_occurrence AS covered_amount,
  c.limit_aggregate,
  c.currency,
  c.state_code,
  c.holder_location_id,
  c.holder_user_id,
  f.id AS cert_file_id,
  f.file_name AS cert_file_name,
  f.expiry_date AS cert_expiry_date,
  f.policy_number AS cert_policy_number,
  LEAST(c.expiry_date, f.expiry_date) AS effective_expiry,
  LEAST(c.expiry_date, f.expiry_date) - CURRENT_DATE AS days_to_expiry,
  public.compliance_status_of(
    (c.id IS NOT NULL OR f.id IS NOT NULL),
    LEAST(c.expiry_date, f.expiry_date),
    c.limit_occurrence, r.required_amount, r.renewal_lead_days) AS status
FROM public.account_compliance_requirements r
JOIN public.accounts a ON a.id = r.account_id
LEFT JOIN LATERAL (
  SELECT cc.* FROM public.company_credentials cc
  WHERE cc.active AND cc.kind = r.requirement_type
    AND (cc.holder_location_id IS NULL OR cc.holder_location_id = a.location_id
         OR EXISTS (SELECT 1 FROM public.account_locations al
                    WHERE al.account_id = a.id AND al.location_id = cc.holder_location_id))
  ORDER BY (cc.limit_occurrence IS NOT NULL AND r.required_amount IS NOT NULL
            AND cc.limit_occurrence >= r.required_amount) DESC,
           cc.expiry_date DESC NULLS LAST, cc.created_at DESC
  LIMIT 1) c ON true
LEFT JOIN LATERAL (
  SELECT ff.* FROM public.compliance_requirement_files ff
  WHERE ff.requirement_id = r.id AND ff.slot = 'certificate' AND ff.is_current
  ORDER BY ff.created_at DESC LIMIT 1) f ON true
WHERE r.active;

GRANT SELECT ON public.account_compliance_status TO authenticated;

-- 4. Indicator honours renewal_lead_days and uploaded certificates -----------
CREATE OR REPLACE FUNCTION public.account_compliance_indicator(_account_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  WITH s AS (
    SELECT public.compliance_status_of(
             (c.id IS NOT NULL OR f.id IS NOT NULL),
             LEAST(c.expiry_date, f.expiry_date),
             c.limit_occurrence, r.required_amount, r.renewal_lead_days) AS status,
           LEAST(c.expiry_date, f.expiry_date) AS expiry,
           GREATEST(COALESCE(r.renewal_lead_days, 7), 0) AS lead_days
    FROM public.account_compliance_requirements r
    JOIN public.accounts a ON a.id = r.account_id
    LEFT JOIN LATERAL (
      SELECT cc.* FROM public.company_credentials cc
      WHERE cc.active AND cc.kind = r.requirement_type
        AND (cc.holder_location_id IS NULL OR cc.holder_location_id = a.location_id)
      ORDER BY (cc.limit_occurrence IS NOT NULL AND r.required_amount IS NOT NULL
                AND cc.limit_occurrence >= r.required_amount) DESC,
               cc.expiry_date DESC NULLS LAST, cc.created_at DESC
      LIMIT 1) c ON true
    LEFT JOIN LATERAL (
      SELECT ff.* FROM public.compliance_requirement_files ff
      WHERE ff.requirement_id = r.id AND ff.slot = 'certificate' AND ff.is_current
      ORDER BY ff.created_at DESC LIMIT 1) f ON true
    WHERE r.account_id = _account_id AND r.active
  )
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM s) THEN 'none'
    WHEN EXISTS (SELECT 1 FROM s WHERE status IN ('expired','missing','insufficient'))
      THEN 'not_compliant'
    WHEN EXISTS (SELECT 1 FROM s WHERE expiry IS NOT NULL AND expiry <= current_date + lead_days)
      THEN 'expiring'
    ELSE 'compliant'
  END;
$function$;

-- 5. Daily job also watches uploaded certificates ----------------------------
CREATE OR REPLACE FUNCTION public.run_compliance_alerts()
RETURNS TABLE(notified integer, tagged integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  rec record; u uuid; n_notified integer := 0; n_tagged integer := 0;
  coi_tag uuid; milestones integer[]; label text;
BEGIN
  SELECT id INTO coi_tag FROM public.tags WHERE name = 'COI EXPIRING' LIMIT 1;

  FOR rec IN
    SELECT s.requirement_id AS id, s.account_id, s.requirement_type, s.renewal_lead_days,
           s.required_amount, s.required_currency, s.account_name, a.assigned_rep,
           s.effective_expiry AS expiry_date, s.days_to_expiry AS days_left
    FROM public.account_compliance_status s
    JOIN public.accounts a ON a.id = s.account_id
    WHERE s.effective_expiry IS NOT NULL
  LOOP
    milestones := ARRAY[GREATEST(COALESCE(rec.renewal_lead_days, 7), 0), 30, 14, 7, 0];
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
        'compliance_requirement', rec.id, '/accounts/' || rec.account_id || '?section=compliance',
        CASE WHEN rec.days_left <= 7 THEN 'high'::notification_priority ELSE 'normal'::notification_priority END
      );
      n_notified := n_notified + 1;
    END LOOP;
  END LOOP;

  IF coi_tag IS NOT NULL THEN
    WITH flagged AS (
      SELECT a.id FROM public.accounts a
      WHERE public.account_compliance_indicator(a.id) IN ('not_compliant','expiring')
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
END; $function$;

-- 6. Demo data ---------------------------------------------------------------
INSERT INTO public.company_credentials (id, category, kind, name, carrier, issuer, policy_number,
  limit_occurrence, limit_aggregate, currency, effective_date, expiry_date, active, renewal_lead_days, is_demo)
VALUES
  ('cc000000-0000-4000-8000-000000000001','insurance','general_liability','Commercial General Liability','Hartford',NULL,'GL-4471902',
    2000000, 4000000, 'USD', current_date - 300, current_date + 180, true, 7, true),
  ('cc000000-0000-4000-8000-000000000002','insurance','workers_compensation','Workers Compensation','Travelers',NULL,'WC-88120',
    1000000, 1000000, 'USD', current_date - 320, current_date + 5, true, 7, true),
  ('cc000000-0000-4000-8000-000000000003','insurance','auto_liability','Auto Liability','Progressive Commercial',NULL,'AL-20913',
    1000000, 1000000, 'USD', current_date - 400, current_date - 3, true, 7, true),
  ('cc000000-0000-4000-8000-000000000004','certification','iicrc_certified_firm','IICRC Certified Firm',NULL,'IICRC','FIRM-559214',
    NULL, NULL, 'USD', current_date - 200, current_date + 240, true, 7, true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.account_compliance_requirements
  (id, account_id, requirement_type, mandatory, required_amount, required_value, must_name_account, renewal_lead_days, active, is_demo)
VALUES
  -- Current / green
  ('ab000000-0000-4000-8000-000000000001','ac000000-0000-4000-8000-000000000121','general_liability',true,2000000,NULL,true,7,true,true),
  ('ab000000-0000-4000-8000-000000000002','ac000000-0000-4000-8000-000000000121','iicrc_certified_firm',true,NULL,NULL,false,7,true,true),
  -- Expiring in 5 days / amber
  ('ab000000-0000-4000-8000-000000000003','ac000000-0000-4000-8000-000000000122','workers_compensation',true,1000000,NULL,false,7,true,true),
  ('ab000000-0000-4000-8000-000000000004','ac000000-0000-4000-8000-000000000122','general_liability',true,2000000,NULL,true,7,true,true),
  -- Expired / red
  ('ab000000-0000-4000-8000-000000000005','ac000000-0000-4000-8000-000000000123','auto_liability',true,1000000,NULL,false,7,true,true),
  -- Missing credential entirely / red
  ('ab000000-0000-4000-8000-000000000006','ac000000-0000-4000-8000-000000000124','contractor_pollution',true,1000000,NULL,false,7,true,true),
  ('ab000000-0000-4000-8000-000000000007','ac000000-0000-4000-8000-000000000124','general_liability',true,2000000,NULL,true,7,true,true),
  -- Mixed
  ('ab000000-0000-4000-8000-000000000008','ac000000-0000-4000-8000-000000000125','state_contractor_licence',true,NULL,NULL,false,7,true,true),
  ('ab000000-0000-4000-8000-000000000009','ac000000-0000-4000-8000-000000000125','general_liability',true,2000000,NULL,true,7,true,true)
ON CONFLICT (id) DO NOTHING;

UPDATE public.accounts SET certificates_email = 'coi@netvendor.com'
WHERE id IN ('ac000000-0000-4000-8000-000000000121','ac000000-0000-4000-8000-000000000122');
UPDATE public.accounts SET certificates_email = 'compliance@patapscohousing.com'
WHERE id = 'ac000000-0000-4000-8000-000000000124';

INSERT INTO public.compliance_send_log
  (account_id, requirement_id, requirement_label, file_name, to_email, subject, status, sent_by, is_demo, created_at)
VALUES
  ('ac000000-0000-4000-8000-000000000121','ab000000-0000-4000-8000-000000000001','Commercial General Liability',
   'GoldStar-COI-GL-4471902.pdf','coi@netvendor.com','Certificate of insurance — Gold Star Restoration','sent',
   'd46260d7-d2fc-4b43-ba4a-c023346b1869', true, now() - interval '9 days'),
  ('ac000000-0000-4000-8000-000000000122','ab000000-0000-4000-8000-000000000003','Workers Compensation',
   'GoldStar-COI-WC-88120.pdf','coi@netvendor.com','Certificate of insurance — Gold Star Restoration','queued',
   'd46260d7-d2fc-4b43-ba4a-c023346b1869', true, now() - interval '2 days');
