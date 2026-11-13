CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 1. Enum: add 'regional' to app_role.
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'regional';

-- 2. New enums for the relationship-sales domain.
CREATE TYPE public.account_type AS ENUM ('property_management','commercial','residential','other');
CREATE TYPE public.account_status AS ENUM ('prospect','onboarding','active','dormant','lost');
CREATE TYPE public.contact_decision_role AS ENUM ('decision_maker','regional_manager','influencer','gatekeeper');
CREATE TYPE public.gift_policy AS ENUM ('unknown','open','approval_required','prohibited');
CREATE TYPE public.touchpoint_type AS ENUM ('call','email','meeting_in_person','meeting_virtual','gift','seasonal_send','other');

-- 3. Regions
CREATE TABLE public.regions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.regions TO authenticated;
GRANT ALL ON public.regions TO service_role;
ALTER TABLE public.regions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Signed-in users view regions" ON public.regions FOR SELECT TO authenticated USING (true);
CREATE POLICY "Admins manage regions" ON public.regions FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));

ALTER TABLE public.locations ADD COLUMN region_id uuid REFERENCES public.regions(id) ON DELETE SET NULL;

-- 4. Region members
CREATE TABLE public.region_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  region_id uuid NOT NULL REFERENCES public.regions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (region_id, user_id)
);
GRANT SELECT ON public.region_members TO authenticated;
GRANT ALL ON public.region_members TO service_role;
ALTER TABLE public.region_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins manage region_members" ON public.region_members FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "Users view own region memberships" ON public.region_members FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'::app_role));

-- 5. Helper (plpgsql so 'regional'::app_role cast is deferred).
CREATE OR REPLACE FUNCTION public.is_regional_for(_user_id uuid, _location_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF _user_id IS NULL OR _location_id IS NULL THEN
    RETURN false;
  END IF;
  IF NOT public.has_role(_user_id, 'regional'::app_role) THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1
    FROM public.region_members rm
    JOIN public.locations l ON l.region_id = rm.region_id
    WHERE rm.user_id = _user_id AND l.id = _location_id
  );
END;
$$;

-- 6. Accounts
CREATE TABLE public.accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  account_type public.account_type NOT NULL DEFAULT 'property_management',
  status public.account_status NOT NULL DEFAULT 'prospect',
  location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE RESTRICT,
  assigned_rep uuid,
  parent_account_id uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  loss_types text[] NOT NULL DEFAULT ARRAY[]::text[],
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX accounts_location_idx ON public.accounts(location_id);
CREATE INDEX accounts_assigned_rep_idx ON public.accounts(assigned_rep);
CREATE INDEX accounts_parent_idx ON public.accounts(parent_account_id);
CREATE INDEX accounts_name_trgm_idx ON public.accounts USING gin (name gin_trgm_ops);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.accounts TO authenticated;
GRANT ALL ON public.accounts TO service_role;
ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins full access to accounts" ON public.accounts FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "View accounts within scope" ON public.accounts FOR SELECT TO authenticated
  USING (
    public.is_member_of(auth.uid(), location_id)
    OR public.is_regional_for(auth.uid(), location_id)
    OR assigned_rep = auth.uid()
  );

CREATE POLICY "Insert accounts within scope" ON public.accounts FOR INSERT TO authenticated
  WITH CHECK (
    public.is_member_of(auth.uid(), location_id)
    OR public.is_regional_for(auth.uid(), location_id)
  );

CREATE POLICY "Update accounts within scope" ON public.accounts FOR UPDATE TO authenticated
  USING (
    public.is_member_of(auth.uid(), location_id)
    OR public.is_regional_for(auth.uid(), location_id)
    OR assigned_rep = auth.uid()
  )
  WITH CHECK (
    public.is_member_of(auth.uid(), location_id)
    OR public.is_regional_for(auth.uid(), location_id)
  );

-- 7. Contacts
CREATE TABLE public.contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  full_name text NOT NULL,
  title text,
  decision_role public.contact_decision_role,
  email text,
  phone text,
  birthday_month smallint CHECK (birthday_month BETWEEN 1 AND 12),
  birthday_day smallint CHECK (birthday_day BETWEEN 1 AND 31),
  gift_policy public.gift_policy NOT NULL DEFAULT 'unknown',
  gift_policy_notes text,
  is_primary boolean NOT NULL DEFAULT false,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contacts_account_idx ON public.contacts(account_id);
CREATE INDEX contacts_primary_idx ON public.contacts(account_id) WHERE is_primary;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.contacts TO authenticated;
GRANT ALL ON public.contacts TO service_role;
ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Contacts inherit account visibility" ON public.contacts FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin'::app_role)
    OR EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = contacts.account_id
               AND (public.is_member_of(auth.uid(), a.location_id)
                    OR public.is_regional_for(auth.uid(), a.location_id)
                    OR a.assigned_rep = auth.uid()))
  );
CREATE POLICY "Manage contacts within scope" ON public.contacts FOR ALL TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin'::app_role)
    OR EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = contacts.account_id
               AND (public.is_member_of(auth.uid(), a.location_id)
                    OR public.is_regional_for(auth.uid(), a.location_id)
                    OR a.assigned_rep = auth.uid()))
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'admin'::app_role)
    OR EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = contacts.account_id
               AND (public.is_member_of(auth.uid(), a.location_id)
                    OR public.is_regional_for(auth.uid(), a.location_id)
                    OR a.assigned_rep = auth.uid()))
  );

-- 8. Touchpoints
CREATE TABLE public.touchpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  type public.touchpoint_type NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX touchpoints_account_idx ON public.touchpoints(account_id, occurred_at DESC);
CREATE INDEX touchpoints_type_idx ON public.touchpoints(account_id, type, occurred_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.touchpoints TO authenticated;
GRANT ALL ON public.touchpoints TO service_role;
ALTER TABLE public.touchpoints ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Touchpoints inherit account visibility" ON public.touchpoints FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin'::app_role)
    OR EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = touchpoints.account_id
               AND (public.is_member_of(auth.uid(), a.location_id)
                    OR public.is_regional_for(auth.uid(), a.location_id)
                    OR a.assigned_rep = auth.uid()))
  );
CREATE POLICY "Insert touchpoints within scope" ON public.touchpoints FOR INSERT TO authenticated
  WITH CHECK (
    created_by = auth.uid()
    AND (public.has_role(auth.uid(), 'admin'::app_role)
         OR EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = touchpoints.account_id
                    AND (public.is_member_of(auth.uid(), a.location_id)
                         OR public.is_regional_for(auth.uid(), a.location_id)
                         OR a.assigned_rep = auth.uid())))
  );
CREATE POLICY "Update own touchpoints" ON public.touchpoints FOR UPDATE TO authenticated
  USING (created_by = auth.uid() OR public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (created_by = auth.uid() OR public.has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "Delete own touchpoints" ON public.touchpoints FOR DELETE TO authenticated
  USING (created_by = auth.uid() OR public.has_role(auth.uid(), 'admin'::app_role));

-- 9. updated_at triggers
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;
CREATE TRIGGER trg_regions_updated_at BEFORE UPDATE ON public.regions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_accounts_updated_at BEFORE UPDATE ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_contacts_updated_at BEFORE UPDATE ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 10. Minimal-visibility cross-location account search.
CREATE OR REPLACE FUNCTION public.search_accounts_minimal(_query text)
RETURNS TABLE (
  account_id uuid,
  account_name text,
  owning_location_id uuid,
  owning_location_code text,
  owning_location_name text,
  status public.account_status,
  loss_types text[],
  primary_contact_name text,
  viewer_has_full_access boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  q text := btrim(coalesce(_query, ''));
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  IF length(q) < 2 THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT
    a.id,
    a.name,
    l.id,
    l.code,
    l.name,
    a.status,
    a.loss_types,
    (SELECT c.full_name FROM public.contacts c
      WHERE c.account_id = a.id
      ORDER BY c.is_primary DESC, c.created_at ASC
      LIMIT 1),
    (public.has_role(auth.uid(), 'admin'::app_role)
     OR public.is_member_of(auth.uid(), a.location_id)
     OR public.is_regional_for(auth.uid(), a.location_id)
     OR a.assigned_rep = auth.uid())
  FROM public.accounts a
  JOIN public.locations l ON l.id = a.location_id
  WHERE a.name ILIKE '%' || q || '%'
  ORDER BY a.name
  LIMIT 25;
END;
$$;

REVOKE ALL ON FUNCTION public.search_accounts_minimal(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_accounts_minimal(text) TO authenticated;
