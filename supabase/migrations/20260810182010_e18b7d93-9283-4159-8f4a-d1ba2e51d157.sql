-- 1. Managed account type list -------------------------------------------------
INSERT INTO public.option_lists (key, label, description, backed_by_enum)
VALUES ('account_type', 'Account type', 'What kind of organisation this account is', 'account_type')
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.option_list_values (list_id, key, label, sort_order, is_default)
SELECT ol.id, v.key, v.label, v.sort_order, v.is_default
FROM public.option_lists ol,
  (VALUES
    ('property_management', 'Property management', 10, true),
    ('commercial',          'Commercial',          20, false),
    ('residential',         'Residential',         30, false),
    ('insurance_carrier',   'Insurance carrier',   40, false),
    ('public_adjusting_firm','Public adjusting firm', 50, false),
    ('insurance_broker',    'Insurance broker',    60, false),
    ('adjusting_firm',      'Independent adjusting firm', 70, false),
    ('referral_partner',    'Referral partner',    80, false),
    ('trade_partner',       'Trade partner',       90, false),
    ('other',               'Other',               100, false)
  ) AS v(key, label, sort_order, is_default)
WHERE ol.key = 'account_type'
ON CONFLICT DO NOTHING;

-- 2. Accounts: managed type + reference flag ------------------------------------
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS account_type_id uuid REFERENCES public.option_list_values(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_reference boolean NOT NULL DEFAULT false;

UPDATE public.accounts a
SET account_type_id = olv.id
FROM public.option_list_values olv
JOIN public.option_lists ol ON ol.id = olv.list_id AND ol.key = 'account_type'
WHERE a.account_type_id IS NULL AND olv.key = a.account_type::text;

-- Keep the legacy enum column in sync so existing code, views and reports keep
-- working while the managed list becomes the source of truth. Unknown/new keys
-- collapse to 'other' rather than failing the insert.
CREATE OR REPLACE FUNCTION public.trg_accounts_sync_account_type()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_key text;
BEGIN
  IF NEW.account_type_id IS NOT NULL THEN
    SELECT olv.key INTO v_key FROM public.option_list_values olv WHERE olv.id = NEW.account_type_id;
    IF v_key IN ('property_management', 'commercial', 'residential') THEN
      NEW.account_type := v_key::public.account_type;
    ELSE
      NEW.account_type := 'other'::public.account_type;
    END IF;
  ELSIF TG_OP = 'INSERT' OR NEW.account_type IS DISTINCT FROM OLD.account_type THEN
    SELECT olv.id INTO NEW.account_type_id
    FROM public.option_list_values olv
    JOIN public.option_lists ol ON ol.id = olv.list_id AND ol.key = 'account_type'
    WHERE olv.key = NEW.account_type::text;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_accounts_sync_account_type ON public.accounts;
CREATE TRIGGER trg_accounts_sync_account_type
BEFORE INSERT OR UPDATE ON public.accounts
FOR EACH ROW EXECUTE FUNCTION public.trg_accounts_sync_account_type();

CREATE INDEX IF NOT EXISTS accounts_account_type_id_idx ON public.accounts (account_type_id);
CREATE INDEX IF NOT EXISTS accounts_is_reference_idx ON public.accounts (is_reference) WHERE is_reference;

-- Reference data (carriers, adjusting firms) belongs to no single office.
CREATE POLICY accounts_select_reference ON public.accounts
FOR SELECT TO authenticated
USING (is_reference);

-- 3. Contacts under reference accounts are shared too ---------------------------
CREATE POLICY contacts_select_reference ON public.contacts
FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = contacts.account_id AND a.is_reference));

CREATE POLICY contacts_insert_reference ON public.contacts
FOR INSERT TO authenticated
WITH CHECK (EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = contacts.account_id AND a.is_reference));

CREATE POLICY contacts_update_reference ON public.contacts
FOR UPDATE TO authenticated
USING (EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = contacts.account_id AND a.is_reference))
WITH CHECK (EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = contacts.account_id AND a.is_reference));

-- 4. Adjusters as contacts on the job -------------------------------------------
ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS desk_adjuster_contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS field_adjuster_contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS insurance_agency_account_id uuid REFERENCES public.accounts(id) ON DELETE SET NULL;

-- 5. Seed the carriers — real reference data, not demo --------------------------
INSERT INTO public.accounts (name, account_type, account_type_id, status, location_id, is_reference, is_demo, loss_types, notes)
SELECT
  c.name,
  'other'::public.account_type,
  (SELECT olv.id FROM public.option_list_values olv
     JOIN public.option_lists ol ON ol.id = olv.list_id AND ol.key = 'account_type'
    WHERE olv.key = 'insurance_carrier'),
  'active'::public.account_status,
  (SELECT id FROM public.locations WHERE code = 'NY' LIMIT 1),
  true,
  false,
  ARRAY[]::text[],
  'National carrier reference record — shared by every office.'
FROM (VALUES
  ('State Farm'), ('Allstate'), ('Travelers'), ('Chubb'), ('Liberty Mutual'),
  ('USAA'), ('Farmers'), ('Nationwide'), ('The Hartford'), ('Amica'),
  ('Progressive'), ('Erie Insurance'), ('Cincinnati Insurance'), ('Auto-Owners'),
  ('American Family'), ('Safeco'), ('Selective'), ('NJM Insurance'),
  ('Plymouth Rock'), ('Mercury Insurance'), ('Encompass'), ('MetLife'),
  ('Kemper'), ('Westfield'), ('Grange Insurance')
) AS c(name)
WHERE NOT EXISTS (
  SELECT 1 FROM public.accounts a WHERE lower(a.name) = lower(c.name) AND a.is_reference
);

-- 6. Point existing jobs at the seeded carriers instead of loose text -----------
UPDATE public.jobs j
SET insurance_carrier_account_id = a.id
FROM public.accounts a
WHERE j.insurance_carrier_account_id IS NULL
  AND a.is_reference
  AND j.insurance_carrier IS NOT NULL
  AND (lower(a.name) = lower(trim(j.insurance_carrier))
       OR lower(a.name) = lower(trim(j.insurance_carrier)) || ' insurance');

-- 7. Admin visibility: which carriers are still loose strings -------------------
CREATE OR REPLACE FUNCTION public.unlinked_carrier_names()
RETURNS TABLE (carrier_name text, job_count bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT trim(j.insurance_carrier) AS carrier_name, count(*) AS job_count
  FROM public.jobs j
  WHERE j.insurance_carrier_account_id IS NULL
    AND coalesce(trim(j.insurance_carrier), '') <> ''
  GROUP BY 1
  ORDER BY 2 DESC, 1;
$$;

REVOKE ALL ON FUNCTION public.unlinked_carrier_names() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unlinked_carrier_names() TO authenticated;
