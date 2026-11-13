-- 1. The direction ----------------------------------------------------------

ALTER TABLE public.account_compliance_requirements
  ADD COLUMN IF NOT EXISTS direction text NOT NULL DEFAULT 'gsr_to_client';

ALTER TABLE public.account_compliance_requirements
  DROP CONSTRAINT IF EXISTS account_compliance_requirements_direction_check;
ALTER TABLE public.account_compliance_requirements
  ADD CONSTRAINT account_compliance_requirements_direction_check
  CHECK (direction IN ('gsr_to_client', 'client_to_gsr'));

COMMENT ON COLUMN public.account_compliance_requirements.direction IS
  'Who owes this paperwork. gsr_to_client: Gold Star must hold it to stay on the client''s approved-vendor list (the original and only meaning before 20260914120000, hence the default). client_to_gsr: Gold Star is waiting on the client for it. Not to be confused with vendor_documents, which is what a SUBCONTRACTOR owes Gold Star.';

-- 2. Uniqueness is per direction --------------------------------------------
-- The original constraint was created inline by CREATE TABLE, so it carries the
-- default name; both spellings are dropped in case an environment differs.

ALTER TABLE public.account_compliance_requirements
  DROP CONSTRAINT IF EXISTS account_compliance_requirements_account_id_requirement_type_key;
ALTER TABLE public.account_compliance_requirements
  DROP CONSTRAINT IF EXISTS account_compliance_requirements_account_requirement_uniq;
ALTER TABLE public.account_compliance_requirements
  DROP CONSTRAINT IF EXISTS account_compliance_requirements_account_type_direction_key;
ALTER TABLE public.account_compliance_requirements
  ADD CONSTRAINT account_compliance_requirements_account_type_direction_key
  UNIQUE (account_id, requirement_type, direction);

CREATE INDEX IF NOT EXISTS acr_account_direction_idx
  ON public.account_compliance_requirements (account_id, direction)
  WHERE active;

-- 3. The view: expose direction, and never let GSR's own paperwork satisfy a
--    requirement the CLIENT owes. Otherwise verbatim from 20260820102608.

DROP VIEW IF EXISTS public.account_compliance_status;
CREATE VIEW public.account_compliance_status
WITH (security_invoker = true) AS
SELECT r.id AS requirement_id,
  r.account_id,
  a.name AS account_name,
  a.location_id,
  r.requirement_type,
  r.direction,
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
  WHERE r.direction = 'gsr_to_client'
    AND cc.active AND cc.kind = r.requirement_type
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

COMMENT ON VIEW public.account_compliance_status IS
  'One row per active account compliance requirement, in both directions, with the document answering it and the derived status. A client_to_gsr row is never matched against company_credentials: Gold Star''s own W9 does not satisfy a W9 the client owes us. See 20260914120000.';