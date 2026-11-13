-- 1. Central credentials library ------------------------------------------
CREATE TABLE public.company_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category text NOT NULL CHECK (category IN ('insurance','certification','licence')),
  kind text NOT NULL,
  name text,
  issuer text,
  carrier text,
  policy_number text,
  limit_occurrence numeric(14,2),
  limit_aggregate numeric(14,2),
  currency text NOT NULL DEFAULT 'USD',
  effective_date date,
  expiry_date date,
  state_code text,
  holder_location_id uuid REFERENCES public.locations(id) ON DELETE CASCADE,
  holder_user_id uuid REFERENCES public.profiles(user_id) ON DELETE SET NULL,
  document_id uuid REFERENCES public.vendor_documents(id) ON DELETE SET NULL,
  notes text,
  renewal_lead_days integer NOT NULL DEFAULT 30,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES public.profiles(user_id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  is_demo boolean NOT NULL DEFAULT false
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.company_credentials TO authenticated;
GRANT ALL ON public.company_credentials TO service_role;

ALTER TABLE public.company_credentials ENABLE ROW LEVEL SECURITY;

CREATE POLICY "cc_select" ON public.company_credentials
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "cc_insert" ON public.company_credentials
  FOR INSERT TO authenticated WITH CHECK (
    public.is_privileged((SELECT auth.uid()))
    OR (holder_location_id IS NOT NULL
        AND public.can_manage_location((SELECT auth.uid()), holder_location_id))
  );

CREATE POLICY "cc_update" ON public.company_credentials
  FOR UPDATE TO authenticated USING (
    public.is_privileged((SELECT auth.uid()))
    OR (holder_location_id IS NOT NULL
        AND public.can_manage_location((SELECT auth.uid()), holder_location_id))
  );

CREATE POLICY "cc_delete" ON public.company_credentials
  FOR DELETE TO authenticated USING (public.is_privileged((SELECT auth.uid())));

CREATE INDEX cc_kind_idx ON public.company_credentials (kind) WHERE active;
CREATE INDEX cc_location_idx ON public.company_credentials (holder_location_id);
CREATE INDEX cc_user_idx ON public.company_credentials (holder_user_id);
CREATE INDEX cc_expiry_idx ON public.company_credentials (expiry_date);
CREATE INDEX cc_is_demo_idx ON public.company_credentials (is_demo) WHERE is_demo;

CREATE TRIGGER trg_cc_updated BEFORE UPDATE ON public.company_credentials
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 2. Requirement -> credential matching ------------------------------------
-- One definition of "best credential we hold for this requirement at this
-- office": prefer one that meets the limit, then the furthest expiry.
DROP VIEW IF EXISTS public.account_compliance_status;
CREATE VIEW public.account_compliance_status
WITH (security_invoker = true) AS
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
  c.id                AS credential_id,
  c.category,
  c.kind,
  c.name              AS credential_name,
  c.document_id,
  c.issuer,
  c.carrier,
  c.policy_number,
  c.effective_date,
  c.expiry_date,
  c.limit_occurrence  AS covered_amount,
  c.limit_aggregate,
  c.currency,
  c.state_code,
  c.holder_location_id,
  c.holder_user_id,
  c.expiry_date - CURRENT_DATE AS days_to_expiry,
  public.compliance_status_of(
    c.id IS NOT NULL, c.expiry_date, c.limit_occurrence,
    r.required_amount, r.renewal_lead_days) AS status
FROM public.account_compliance_requirements r
JOIN public.accounts a ON a.id = r.account_id
LEFT JOIN LATERAL (
  SELECT cc.*
  FROM public.company_credentials cc
  WHERE cc.active
    AND cc.kind = r.requirement_type
    AND (cc.holder_location_id IS NULL OR cc.holder_location_id = a.location_id)
  ORDER BY
    (cc.limit_occurrence IS NOT NULL
      AND r.required_amount IS NOT NULL
      AND cc.limit_occurrence >= r.required_amount) DESC,
    cc.expiry_date DESC NULLS LAST,
    cc.created_at DESC
  LIMIT 1
) c ON true
WHERE r.active;

GRANT SELECT ON public.account_compliance_status TO authenticated;

CREATE OR REPLACE FUNCTION public.account_compliance_state(_account_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH s AS (
    SELECT r.mandatory,
           public.compliance_status_of(c.id IS NOT NULL, c.expiry_date,
             c.limit_occurrence, r.required_amount, r.renewal_lead_days) AS status
    FROM public.account_compliance_requirements r
    JOIN public.accounts a ON a.id = r.account_id
    LEFT JOIN LATERAL (
      SELECT cc.* FROM public.company_credentials cc
      WHERE cc.active AND cc.kind = r.requirement_type
        AND (cc.holder_location_id IS NULL OR cc.holder_location_id = a.location_id)
      ORDER BY (cc.limit_occurrence IS NOT NULL AND r.required_amount IS NOT NULL
                AND cc.limit_occurrence >= r.required_amount) DESC,
               cc.expiry_date DESC NULLS LAST, cc.created_at DESC
      LIMIT 1
    ) c ON true
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

REVOKE EXECUTE ON FUNCTION public.account_compliance_state(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.account_compliance_state(uuid) TO authenticated;

-- 3. Which clients an expiry puts at risk ----------------------------------
CREATE OR REPLACE FUNCTION public.credential_accounts_at_risk(_credential_id uuid)
RETURNS TABLE (account_id uuid, account_name text, location_id uuid, requirement_type text)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT a.id, a.name, a.location_id, r.requirement_type
  FROM public.company_credentials cc
  JOIN public.account_compliance_requirements r ON r.requirement_type = cc.kind AND r.active
  JOIN public.accounts a ON a.id = r.account_id
  WHERE cc.id = _credential_id
    AND (cc.holder_location_id IS NULL OR cc.holder_location_id = a.location_id)
  ORDER BY a.name;
$$;

REVOKE EXECUTE ON FUNCTION public.credential_accounts_at_risk(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.credential_accounts_at_risk(uuid) TO authenticated;