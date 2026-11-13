-- Client portal, slice 1: who a customer is, what is shared with them, and the
-- walls that keep them out of everything else.
--
-- WRITTEN, NOT APPLIED. Run 20260928130000 then 20260928131000, in that order.
--
-- David, 24 Sep: "a separate portal... very bare minimum... they should only
-- have access to whatever is shared to them on a job-by-job basis." The
-- client's security review sets the acceptance criteria and this file is
-- written against them: deny by default, customer-to-customer isolation,
-- every customer-reachable function checks the caller AND the share, storage
-- only for shared files, and a customer can never hold a staff role.
--
-- THE CENTRAL DECISION: customers are a different Postgres role.
--
-- Supabase issues a JWT whose `role` claim is the auth user's `role` column,
-- and PostgREST runs every request AS that role. Staff are `authenticated`.
-- Portal customers are created (by the server, with the service key) with
-- role `portal_customer`, so their requests run as `portal_customer` — a role
-- that holds USAGE on schema public and EXECUTE on five portal_* functions
-- (next migration), and nothing else. Not one table.
--
-- That is what makes "deny by default" true rather than hoped for. Every one
-- of the several hundred existing policies is written `TO authenticated` (or
-- anon); none of them can match a customer, because a customer is not
-- `authenticated`. A policy written `TO public` could — but only on a table the
-- role has privileges on, and it has none. The audit at the end of the next
-- migration proves both facts against the live catalog at apply time and
-- refuses to finish if either is false.
--
-- If the auth server ever failed to set the role, the customer would arrive as
-- `authenticated` with no profile, no office and no role. The invitation
-- server function checks the role on the user it just created and refuses
-- (deleting the user) before anyone can sign in, so that state is never
-- handed out; and the existing `active_profile_required` restrictive policies
-- (20260908013000) would deny them the 29 core tables regardless.

/* ------------------------------------------------------------------ */
/* 0. The role                                                          */
/* ------------------------------------------------------------------ */

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'portal_customer') THEN
    CREATE ROLE portal_customer NOLOGIN NOINHERIT;
  END IF;
END $$;

-- PostgREST connects as `authenticator` and switches into the JWT's role; it
-- may only switch into roles it has been granted. Without this a customer's
-- request fails closed ("permission denied to set role"), which is safe but
-- means the portal does not work — hence a NOTICE rather than silence.
DO $$
BEGIN
  EXECUTE 'GRANT portal_customer TO authenticator';
EXCEPTION WHEN undefined_object THEN
  RAISE NOTICE 'no authenticator role: PostgREST cannot switch into portal_customer here';
END $$;

GRANT USAGE ON SCHEMA public TO portal_customer;

CREATE SCHEMA IF NOT EXISTS goldstar_private;
REVOKE ALL ON SCHEMA goldstar_private FROM PUBLIC, anon, portal_customer;

/* ------------------------------------------------------------------ */
/* 1. Customer identity                                                 */
/* ------------------------------------------------------------------ */

-- One portal identity per contact record. The contact is the customer; the
-- auth user is only how they prove it, and is attached when an invitation is
-- accepted (user_id stays null until then).
CREATE TABLE IF NOT EXISTS public.portal_customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL UNIQUE REFERENCES public.contacts(id) ON DELETE CASCADE,
  account_id uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  email text NOT NULL UNIQUE CHECK (email = lower(btrim(email)) AND position('@' IN email) > 1),
  display_name text,
  user_id uuid UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  disabled_by uuid
);

-- The raw token is never stored. The staff member's browser makes 32 random
-- bytes, keeps the token for the link and sends only its SHA-256 here; the
-- accept function hashes what the customer presents and looks that up.
CREATE TABLE IF NOT EXISTS public.portal_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portal_customer_id uuid NOT NULL REFERENCES public.portal_customers(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  job_id uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
  account_id uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  used_by uuid,
  revoked_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS portal_invitations_customer_idx
  ON public.portal_invitations (portal_customer_id, created_at DESC);

/* ------------------------------------------------------------------ */
/* 2. Job-by-job sharing                                                */
/* ------------------------------------------------------------------ */

-- A job shared with one customer. Deleting the row is "unshare": the next
-- portal read simply finds nothing, so it takes effect immediately.
CREATE TABLE IF NOT EXISTS public.portal_job_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  portal_customer_id uuid NOT NULL REFERENCES public.portal_customers(id) ON DELETE CASCADE,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, portal_customer_id)
);
CREATE INDEX IF NOT EXISTS portal_job_shares_customer_idx
  ON public.portal_job_shares (portal_customer_id);

-- WHAT is shared, per job per customer. A share starts with none of these, so
-- the default is nothing. Photos are shared as a whole album (a job project)
-- or one folder of it, never photo by photo.
CREATE TABLE IF NOT EXISTS public.portal_share_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  share_id uuid NOT NULL REFERENCES public.portal_job_shares(id) ON DELETE CASCADE,
  item_kind text NOT NULL CHECK (item_kind IN ('document', 'photo_album', 'photo_folder', 'invoice')),
  item_id uuid NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (share_id, item_kind, item_id)
);

/* ------------------------------------------------------------------ */
/* 3. Private helpers                                                   */
/* ------------------------------------------------------------------ */

-- Is this auth user a portal customer? Either half is enough: linked to a
-- portal_customers row, or carrying the role (an account created by the
-- invitation flow whose link step never finished is still a customer).
CREATE OR REPLACE FUNCTION goldstar_private.is_portal_user(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT _user_id IS NOT NULL AND (
    EXISTS (SELECT 1 FROM public.portal_customers pc WHERE pc.user_id = _user_id)
    OR EXISTS (SELECT 1 FROM auth.users u WHERE u.id = _user_id AND u.role = 'portal_customer')
  );
$$;

-- Anything that makes a sign-in staff: a profile, a role, an office, a region,
-- a permission grant.
CREATE OR REPLACE FUNCTION goldstar_private.has_staff_footprint(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE user_id = _user_id)
      OR EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id)
      OR EXISTS (SELECT 1 FROM public.location_members WHERE user_id = _user_id)
      OR EXISTS (SELECT 1 FROM public.region_members WHERE user_id = _user_id)
      OR EXISTS (SELECT 1 FROM public.user_permissions WHERE user_id = _user_id);
$$;

-- Is this contact one of the people on this job? The only people a job may be
-- shared with: its primary contact, anyone on its contact list, anyone at the
-- customer / bill-to / public adjusting account, and the named adjusters and
-- reviewer. Sharing a job with someone unconnected to it is how one
-- customer's loss ends up in another customer's portal, so the database
-- refuses it rather than trusting the picker.
CREATE OR REPLACE FUNCTION goldstar_private.portal_contact_on_job(_contact_id uuid, _job_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.jobs j
      LEFT JOIN public.contacts c ON c.id = _contact_id
     WHERE j.id = _job_id
       AND (
         _contact_id = j.primary_contact_id
         OR _contact_id = j.public_adjuster_contact_id
         OR _contact_id = j.field_adjuster_contact_id
         OR _contact_id = j.desk_adjuster_contact_id
         OR _contact_id = j.independent_reviewer_contact_id
         OR EXISTS (SELECT 1 FROM public.job_contacts jc
                      WHERE jc.job_id = j.id AND jc.contact_id = _contact_id)
         OR (c.account_id IS NOT NULL AND (
               c.account_id = j.account_id
               OR c.account_id = j.bill_to_account_id
               OR c.account_id = j.public_adjuster_account_id))
       )
  );
$$;

-- Does this item belong to this job, in a state a customer may see? Asked when
-- an item is shared AND again on every portal read, so a document later moved
-- to another job, voided, or an invoice put back to draft drops out of the
-- portal without anyone remembering to unshare it.
CREATE OR REPLACE FUNCTION goldstar_private.portal_item_on_job(_kind text, _item_id uuid, _job_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE _kind
    WHEN 'document' THEN EXISTS (
      SELECT 1 FROM public.documents d
       WHERE d.id = _item_id AND d.job_id = _job_id
         AND d.storage_path IS NOT NULL AND d.voided_at IS NULL)
    WHEN 'photo_album' THEN EXISTS (
      SELECT 1 FROM public.projects p
       WHERE p.id = _item_id AND p.job_id = _job_id AND p.archived_at IS NULL)
    WHEN 'photo_folder' THEN EXISTS (
      SELECT 1 FROM public.photo_folders f
        JOIN public.projects p ON p.id = f.project_id
       WHERE f.id = _item_id AND p.job_id = _job_id AND p.archived_at IS NULL)
    WHEN 'invoice' THEN EXISTS (
      SELECT 1 FROM public.invoices i
       WHERE i.id = _item_id AND i.job_id = _job_id AND i.status::text <> 'draft')
    ELSE false
  END;
$$;

CREATE OR REPLACE FUNCTION goldstar_private.is_active_staff(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT _user_id IS NOT NULL
     AND NOT goldstar_private.is_portal_user(_user_id)
     AND EXISTS (SELECT 1 FROM public.profiles p
                  WHERE p.user_id = _user_id AND p.is_active IS TRUE
                    AND p.approval_status = 'approved');
$$;

REVOKE ALL ON FUNCTION goldstar_private.is_portal_user(uuid) FROM PUBLIC, anon, portal_customer;
REVOKE ALL ON FUNCTION goldstar_private.has_staff_footprint(uuid) FROM PUBLIC, anon, portal_customer;
REVOKE ALL ON FUNCTION goldstar_private.portal_contact_on_job(uuid, uuid) FROM PUBLIC, anon, portal_customer;
REVOKE ALL ON FUNCTION goldstar_private.portal_item_on_job(text, uuid, uuid) FROM PUBLIC, anon, portal_customer;
REVOKE ALL ON FUNCTION goldstar_private.is_active_staff(uuid) FROM PUBLIC, anon, portal_customer;
-- Staff reach these through RLS policies and triggers on their own writes.
GRANT USAGE ON SCHEMA goldstar_private TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION goldstar_private.is_portal_user(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION goldstar_private.has_staff_footprint(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION goldstar_private.portal_contact_on_job(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION goldstar_private.portal_item_on_job(text, uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION goldstar_private.is_active_staff(uuid) TO authenticated, service_role;

/* ------------------------------------------------------------------ */
/* 4. A customer can never hold or gain a staff role                    */
/* ------------------------------------------------------------------ */

-- Enforced where the roles live, not in the UI. Every table that makes a
-- sign-in staff refuses a row for a portal customer, whoever writes it —
-- an admin in the Users screen, a server function on the service key, an
-- import.
CREATE OR REPLACE FUNCTION goldstar_private.refuse_portal_staff_row()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF goldstar_private.is_portal_user(NEW.user_id) THEN
    RAISE EXCEPTION 'A customer portal sign-in can never hold a staff role, office or profile (%).',
      TG_TABLE_NAME USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION goldstar_private.refuse_portal_staff_row() FROM PUBLIC, anon, portal_customer;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['profiles', 'user_roles', 'location_members', 'region_members', 'user_permissions'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS portal_customer_never_staff ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER portal_customer_never_staff BEFORE INSERT OR UPDATE ON public.%I
         FOR EACH ROW EXECUTE FUNCTION goldstar_private.refuse_portal_staff_row()', t);
  END LOOP;
END $$;

-- And the other direction: the auth role itself. A customer's sign-in may not
-- be switched to `authenticated` (which would put every staff policy in
-- reach), and a staff sign-in may not be switched into a customer.
CREATE OR REPLACE FUNCTION goldstar_private.guard_portal_auth_role()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF OLD.role = 'portal_customer' AND NEW.role IS DISTINCT FROM 'portal_customer' THEN
    RAISE EXCEPTION 'A customer portal sign-in can never become a staff sign-in.'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.role = 'portal_customer' AND OLD.role IS DISTINCT FROM 'portal_customer'
     AND goldstar_private.has_staff_footprint(NEW.id) THEN
    RAISE EXCEPTION 'A staff sign-in can not be turned into a customer portal sign-in.'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION goldstar_private.guard_portal_auth_role() FROM PUBLIC, anon, authenticated, portal_customer;

DO $$
BEGIN
  DROP TRIGGER IF EXISTS portal_role_guard ON auth.users;
  CREATE TRIGGER portal_role_guard BEFORE UPDATE OF role ON auth.users
    FOR EACH ROW EXECUTE FUNCTION goldstar_private.guard_portal_auth_role();
EXCEPTION WHEN insufficient_privilege THEN
  -- The staff-table triggers above still hold; this is the second lock.
  RAISE NOTICE 'auth.users role guard not installed: not permitted as %', current_user;
END $$;

-- The signup trigger makes every new auth user a pending STAFF profile and
-- tells the admins. A portal customer must get neither: a profile is the
-- first step to approval, and "approve" is one click away in the Users
-- screen. The invitation server marks the users it creates, and the auth
-- server sets their role in a second statement after the insert, so both are
-- honored. The marker can only ever suppress a profile; it grants nothing.
-- Body otherwise verbatim from 20260813171512.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_name text;
BEGIN
  IF NEW.role = 'portal_customer'
     OR coalesce(NEW.raw_user_meta_data->>'portal_invitation', '') = 'true' THEN
    RETURN NEW;
  END IF;

  v_name := COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name');

  INSERT INTO public.profiles (user_id, email, full_name, approval_status)
  VALUES (NEW.id, NEW.email, v_name, 'pending')
  ON CONFLICT (user_id) DO NOTHING;

  -- Tell every admin/owner a signup is waiting. Never blocks the signup.
  BEGIN
    INSERT INTO public.notifications (user_id, type, title, body, entity_type, entity_id, href, priority)
    SELECT ur.user_id,
           'user_signup'::notification_type,
           'New signup awaiting approval',
           COALESCE(v_name, NEW.email) || ' signed up and needs a role and location.',
           'profile',
           NEW.id,
           '/admin/users',
           'high'::notification_priority
    FROM public.user_roles ur
    WHERE ur.role IN ('admin','owner')
    GROUP BY ur.user_id;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN NEW;
END;
$function$;

/* ------------------------------------------------------------------ */
/* 5. Integrity of what is shared                                       */
/* ------------------------------------------------------------------ */

CREATE OR REPLACE FUNCTION goldstar_private.portal_share_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_contact uuid;
BEGIN
  SELECT pc.contact_id INTO v_contact FROM public.portal_customers pc WHERE pc.id = NEW.portal_customer_id;
  IF v_contact IS NULL OR NOT goldstar_private.portal_contact_on_job(v_contact, NEW.job_id) THEN
    RAISE EXCEPTION 'That customer is not on this job, so it can''t be shared with them.'
      USING ERRCODE = '42501';
  END IF;
  NEW.created_by := auth.uid();
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION goldstar_private.portal_share_item_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_job uuid;
BEGIN
  SELECT s.job_id INTO v_job FROM public.portal_job_shares s WHERE s.id = NEW.share_id;
  IF v_job IS NULL OR NOT goldstar_private.portal_item_on_job(NEW.item_kind, NEW.item_id, v_job) THEN
    RAISE EXCEPTION 'That % is not part of this job (or is a draft or voided), so it can''t be shared.',
      replace(NEW.item_kind, '_', ' ') USING ERRCODE = '42501';
  END IF;
  NEW.created_by := auth.uid();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION goldstar_private.portal_share_guard() FROM PUBLIC, anon, portal_customer;
REVOKE ALL ON FUNCTION goldstar_private.portal_share_item_guard() FROM PUBLIC, anon, portal_customer;

DROP TRIGGER IF EXISTS portal_share_guard ON public.portal_job_shares;
CREATE TRIGGER portal_share_guard BEFORE INSERT OR UPDATE ON public.portal_job_shares
  FOR EACH ROW EXECUTE FUNCTION goldstar_private.portal_share_guard();
DROP TRIGGER IF EXISTS portal_share_item_guard ON public.portal_share_items;
CREATE TRIGGER portal_share_item_guard BEFORE INSERT OR UPDATE ON public.portal_share_items
  FOR EACH ROW EXECUTE FUNCTION goldstar_private.portal_share_item_guard();

/* ------------------------------------------------------------------ */
/* 6. Staff access to the portal tables                                 */
/* ------------------------------------------------------------------ */

-- Supabase's default privileges hand every new table to anon and
-- authenticated in full. Take all of it back, then give staff exactly the
-- verbs the job panel uses. Nothing at all is granted to portal_customer.
REVOKE ALL ON public.portal_customers, public.portal_invitations,
              public.portal_job_shares, public.portal_share_items
  FROM PUBLIC, anon, authenticated, portal_customer;
GRANT ALL ON public.portal_customers, public.portal_invitations,
             public.portal_job_shares, public.portal_share_items TO service_role;

-- Invitations are not readable by any signed-in session: the token hash stays
-- with the service role, and staff see an invitation's state through
-- portal_job_candidates.
GRANT SELECT ON public.portal_customers TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.portal_job_shares, public.portal_share_items TO authenticated;

ALTER TABLE public.portal_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portal_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portal_job_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portal_share_items ENABLE ROW LEVEL SECURITY;

-- A portal identity is visible exactly when its contact is: the subquery runs
-- under the reader's own contacts policy.
DROP POLICY IF EXISTS portal_customers_staff_select ON public.portal_customers;
CREATE POLICY portal_customers_staff_select ON public.portal_customers
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.contacts c WHERE c.id = portal_customers.contact_id));

DROP POLICY IF EXISTS portal_job_shares_staff_select ON public.portal_job_shares;
CREATE POLICY portal_job_shares_staff_select ON public.portal_job_shares
  FOR SELECT TO authenticated USING (public.can_view_job(auth.uid(), job_id));
DROP POLICY IF EXISTS portal_job_shares_staff_insert ON public.portal_job_shares;
CREATE POLICY portal_job_shares_staff_insert ON public.portal_job_shares
  FOR INSERT TO authenticated
  WITH CHECK (goldstar_private.is_active_staff(auth.uid()) AND public.can_manage_job(auth.uid(), job_id));
DROP POLICY IF EXISTS portal_job_shares_staff_delete ON public.portal_job_shares;
CREATE POLICY portal_job_shares_staff_delete ON public.portal_job_shares
  FOR DELETE TO authenticated USING (public.can_manage_job(auth.uid(), job_id));

DROP POLICY IF EXISTS portal_share_items_staff_select ON public.portal_share_items;
CREATE POLICY portal_share_items_staff_select ON public.portal_share_items
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.portal_job_shares s
                  WHERE s.id = share_id AND public.can_view_job(auth.uid(), s.job_id)));
DROP POLICY IF EXISTS portal_share_items_staff_insert ON public.portal_share_items;
CREATE POLICY portal_share_items_staff_insert ON public.portal_share_items
  FOR INSERT TO authenticated
  WITH CHECK (goldstar_private.is_active_staff(auth.uid()) AND EXISTS (
    SELECT 1 FROM public.portal_job_shares s
     WHERE s.id = share_id AND public.can_manage_job(auth.uid(), s.job_id)));
DROP POLICY IF EXISTS portal_share_items_staff_delete ON public.portal_share_items;
CREATE POLICY portal_share_items_staff_delete ON public.portal_share_items
  FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.portal_job_shares s
                  WHERE s.id = share_id AND public.can_manage_job(auth.uid(), s.job_id)));

/* ------------------------------------------------------------------ */
/* 7. Staff RPCs: candidates, invite, turn access off                   */
/* ------------------------------------------------------------------ */

-- The people on a job who could be given the portal, and where each stands.
CREATE OR REPLACE FUNCTION public.portal_job_candidates(_job_id uuid)
RETURNS TABLE (
  contact_id uuid,
  full_name text,
  email text,
  relation text,
  portal_customer_id uuid,
  portal_email text,
  signed_up boolean,
  disabled boolean,
  invite_expires_at timestamptz,
  invite_used_at timestamptz,
  invite_live boolean,
  share_id uuid
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := auth.uid();
BEGIN
  IF NOT goldstar_private.is_active_staff(uid) OR NOT public.can_view_job(uid, _job_id) THEN
    RAISE EXCEPTION 'Not permitted to see this job''s portal access.' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  WITH j AS (SELECT * FROM public.jobs WHERE id = _job_id),
  people AS (
    SELECT j.primary_contact_id AS cid, 'Primary contact'::text AS rel, 1 AS ord FROM j
    UNION ALL SELECT jc.contact_id, 'Job contact', 2 FROM public.job_contacts jc WHERE jc.job_id = _job_id
    UNION ALL SELECT j.public_adjuster_contact_id, 'Public adjuster', 3 FROM j
    UNION ALL SELECT j.field_adjuster_contact_id, 'Field adjuster', 4 FROM j
    UNION ALL SELECT j.desk_adjuster_contact_id, 'Desk adjuster', 5 FROM j
    UNION ALL SELECT j.independent_reviewer_contact_id, 'Independent reviewer', 6 FROM j
    UNION ALL SELECT c.id, 'Account contact', 7 FROM public.contacts c, j
               WHERE c.account_id IS NOT NULL AND c.archived_at IS NULL
                 AND c.account_id IN (j.account_id, j.bill_to_account_id)
  ),
  uniq AS (
    SELECT DISTINCT ON (p.cid) p.cid, p.rel, p.ord FROM people p
     WHERE p.cid IS NOT NULL ORDER BY p.cid, p.ord
  )
  SELECT c.id, c.full_name::text, c.email::text, u.rel,
         pc.id, pc.email, pc.user_id IS NOT NULL, pc.disabled_at IS NOT NULL,
         inv.expires_at, inv.used_at,
         (inv.id IS NOT NULL AND inv.used_at IS NULL AND inv.revoked_at IS NULL AND inv.expires_at > now()),
         s.id
    FROM uniq u
    JOIN public.contacts c ON c.id = u.cid
    LEFT JOIN public.portal_customers pc ON pc.contact_id = c.id
    LEFT JOIN LATERAL (
      SELECT i.* FROM public.portal_invitations i
       WHERE i.portal_customer_id = pc.id ORDER BY i.created_at DESC LIMIT 1
    ) inv ON true
    LEFT JOIN public.portal_job_shares s ON s.portal_customer_id = pc.id AND s.job_id = _job_id
   ORDER BY u.ord, c.full_name;
END $$;

-- Create (or reuse) the contact's portal identity and issue a single-use,
-- expiring invitation. Any earlier unused invitation for the same person is
-- revoked, so there is only ever one live link.
CREATE OR REPLACE FUNCTION public.portal_invite(
  _contact_id uuid,
  _token_hash text,
  _job_id uuid DEFAULT NULL,
  _account_id uuid DEFAULT NULL,
  _email text DEFAULT NULL,
  _valid_hours integer DEFAULT 72
)
RETURNS TABLE (portal_customer_id uuid, invitation_id uuid, expires_at timestamptz, email text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  uid uuid := auth.uid();
  c record;
  pc record;
  em text;
  v_loc uuid;
  v_inv uuid;
  v_exp timestamptz;
BEGIN
  IF NOT goldstar_private.is_active_staff(uid) THEN
    RAISE EXCEPTION 'Only signed-in staff can invite a customer.' USING ERRCODE = '42501';
  END IF;
  IF _token_hash IS NULL OR _token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid invitation token.' USING ERRCODE = '22023';
  END IF;
  IF (_job_id IS NULL) = (_account_id IS NULL) THEN
    RAISE EXCEPTION 'An invitation is sent from exactly one job or one account.' USING ERRCODE = '22023';
  END IF;

  SELECT ct.id, ct.account_id, ct.email, ct.full_name INTO c
    FROM public.contacts ct WHERE ct.id = _contact_id AND ct.archived_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That contact is not available.' USING ERRCODE = '22023';
  END IF;

  IF _job_id IS NOT NULL THEN
    IF NOT public.can_manage_job(uid, _job_id) THEN
      RAISE EXCEPTION 'You can''t give out access to this job.' USING ERRCODE = '42501';
    END IF;
    IF NOT goldstar_private.portal_contact_on_job(_contact_id, _job_id) THEN
      RAISE EXCEPTION 'That person is not on this job.' USING ERRCODE = '42501';
    END IF;
  ELSE
    IF c.account_id IS DISTINCT FROM _account_id THEN
      RAISE EXCEPTION 'That person is not at this account.' USING ERRCODE = '42501';
    END IF;
    SELECT a.location_id INTO v_loc FROM public.accounts a WHERE a.id = _account_id;
    IF NOT (public.is_privileged(uid) OR public.can_manage_location(uid, v_loc)) THEN
      RAISE EXCEPTION 'You can''t give out access for this account.' USING ERRCODE = '42501';
    END IF;
  END IF;

  em := lower(btrim(coalesce(nullif(btrim(_email), ''), c.email)));
  IF em IS NULL OR em !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
    RAISE EXCEPTION 'The customer needs an email address to sign in with.' USING ERRCODE = '22023';
  END IF;
  -- A staff member's address can never become a customer identity; the two
  -- sign-ins must be different people as far as the database is concerned.
  IF EXISTS (SELECT 1 FROM auth.users u
              WHERE lower(u.email) = em AND u.role IS DISTINCT FROM 'portal_customer') THEN
    RAISE EXCEPTION 'That email already has a Recovery Hub staff sign-in, so it can''t be used for the customer portal.'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.portal_customers AS p (contact_id, account_id, email, display_name, created_by)
  VALUES (_contact_id, c.account_id, em, c.full_name, uid)
  ON CONFLICT (contact_id) DO UPDATE
    SET email = CASE WHEN p.user_id IS NULL THEN EXCLUDED.email ELSE p.email END,
        display_name = EXCLUDED.display_name
  RETURNING p.* INTO pc;

  IF pc.disabled_at IS NOT NULL THEN
    RAISE EXCEPTION 'Portal access for this person is turned off. Turn it back on first.'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.portal_invitations i SET revoked_at = now()
   WHERE i.portal_customer_id = pc.id AND i.used_at IS NULL AND i.revoked_at IS NULL;

  INSERT INTO public.portal_invitations AS i
    (portal_customer_id, token_hash, job_id, account_id, expires_at, created_by)
  VALUES (pc.id, _token_hash, _job_id, _account_id,
          now() + make_interval(hours => greatest(1, least(168, coalesce(_valid_hours, 72)))), uid)
  RETURNING i.id, i.expires_at INTO v_inv, v_exp;

  RETURN QUERY SELECT pc.id, v_inv, v_exp, pc.email;
END $$;

CREATE OR REPLACE FUNCTION public.portal_set_customer_disabled(_portal_customer_id uuid, _disabled boolean)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := auth.uid();
BEGIN
  IF NOT goldstar_private.is_active_staff(uid) OR NOT (
       public.is_privileged(uid)
       OR EXISTS (SELECT 1 FROM public.portal_customers pc
                    WHERE pc.id = _portal_customer_id AND pc.created_by = uid)
       OR EXISTS (SELECT 1 FROM public.portal_job_shares s
                    WHERE s.portal_customer_id = _portal_customer_id
                      AND public.can_manage_job(uid, s.job_id))) THEN
    RAISE EXCEPTION 'Not permitted to change this customer''s portal access.' USING ERRCODE = '42501';
  END IF;
  UPDATE public.portal_customers
     SET disabled_at = CASE WHEN _disabled THEN now() END,
         disabled_by = CASE WHEN _disabled THEN uid END
   WHERE id = _portal_customer_id;
  IF _disabled THEN
    UPDATE public.portal_invitations SET revoked_at = now()
     WHERE portal_customer_id = _portal_customer_id AND used_at IS NULL AND revoked_at IS NULL;
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.portal_job_candidates(uuid) FROM PUBLIC, anon, portal_customer;
REVOKE ALL ON FUNCTION public.portal_invite(uuid, text, uuid, uuid, text, integer) FROM PUBLIC, anon, portal_customer;
REVOKE ALL ON FUNCTION public.portal_set_customer_disabled(uuid, boolean) FROM PUBLIC, anon, portal_customer;
GRANT EXECUTE ON FUNCTION public.portal_job_candidates(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.portal_invite(uuid, text, uuid, uuid, text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.portal_set_customer_disabled(uuid, boolean) TO authenticated;

/* ------------------------------------------------------------------ */
/* 8. Accepting an invitation — the service role only                   */
/* ------------------------------------------------------------------ */

-- What the invite page may say before a password is set. No session exists
-- yet, so this is only ever called by the server with the service key.
CREATE OR REPLACE FUNCTION public.portal_invitation_lookup(_token_hash text)
RETURNS TABLE (status text, portal_customer_id uuid, email text, display_name text,
               user_id uuid, expires_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE r record;
BEGIN
  SELECT i.*, pc.email AS pc_email, pc.display_name AS pc_name, pc.user_id AS pc_user,
         pc.disabled_at AS pc_disabled
    INTO r
    FROM public.portal_invitations i
    JOIN public.portal_customers pc ON pc.id = i.portal_customer_id
   WHERE i.token_hash = _token_hash;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::text, NULL::text, NULL::uuid, NULL::timestamptz;
    RETURN;
  END IF;
  RETURN QUERY SELECT
    CASE
      WHEN r.pc_disabled IS NOT NULL OR r.revoked_at IS NOT NULL THEN 'revoked'
      WHEN r.used_at IS NOT NULL THEN 'used'
      WHEN r.expires_at <= now() THEN 'expired'
      ELSE 'ok'
    END,
    r.portal_customer_id, r.pc_email, r.pc_name,
    -- The linked sign-in, or a customer sign-in for this address that an
    -- interrupted earlier accept created but never linked. Never a staff one.
    coalesce(r.pc_user, (SELECT au.id FROM auth.users au
                          WHERE lower(au.email) = r.pc_email AND au.role = 'portal_customer'
                          LIMIT 1)),
    r.expires_at;
END $$;

-- Spend the invitation and attach the sign-in, in one transaction under a row
-- lock, so two tabs racing the same link produce exactly one winner.
CREATE OR REPLACE FUNCTION public.portal_accept_invitation(_token_hash text, _user_id uuid)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  inv record;
  pc record;
  u record;
BEGIN
  SELECT * INTO inv FROM public.portal_invitations WHERE token_hash = _token_hash FOR UPDATE;
  IF NOT FOUND OR inv.used_at IS NOT NULL OR inv.revoked_at IS NOT NULL OR inv.expires_at <= now() THEN
    RAISE EXCEPTION 'This invitation is no longer valid.' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO pc FROM public.portal_customers WHERE id = inv.portal_customer_id FOR UPDATE;
  IF pc.disabled_at IS NOT NULL THEN
    RAISE EXCEPTION 'This invitation is no longer valid.' USING ERRCODE = '42501';
  END IF;
  SELECT au.id, au.role, lower(au.email) AS email INTO u FROM auth.users au WHERE au.id = _user_id;
  IF NOT FOUND OR u.role IS DISTINCT FROM 'portal_customer' OR u.email IS DISTINCT FROM pc.email THEN
    RAISE EXCEPTION 'Only a customer sign-in for this invitation''s address can accept it.'
      USING ERRCODE = '42501';
  END IF;
  IF goldstar_private.has_staff_footprint(_user_id) THEN
    RAISE EXCEPTION 'A staff sign-in can not accept a customer invitation.' USING ERRCODE = '42501';
  END IF;
  IF pc.user_id IS NOT NULL AND pc.user_id <> _user_id THEN
    RAISE EXCEPTION 'This customer already has a different sign-in.' USING ERRCODE = '42501';
  END IF;

  UPDATE public.portal_customers SET user_id = _user_id WHERE id = pc.id;
  UPDATE public.portal_invitations SET used_at = now(), used_by = _user_id WHERE id = inv.id;
  RETURN pc.id;
END $$;

REVOKE ALL ON FUNCTION public.portal_invitation_lookup(text) FROM PUBLIC, anon, authenticated, portal_customer;
REVOKE ALL ON FUNCTION public.portal_accept_invitation(text, uuid) FROM PUBLIC, anon, authenticated, portal_customer;
GRANT EXECUTE ON FUNCTION public.portal_invitation_lookup(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.portal_accept_invitation(text, uuid) TO service_role;

/* ------------------------------------------------------------------ */
/* 9. Deny by default, swept across what already exists                 */
/* ------------------------------------------------------------------ */

-- A restrictive `false` for portal_customer on every table with RLS. Today it
-- is a second lock — the role holds no table privileges to begin with — and
-- it stays shut if a later migration ever grants a table to PUBLIC or to the
-- role by mistake: a restrictive policy is ANDed with every permissive one,
-- so no permissive policy written afterwards can open it.
DO $$
DECLARE r record; n int := 0; open_tables text;
BEGIN
  FOR r IN
    SELECT c.oid, n2.nspname, c.relname
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n2 ON n2.oid = c.relnamespace
     WHERE n2.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relrowsecurity
       AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                        WHERE d.classid = 'pg_catalog.pg_class'::regclass
                          AND d.objid = c.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS portal_customer_denied ON %I.%I', r.nspname, r.relname);
    EXECUTE format(
      'CREATE POLICY portal_customer_denied ON %I.%I AS RESTRICTIVE FOR ALL TO portal_customer USING (false) WITH CHECK (false)',
      r.nspname, r.relname);
    n := n + 1;
  END LOOP;

  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO open_tables
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n2 ON n2.oid = c.relnamespace
   WHERE n2.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity
     AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                      WHERE d.classid = 'pg_catalog.pg_class'::regclass
                        AND d.objid = c.oid AND d.deptype = 'e');
  RAISE NOTICE 'portal deny sweep: restrictive policy on % RLS tables; without RLS (protected by grants alone): %',
    n, coalesce(open_tables, 'none');
END $$;

DO $$
BEGIN
  DROP POLICY IF EXISTS portal_customer_denied ON storage.objects;
  CREATE POLICY portal_customer_denied ON storage.objects AS RESTRICTIVE FOR ALL TO portal_customer
    USING (false) WITH CHECK (false);
EXCEPTION WHEN insufficient_privilege OR undefined_table OR invalid_schema_name THEN
  RAISE NOTICE 'storage.objects deny policy not installed here';
END $$;

-- Grants that reach a new role through PUBLIC. Postgres gives EXECUTE on
-- every new function to PUBLIC; 20260924120000 took that back from what
-- existed then, but anything created since by a role whose defaults were not
-- changed has it again, and PUBLIC includes portal_customer. So, for every
-- function in public or goldstar_private, and every table in public, still
-- granted to PUBLIC: grant the same thing
-- explicitly to each existing role that currently has it (anon, authenticated,
-- service_role keep exactly what they had), then revoke it from PUBLIC. The
-- only role whose access changes is portal_customer, which never had a reason
-- to hold it.
DO $$
DECLARE
  f record; t record; r text; done int := 0; skipped int := 0;
  roles text[] := ARRAY['anon', 'authenticated', 'service_role'];
BEGIN
  FOR f IN
    SELECT p.oid, p.oid::regprocedure AS sig
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname IN ('public', 'goldstar_private')
       AND has_function_privilege('portal_customer', p.oid, 'EXECUTE')
       AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                        WHERE d.classid = 'pg_catalog.pg_proc'::regclass
                          AND d.objid = p.oid AND d.deptype = 'e')
  LOOP
    BEGIN
      FOREACH r IN ARRAY roles LOOP
        IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = r)
           AND has_function_privilege(r, f.oid, 'EXECUTE') THEN
          EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', f.sig, r);
        END IF;
      END LOOP;
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, portal_customer', f.sig);
      done := done + 1;
    EXCEPTION WHEN insufficient_privilege THEN
      skipped := skipped + 1;
    END;
  END LOOP;

  FOR t IN
    SELECT c.oid, format('%I.%I', n.nspname, c.relname) AS name
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
       AND has_table_privilege('portal_customer', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                        WHERE d.classid = 'pg_catalog.pg_class'::regclass
                          AND d.objid = c.oid AND d.deptype = 'e')
  LOOP
    BEGIN
      FOREACH r IN ARRAY roles LOOP
        IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = r) THEN
          IF has_table_privilege(r, t.oid, 'SELECT') THEN EXECUTE format('GRANT SELECT ON %s TO %I', t.name, r); END IF;
          IF has_table_privilege(r, t.oid, 'INSERT') THEN EXECUTE format('GRANT INSERT ON %s TO %I', t.name, r); END IF;
          IF has_table_privilege(r, t.oid, 'UPDATE') THEN EXECUTE format('GRANT UPDATE ON %s TO %I', t.name, r); END IF;
          IF has_table_privilege(r, t.oid, 'DELETE') THEN EXECUTE format('GRANT DELETE ON %s TO %I', t.name, r); END IF;
        END IF;
      END LOOP;
      EXECUTE format('REVOKE ALL ON %s FROM PUBLIC, portal_customer', t.name);
      done := done + 1;
    EXCEPTION WHEN insufficient_privilege THEN
      skipped := skipped + 1;
    END;
  END LOOP;
  RAISE NOTICE 'PUBLIC grant sweep: % objects narrowed, % skipped (not ours to change)', done, skipped;
END $$;

-- The same for everything created later. Defaults are per creating role; the
-- supabase_admin half is attempted and skipped if refused, as in 20260924120000.
DO $$
BEGIN
  EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'default function privileges unchanged: not permitted as %', current_user;
END $$;