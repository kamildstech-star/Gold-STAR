-- The asset half of the company hierarchy: the buildings a customer manages,
-- and which of their people run each one.
--
-- What already existed, and what this reuses rather than replaces:
--   * public.property_notes (20260818180528) is the app's only property
--     concept. It is keyed on `address_key`, a folded form of a street address
--     produced by addressKey() in src/lib/standing-notes.ts, so "12 Maple Ave."
--     and "12 maple avenue" are one building. That is the identity this table
--     adopts -- the same fold, computed by the same function -- so a property
--     row and its standing property note are the same property, and the job
--     banner that already reads "Property - 12 Maple Avenue" and this table
--     agree without a second normaliser to keep in step.
--   * public.jobs has a free-text `address` and an optional `account_id`. That
--     is how a job reaches a building today, and it is left exactly as it is.
--
-- What did not exist: anything tying an address to the account that manages it,
-- or to the people responsible for it. That is the whole of what is added here.
-- This is not a property-management module: no units, no leases, no owners, no
-- geometry. A name, an address, and who to call.

CREATE TABLE IF NOT EXISTS public.account_properties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  -- What the customer calls it ("Maple Court"), which is what they say on the
  -- phone at 2am. The address is what the CRM matches on.
  name text,
  address text NOT NULL,
  -- Written by the client from addressKey(address). Deliberately not a
  -- generated column: re-implementing that fold in SQL would give us two
  -- normalisers that drift, and the TS one is already the shape property_notes
  -- is keyed by.
  address_key text NOT NULL,
  notes text,
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN public.account_properties.address_key IS
  'Folded address, from addressKey() in src/lib/standing-notes.ts. Shared with public.property_notes.address_key so both describe the same building.';

-- One row per building per company. The same address can legitimately appear
-- under two accounts (a managing agent and the owner LLC), so this is not
-- globally unique.
CREATE UNIQUE INDEX IF NOT EXISTS account_properties_account_address_key
  ON public.account_properties (account_id, address_key);
-- The job-side lookup: fold the job address, find the building.
CREATE INDEX IF NOT EXISTS account_properties_address_key_idx
  ON public.account_properties (address_key);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.account_properties TO authenticated;
GRANT ALL ON public.account_properties TO service_role;
ALTER TABLE public.account_properties ENABLE ROW LEVEL SECURITY;

-- Mirrors contacts_select / contacts_write (20260810174328): a property is
-- account data and inherits the account's visibility exactly, including the
-- assigned rep who can see their own accounts outside their office.
DROP POLICY IF EXISTS account_properties_select ON public.account_properties;
CREATE POLICY account_properties_select ON public.account_properties
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.accounts a
    WHERE a.id = account_properties.account_id
      AND (
        public.can_view_location((SELECT auth.uid()), a.location_id)
        OR a.assigned_rep = (SELECT auth.uid())
        OR a.created_by = (SELECT auth.uid())
      )
  )
);

DROP POLICY IF EXISTS account_properties_write ON public.account_properties;
CREATE POLICY account_properties_write ON public.account_properties
FOR ALL TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.accounts a
    WHERE a.id = account_properties.account_id
      AND (
        public.can_manage_location((SELECT auth.uid()), a.location_id)
        OR a.assigned_rep = (SELECT auth.uid())
      )
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.accounts a
    WHERE a.id = account_properties.account_id
      AND (
        public.can_manage_location((SELECT auth.uid()), a.location_id)
        OR a.assigned_rep = (SELECT auth.uid())
      )
  )
);

DROP TRIGGER IF EXISTS account_properties_set_updated_at ON public.account_properties;
CREATE TRIGGER account_properties_set_updated_at
BEFORE UPDATE ON public.account_properties
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Who covers a building
--
-- A join table, not a pair of columns on account_properties. 20260810193154
-- had to replace locations.region_id with public.location_regions for this
-- exact reason, and 20260827150000 repeats the lesson: the moment there is one
-- FK, a building may have a Super OR a Regional OR an on-site billing contact,
-- never all three, and the client's own diagram has more than one person over
-- an Asset. A building also changes hands between people far more often than it
-- changes address.
--
-- position_key overrides the contact's company position FOR THIS BUILDING --
-- somebody who is a Regional company-wide can be the acting Super at one site.
-- Null means "use their company position", which is the common case.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.account_property_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.account_properties(id) ON DELETE CASCADE,
  -- CASCADE on the contact too: an assignment to a deleted person is not
  -- information, it is a phone number nobody answers. The building survives.
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  position_key text,
  sort_order integer NOT NULL DEFAULT 0,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, contact_id)
);

CREATE INDEX IF NOT EXISTS account_property_contacts_property_idx
  ON public.account_property_contacts (property_id);
CREATE INDEX IF NOT EXISTS account_property_contacts_contact_idx
  ON public.account_property_contacts (contact_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.account_property_contacts TO authenticated;
GRANT ALL ON public.account_property_contacts TO service_role;
ALTER TABLE public.account_property_contacts ENABLE ROW LEVEL SECURITY;

-- Inherits the property's visibility, which inherits the account's. One rule,
-- stated once, at the top.
DROP POLICY IF EXISTS account_property_contacts_select ON public.account_property_contacts;
CREATE POLICY account_property_contacts_select ON public.account_property_contacts
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.account_properties p
    JOIN public.accounts a ON a.id = p.account_id
    WHERE p.id = account_property_contacts.property_id
      AND (
        public.can_view_location((SELECT auth.uid()), a.location_id)
        OR a.assigned_rep = (SELECT auth.uid())
        OR a.created_by = (SELECT auth.uid())
      )
  )
);

DROP POLICY IF EXISTS account_property_contacts_write ON public.account_property_contacts;
CREATE POLICY account_property_contacts_write ON public.account_property_contacts
FOR ALL TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.account_properties p
    JOIN public.accounts a ON a.id = p.account_id
    WHERE p.id = account_property_contacts.property_id
      AND (
        public.can_manage_location((SELECT auth.uid()), a.location_id)
        OR a.assigned_rep = (SELECT auth.uid())
      )
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.account_properties p
    JOIN public.accounts a ON a.id = p.account_id
    WHERE p.id = account_property_contacts.property_id
      AND (
        public.can_manage_location((SELECT auth.uid()), a.location_id)
        OR a.assigned_rep = (SELECT auth.uid())
      )
  )
);

-- A contact assigned to a building must work for the company that manages it.
-- Same reasoning as the reporting-line guard in 20260903090000: the escalation
-- path must not walk out of the company.
CREATE OR REPLACE FUNCTION public.guard_property_contact_account()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  property_account uuid;
  contact_account uuid;
BEGIN
  SELECT p.account_id INTO property_account
  FROM public.account_properties p WHERE p.id = NEW.property_id;
  SELECT c.account_id INTO contact_account
  FROM public.contacts c WHERE c.id = NEW.contact_id;

  IF contact_account IS DISTINCT FROM property_account THEN
    RAISE EXCEPTION 'That contact does not work for the company that manages this property.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.guard_property_contact_account() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS guard_property_contact_account ON public.account_property_contacts;
CREATE TRIGGER guard_property_contact_account
BEFORE INSERT OR UPDATE ON public.account_property_contacts
FOR EACH ROW EXECUTE FUNCTION public.guard_property_contact_account();
