
CREATE TYPE public.network_membership_status AS ENUM ('credentialing','compliant','lapsed');

CREATE TABLE public.networks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  code text,
  website text,
  notes text,
  active boolean NOT NULL DEFAULT true,
  is_demo boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES auth.users,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.networks TO authenticated;
GRANT ALL ON public.networks TO service_role;
ALTER TABLE public.networks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "networks_read" ON public.networks FOR SELECT TO authenticated USING (true);
CREATE POLICY "networks_manage" ON public.networks FOR ALL TO authenticated
  USING (public.has_role((SELECT auth.uid()), 'admin') OR public.has_role((SELECT auth.uid()), 'owner'))
  WITH CHECK (public.has_role((SELECT auth.uid()), 'admin') OR public.has_role((SELECT auth.uid()), 'owner'));

CREATE TABLE public.network_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  network_id uuid NOT NULL REFERENCES public.networks(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  entity_name text NOT NULL,
  member_id text,
  status public.network_membership_status NOT NULL DEFAULT 'credentialing',
  states_serviced text[] NOT NULL DEFAULT '{}',
  programs text[] NOT NULL DEFAULT '{}',
  joined_on date,
  renews_on date,
  notes text,
  active boolean NOT NULL DEFAULT true,
  is_demo boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES auth.users,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (network_id, location_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.network_memberships TO authenticated;
GRANT ALL ON public.network_memberships TO service_role;
ALTER TABLE public.network_memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY "network_memberships_read" ON public.network_memberships FOR SELECT TO authenticated USING (true);
CREATE POLICY "network_memberships_manage" ON public.network_memberships FOR ALL TO authenticated
  USING (public.can_manage_location((SELECT auth.uid()), location_id))
  WITH CHECK (public.can_manage_location((SELECT auth.uid()), location_id));

CREATE TABLE public.network_requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  membership_id uuid NOT NULL REFERENCES public.network_memberships(id) ON DELETE CASCADE,
  requirement_type text NOT NULL,
  mandatory boolean NOT NULL DEFAULT true,
  required_amount numeric,
  required_currency text NOT NULL DEFAULT 'USD',
  required_value text,
  renewal_lead_days integer NOT NULL DEFAULT 30,
  notes text,
  active boolean NOT NULL DEFAULT true,
  is_demo boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES auth.users,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (membership_id, requirement_type)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.network_requirements TO authenticated;
GRANT ALL ON public.network_requirements TO service_role;
ALTER TABLE public.network_requirements ENABLE ROW LEVEL SECURITY;
CREATE POLICY "network_requirements_read" ON public.network_requirements FOR SELECT TO authenticated USING (true);
CREATE POLICY "network_requirements_manage" ON public.network_requirements FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.network_memberships m WHERE m.id = membership_id AND public.can_manage_location((SELECT auth.uid()), m.location_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.network_memberships m WHERE m.id = membership_id AND public.can_manage_location((SELECT auth.uid()), m.location_id)));

CREATE TRIGGER trg_networks_updated BEFORE UPDATE ON public.networks
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_network_memberships_updated BEFORE UPDATE ON public.network_memberships
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_network_requirements_updated BEFORE UPDATE ON public.network_requirements
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Same shape as account_compliance_status so one UI reads both tiers.
CREATE VIEW public.network_compliance_status
WITH (security_invoker = true) AS
SELECT r.id AS requirement_id,
       r.membership_id,
       m.network_id,
       n.name AS network_name,
       m.location_id,
       m.entity_name,
       r.requirement_type,
       r.mandatory,
       r.required_amount,
       r.required_currency,
       r.required_value,
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
       c.expiry_date - CURRENT_DATE AS days_to_expiry,
       public.compliance_status_of(c.id IS NOT NULL, c.expiry_date, c.limit_occurrence, r.required_amount, r.renewal_lead_days) AS status
FROM public.network_requirements r
JOIN public.network_memberships m ON m.id = r.membership_id
JOIN public.networks n ON n.id = m.network_id
LEFT JOIN LATERAL (
  SELECT cc.* FROM public.company_credentials cc
  WHERE cc.active AND cc.kind = r.requirement_type
    AND (cc.holder_location_id IS NULL OR cc.holder_location_id = m.location_id)
  ORDER BY (cc.limit_occurrence IS NOT NULL AND r.required_amount IS NOT NULL
            AND cc.limit_occurrence >= r.required_amount) DESC,
           cc.expiry_date DESC NULLS LAST, cc.created_at DESC
  LIMIT 1
) c ON true
WHERE r.active AND m.active;

GRANT SELECT ON public.network_compliance_status TO authenticated;
GRANT SELECT ON public.network_compliance_status TO service_role;

-- "16 of 16 complete" plus the next date that will break it.
CREATE OR REPLACE FUNCTION public.network_membership_progress(_membership_id uuid)
RETURNS TABLE (total integer, complete integer, next_expiry date, worst text)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT count(*)::int,
         count(*) FILTER (WHERE status = 'satisfied')::int,
         min(expiry_date) FILTER (WHERE status IN ('satisfied','expiring_soon')),
         CASE
           WHEN bool_or(mandatory AND status = 'expired') THEN 'expired'
           WHEN bool_or(mandatory AND status = 'insufficient') THEN 'insufficient'
           WHEN bool_or(mandatory AND status = 'missing') THEN 'missing'
           WHEN bool_or(status = 'expiring_soon') THEN 'expiring_soon'
           WHEN count(*) = 0 THEN 'none'
           ELSE 'compliant'
         END
  FROM public.network_compliance_status
  WHERE membership_id = _membership_id;
$$;
REVOKE ALL ON FUNCTION public.network_membership_progress(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.network_membership_progress(uuid) TO authenticated, service_role;

-- One expiry, every consequence: which networks and how many accounts rely on it.
CREATE OR REPLACE FUNCTION public.credential_impact(_credential_id uuid)
RETURNS TABLE (network_labels text[], account_count integer, account_names text[])
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  WITH cred AS (SELECT * FROM public.company_credentials WHERE id = _credential_id),
  nets AS (
    SELECT DISTINCT n.network_name || ' ' || COALESCE(l.code, l.name, '') AS label
    FROM public.network_compliance_status n
    JOIN cred ON cred.id = n.credential_id
    LEFT JOIN public.locations l ON l.id = n.location_id
  ),
  accts AS (
    SELECT DISTINCT a.account_name
    FROM public.account_compliance_status a
    JOIN cred ON cred.id = a.credential_id
    WHERE a.account_name IS NOT NULL
  )
  SELECT COALESCE((SELECT array_agg(label ORDER BY label) FROM nets), '{}'),
         (SELECT count(*)::int FROM accts),
         COALESCE((SELECT array_agg(account_name ORDER BY account_name) FROM accts), '{}');
$$;
REVOKE ALL ON FUNCTION public.credential_impact(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.credential_impact(uuid) TO authenticated, service_role;
