-- Buildings under a company: reconcile live with what 20260903090500 meant.
--
-- WRITTEN, NOT APPLIED. Re-runnable. No row is touched.
--
-- How the drift happened. 20260903090500_account_properties.sql was written
-- and never applied. Four days later Lovable's 20260907164530_03c8da0d-… made
-- the same two tables in its own shape, so on live:
--   * each table has ONE permissive FOR ALL policy, "Members of the owning
--     office manage buildings" / "... building contacts", which lets anyone who
--     can SEE the office (can_view_location) also insert, edit and delete;
--   * the tables carry is_demo (and account_property_contacts an updated_at)
--     that our file did not have;
--   * the unique (account_id, address_key) is a table constraint under
--     Postgres's default name, and the updated_at triggers are
--     update_*_updated_at instead of account_properties_set_updated_at;
--   * none of our policies, our two lookup indexes, or the
--     guard_property_contact_account() trigger exist.
-- MIGRATION_RECONCILIATION.md left it there: "Decide whether Lovable's policy
-- or the file's is wanted, then apply the missing pieces in one file." This is
-- that file.
--
-- Why not just apply 20260903090500. Policies are OR'd, so its two policies
-- beside Lovable's would change nothing for the member who can see but not
-- manage -- Lovable's policy would still let them write -- and it would add a
-- second unique index and a second updated_at trigger. The access rule this
-- file is about would not land at all.
--
-- The decision, piece by piece:
--   * Access: OURS. A building is account data, and 20260903090500 says so --
--     it mirrors contacts_select / contacts_write, which are still live exactly
--     as written. On the company panel a rep adds a person and a building side
--     by side; one being writable by any office member and the other only by a
--     manager or the account's rep was never a decision, just two authors.
--       read:  can_view_location OR the account's assigned rep OR its creator
--       write: can_manage_location OR the account's assigned rep
--   * is_demo: LOVABLE'S, kept. demo_tables() is derived from the presence of
--     the column, so it is what puts these tables in purge_demo_data() and
--     demo_data_total(). On a fresh replay our file ran first, Lovable's CREATE
--     TABLE IF NOT EXISTS was skipped, and the column never arrived -- added
--     here, with the partial index 20260911144818 gives every is_demo table.
--   * account_property_contacts.updated_at: LOVABLE'S, kept. Its
--     update_account_property_contacts_updated_at trigger is created
--     unconditionally by 20260907164530, so on a fresh replay (no column) every
--     UPDATE of an assignment fails with "record new has no field updated_at".
--   * One unique (account_id, address_key). Live keeps Lovable's constraint; a
--     replay keeps our index. Never both.
--   * One updated_at trigger per table: Lovable's update_*_updated_at, which
--     exists on live and on a replay. Ours (account_properties_set_updated_at)
--     is dropped where it exists. set_updated_at() and
--     update_updated_at_column() are the same one line.
--   * Indexes: account_properties_address_key_idx (the job-side lookup, fold
--     the job address and find the building) and
--     account_property_contacts_contact_idx ("which buildings does this person
--     cover", and the ON DELETE CASCADE from contacts) are added.
--     account_property_contacts_property_idx is NOT: the unique
--     (property_id, contact_id) already leads with property_id, so it would be
--     the duplicate this file exists to avoid. Dropped where it exists.
--   * guard_property_contact_account(): ours, added as written. On live today
--     the one assignment passes it (contact and building belong to the same
--     account), and it only fires on INSERT / UPDATE, so no existing row can
--     make this file fail.
--   * Restrictive policies: active_profile_required and
--     anonymous_business_access_denied are already live and left alone;
--     portal_customer_denied is live too and is (re)asserted here so a replay
--     that predates the client portal sweep ends up the same.

-- ---------------------------------------------------------------------------
-- 1. Lovable's columns, for a replay that never got them. No-op on live.
-- ---------------------------------------------------------------------------
ALTER TABLE public.account_properties
  ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;
ALTER TABLE public.account_property_contacts
  ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

COMMENT ON COLUMN public.account_properties.address_key IS
  'Folded address, from addressKey() in src/lib/standing-notes.ts. Shared with public.property_notes.address_key so both describe the same building.';

-- The demo predicate, indexed the way 20260911144818 does it: skip by
-- DEFINITION, not by name, so a hand-made index under another name is not
-- duplicated.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['account_properties', 'account_property_contacts'] LOOP
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = t AND indexdef LIKE '%(is_demo)%'
    );
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON public.%I (is_demo) WHERE is_demo',
      t || '_is_demo_idx', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Exactly one unique (account_id, address_key), and the lookup indexes
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.account_properties'::regclass
       AND conname = 'account_properties_account_id_address_key_key'
  ) THEN
    -- Live: Lovable's constraint is the one. Ours, if anyone ever ran
    -- 20260903090500 by hand, is the duplicate.
    DROP INDEX IF EXISTS public.account_properties_account_address_key;
  ELSE
    -- Replay: our file made the table, so our index is the only one.
    CREATE UNIQUE INDEX IF NOT EXISTS account_properties_account_address_key
      ON public.account_properties (account_id, address_key);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS account_properties_address_key_idx
  ON public.account_properties (address_key);
CREATE INDEX IF NOT EXISTS account_property_contacts_contact_idx
  ON public.account_property_contacts (contact_id);
-- Covered by the unique (property_id, contact_id); see the header.
DROP INDEX IF EXISTS public.account_property_contacts_property_idx;

-- ---------------------------------------------------------------------------
-- 3. One updated_at trigger per table
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS account_properties_set_updated_at ON public.account_properties;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.account_properties'::regclass
       AND tgname = 'update_account_properties_updated_at'
  ) THEN
    CREATE TRIGGER update_account_properties_updated_at
      BEFORE UPDATE ON public.account_properties
      FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.account_property_contacts'::regclass
       AND tgname = 'update_account_property_contacts_updated_at'
  ) THEN
    CREATE TRIGGER update_account_property_contacts_updated_at
      BEFORE UPDATE ON public.account_property_contacts
      FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Access: 20260903090500's policies, and only those
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Members of the owning office manage buildings" ON public.account_properties;
DROP POLICY IF EXISTS "Members of the owning office manage building contacts" ON public.account_property_contacts;

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

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'portal_customer') THEN
    DROP POLICY IF EXISTS portal_customer_denied ON public.account_properties;
    CREATE POLICY portal_customer_denied ON public.account_properties
      AS RESTRICTIVE FOR ALL TO portal_customer USING (false) WITH CHECK (false);
    DROP POLICY IF EXISTS portal_customer_denied ON public.account_property_contacts;
    CREATE POLICY portal_customer_denied ON public.account_property_contacts
      AS RESTRICTIVE FOR ALL TO portal_customer USING (false) WITH CHECK (false);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 5. A contact assigned to a building must work for the company that manages
--    it. As written in 20260903090500: same reasoning as the reporting-line
--    guard in 20260903090000, the escalation path must not walk out of the
--    company. SECURITY DEFINER so the check sees both rows whatever the
--    writer's RLS; it is a trigger function, so nobody needs EXECUTE on it.
-- ---------------------------------------------------------------------------
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
