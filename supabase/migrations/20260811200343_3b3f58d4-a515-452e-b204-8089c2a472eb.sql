-- 1. Tags take over gift policy ------------------------------------------
INSERT INTO public.tags (name, color, scopes, sort_order) VALUES
  ('GIFTS OK', '#0A6B45', '{contact,account}', 40),
  ('NO GIFTS', '#B91C1C', '{contact,account}', 41),
  ('OFF LIMITS', '#111827', '{contact,account}', 42),
  ('LEGAL REVIEW', '#7A1FA2', '{contact,account}', 43)
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.contact_tags (contact_id, tag_id)
SELECT c.id, t.id
FROM public.contacts c
JOIN public.tags t ON t.name = 'NO GIFTS'
WHERE c.gift_policy = 'prohibited'
ON CONFLICT DO NOTHING;

INSERT INTO public.contact_tags (contact_id, tag_id)
SELECT c.id, t.id
FROM public.contacts c
JOIN public.tags t ON t.name = 'LEGAL REVIEW'
WHERE c.gift_policy = 'approval_required'
ON CONFLICT DO NOTHING;

DROP VIEW IF EXISTS public.account_fire_rollup;
ALTER TABLE public.contacts DROP COLUMN gift_policy;

CREATE VIEW public.account_fire_rollup WITH (security_invoker = true) AS
 SELECT a.id AS account_id, a.name, a.status, a.stage, a.stage_id, a.pipeline_id,
    a.priority, a.estimated_annual_value, a.account_type, a.location_id, a.assigned_rep,
    a.notes, a.updated_at,
    COALESCE(l.lead_count, 0::bigint) AS lead_count,
    COALESCE(l.open_count, 0::bigint) AS open_count,
    l.last_loss_date,
    COALESCE(l.units_vacated, 0::bigint) AS units_vacated,
    l.mailing_address,
    c.primary_contact_id, c.primary_contact_name, c.primary_contact_email, c.primary_contact_phone,
    t.last_touch_at, t.last_in_person_at,
    COALESCE(t.touch_count, 0::bigint) AS touch_count,
    a.approval_state, a.approval_due_on
   FROM (((public.accounts a
     LEFT JOIN LATERAL ( SELECT count(*) AS lead_count,
            count(*) FILTER (WHERE fl.status = 'open'::lead_status AND fl.rescind_date IS NULL) AS open_count,
            max(fl.incident_date) AS last_loss_date,
            COALESCE(sum(fl.units_vacated), 0::bigint) AS units_vacated,
            (array_remove(array_agg(fl.owner_mailing_address ORDER BY fl.incident_date DESC NULLS LAST), NULL::text))[1] AS mailing_address
           FROM public.fire_leads fl WHERE fl.account_id = a.id) l ON true)
     LEFT JOIN LATERAL ( SELECT ct.id AS primary_contact_id, ct.full_name AS primary_contact_name,
            ct.email AS primary_contact_email, ct.phone AS primary_contact_phone
           FROM public.contacts ct WHERE ct.account_id = a.id
          ORDER BY ct.is_primary DESC, ct.created_at LIMIT 1) c ON true)
     LEFT JOIN LATERAL ( SELECT max(tp.occurred_at) AS last_touch_at,
            max(tp.occurred_at) FILTER (WHERE tp.type = 'meeting_in_person'::touchpoint_type) AS last_in_person_at,
            count(*) AS touch_count
           FROM public.touchpoints tp WHERE tp.account_id = a.id) t ON true);

GRANT SELECT ON public.account_fire_rollup TO authenticated;

-- 2. Contact fields --------------------------------------------------------
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS office_phone text,
  ADD COLUMN IF NOT EXISTS office_extension text,
  ADD COLUMN IF NOT EXISTS linkedin_url text,
  ADD COLUMN IF NOT EXISTS is_decision_maker boolean NOT NULL DEFAULT false;

UPDATE public.contacts SET is_decision_maker = true WHERE decision_role = 'decision_maker';

-- 3. Activities carry the person -------------------------------------------
ALTER TABLE public.contact_attempts
  ADD COLUMN IF NOT EXISTS contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS account_id uuid REFERENCES public.accounts(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS contact_attempts_contact_idx ON public.contact_attempts(contact_id);
CREATE INDEX IF NOT EXISTS contact_attempts_account_idx ON public.contact_attempts(account_id);

-- 4. Accounts: what they do, and which offices serve them -------------------
ALTER TABLE public.accounts DROP COLUMN IF EXISTS loss_types;
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS what_they_do text[] NOT NULL DEFAULT '{}';

INSERT INTO public.option_lists (key, label)
VALUES ('account_function', 'What they do')
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.option_list_values (list_id, key, label, sort_order, requires_detail)
SELECT ol.id, v.key, v.label, v.sort_order, v.requires_detail
FROM public.option_lists ol,
  (VALUES
    ('property_management', 'Property management', 10, false),
    ('carrier', 'Carrier', 20, false),
    ('tpa_network', 'TPA / network', 30, false),
    ('broker', 'Broker', 40, false),
    ('public_adjuster', 'Public adjuster', 50, false),
    ('plumber_trade', 'Plumber / trade', 60, false),
    ('general_contractor', 'General contractor', 70, false),
    ('municipality', 'Municipality', 80, false),
    ('other', 'Other', 90, true)
  ) AS v(key, label, sort_order, requires_detail)
WHERE ol.key = 'account_function'
ON CONFLICT DO NOTHING;

UPDATE public.accounts
SET what_they_do = ARRAY['property_management']
WHERE account_type = 'property_management' AND what_they_do = '{}';

CREATE TABLE IF NOT EXISTS public.account_locations (
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  is_demo boolean NOT NULL DEFAULT false,
  PRIMARY KEY (account_id, location_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.account_locations TO authenticated;
GRANT ALL ON public.account_locations TO service_role;
ALTER TABLE public.account_locations ENABLE ROW LEVEL SECURITY;

CREATE POLICY account_locations_select ON public.account_locations
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.accounts a
                 WHERE a.id = account_id
                   AND public.can_view_location((SELECT auth.uid()), a.location_id)));

CREATE POLICY account_locations_write ON public.account_locations
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.accounts a
                 WHERE a.id = account_id
                   AND (a.assigned_rep = (SELECT auth.uid())
                        OR public.can_manage_location((SELECT auth.uid()), a.location_id))))
  WITH CHECK (EXISTS (SELECT 1 FROM public.accounts a
                 WHERE a.id = account_id
                   AND (a.assigned_rep = (SELECT auth.uid())
                        OR public.can_manage_location((SELECT auth.uid()), a.location_id))));

-- The owning office stays the RLS anchor; every account is also served by it.
INSERT INTO public.account_locations (account_id, location_id)
SELECT id, location_id FROM public.accounts
ON CONFLICT DO NOTHING;

-- 5. Compliance resolves against every serving office -----------------------
CREATE OR REPLACE VIEW public.account_compliance_status
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
    (c.expiry_date - CURRENT_DATE) AS days_to_expiry,
    public.compliance_status_of((c.id IS NOT NULL), c.expiry_date, c.limit_occurrence, r.required_amount, r.renewal_lead_days) AS status
   FROM ((public.account_compliance_requirements r
     JOIN public.accounts a ON ((a.id = r.account_id)))
     LEFT JOIN LATERAL ( SELECT cc.id, cc.category, cc.kind, cc.name, cc.issuer, cc.carrier,
            cc.policy_number, cc.limit_occurrence, cc.limit_aggregate, cc.currency,
            cc.effective_date, cc.expiry_date, cc.state_code, cc.holder_location_id,
            cc.holder_user_id, cc.document_id, cc.notes, cc.renewal_lead_days, cc.active,
            cc.created_by, cc.created_at, cc.updated_at, cc.is_demo
           FROM public.company_credentials cc
          WHERE (cc.active AND (cc.kind = r.requirement_type)
             AND (cc.holder_location_id IS NULL
                  OR cc.holder_location_id = a.location_id
                  OR EXISTS (SELECT 1 FROM public.account_locations al
                             WHERE al.account_id = a.id AND al.location_id = cc.holder_location_id)))
          ORDER BY ((cc.limit_occurrence IS NOT NULL) AND (r.required_amount IS NOT NULL) AND (cc.limit_occurrence >= r.required_amount)) DESC, cc.expiry_date DESC NULLS LAST, cc.created_at DESC
         LIMIT 1) c ON (true))
  WHERE r.active;

GRANT SELECT ON public.account_compliance_status TO authenticated;
