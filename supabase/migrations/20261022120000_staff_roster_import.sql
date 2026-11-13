-- The company's 37 staff, their roles and their offices (22 Oct).
--
-- WHAT THIS CAN AND CANNOT DO
--   A sign-in account (auth.users + auth.identities) is created only through
--   Supabase's Admin API — no migration in this repo inserts into auth.users,
--   and hand-made auth rows are not something GoTrue supports. So this file:
--     1. makes sure every office exists (creating the missing ones);
--     2. records the roster in public.staff_roster — one row per person,
--        keyed by lower-case email, so a second import updates, never adds;
--     3. applies the roster to everybody who ALREADY has an account (matched
--        by email, case-insensitive): name, job title, roles, offices,
--        primary office, approval. Passwords and sessions are not touched.
--   People with no account yet are left "awaiting_account". An admin
--   provisions them from Admin → Users → Staff roster: "Create account" (no
--   email), "Copy invite link" (no email) or "Send invite" (one email, one
--   person). Nothing here or there sends mail by itself. Provisioning runs
--   the same apply_staff_roster() as below, so they get the same scope.
--
-- RULES (from the roster brief)
--   - Roles become exactly the roster's, EXCEPT admin and dev are never
--     removed — our own team accounts keep their break-glass roles.
--   - Offices become exactly the roster's. "all" = every active office;
--     "all_except" = every active office but one (Brooklyn). The primary is
--     the listed primary office.
--   - A regional or owner is added to the region(s) their primary office is
--     in (location_regions), when there are any. Regions are never removed.
--   - The profile is approved (pending users are locked out of everything by
--     profile_is_active()). A DEACTIVATED profile is left deactivated and
--     reported — re-activating someone is a decision, not an import.
--   - Each person is applied in their own sub-transaction: one failure (a
--     portal customer with a staff email, say) is reported, not fatal.
--
-- IDEMPOTENT: every write is skipped when the value already matches, so a
-- second run reports "unchanged" for everybody and writes nothing else.
-- The report is the staff_roster.last_outcome / last_detail columns and the
-- NOTICE lines this file prints in the migration log.

-- ---------------------------------------------------------------------------
-- 1. Offices
-- ---------------------------------------------------------------------------
-- Matched, in order: by code; by city + state; for a state with exactly one
-- active office (not NY, which has two), by state. Created only when none
-- match. The original six were seeded with the state as the code
-- (20260728004107); new ones follow that, with NY-UP for upstate New York.
-- `address` is NOT NULL: a new office gets its city as a placeholder and its
-- city-centre position, to be completed under Admin → Offices.

CREATE TABLE IF NOT EXISTS public.staff_roster_offices (
  key         text PRIMARY KEY,
  location_id uuid REFERENCES public.locations(id) ON DELETE SET NULL,
  label       text NOT NULL
);
ALTER TABLE public.staff_roster_offices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.staff_roster_offices FROM PUBLIC, anon;
DROP POLICY IF EXISTS staff_roster_offices_read ON public.staff_roster_offices;
CREATE POLICY staff_roster_offices_read ON public.staff_roster_offices
  FOR SELECT TO authenticated
  USING (public.is_privileged((SELECT auth.uid())));
GRANT SELECT ON public.staff_roster_offices TO authenticated;

DO $offices$
DECLARE
  o record;
  v_id uuid;
BEGIN
  FOR o IN
    SELECT * FROM (VALUES
      -- key,          code,    name,               city,          state, lat,      lon,       by_state
      ('brooklyn',    'NY',    'Brooklyn, NY',     'Brooklyn',    'NY',  40.6782,  -73.9442,  false),
      ('lakewood',    'NJ',    'Lakewood, NJ',     'Lakewood',    'NJ',  40.0960,  -74.2177,  false),
      ('garner',      'NC',    'Garner, NC',       'Garner',      'NC',  35.7113,  -78.6142,  false),
      ('atlanta',     'GA',    'Atlanta, GA',      'Atlanta',     'GA',  33.7490,  -84.3880,  false),
      ('los_angeles', 'CA',    'Los Angeles, CA',  'Los Angeles', 'CA',  34.0522, -118.2437,  false),
      ('southfield',  'MI',    'Southfield, MI',   'Southfield',  'MI',  42.4734,  -83.2219,  false),
      ('baltimore',   'MD',    'Baltimore, MD',    'Baltimore',   'MD',  39.2904,  -76.6122,  true),
      ('skokie',      'IL',    'Skokie, IL',       'Skokie',      'IL',  42.0324,  -87.7416,  true),
      ('columbus',    'IN',    'Columbus, IN',     'Columbus',    'IN',  39.2014,  -85.9214,  true),
      ('houston',     'TX',    'Houston, TX',      'Houston',     'TX',  29.7604,  -95.3698,  true),
      ('monsey',      'NY-UP', 'Upstate NY (Monsey)', 'Monsey',   'NY',  41.1112,  -74.0685,  false)
    ) AS t(key, code, name, city, state, lat, lon, by_state)
  LOOP
    v_id := NULL;
    SELECT id INTO v_id FROM public.locations WHERE upper(code) = upper(o.code) LIMIT 1;
    IF v_id IS NULL THEN
      SELECT id INTO v_id FROM public.locations
       WHERE lower(btrim(locality)) = lower(o.city) AND upper(region) = o.state
       ORDER BY active DESC, created_at LIMIT 1;
    END IF;
    IF v_id IS NULL AND o.key = 'monsey' THEN
      SELECT id INTO v_id FROM public.locations
       WHERE name ILIKE '%upstate%' OR name ILIKE '%monsey%'
       ORDER BY active DESC, created_at LIMIT 1;
    END IF;
    IF v_id IS NULL AND o.by_state THEN
      IF (SELECT count(*) FROM public.locations WHERE upper(region) = o.state AND active) = 1 THEN
        SELECT id INTO v_id FROM public.locations WHERE upper(region) = o.state AND active;
      END IF;
    END IF;
    IF v_id IS NULL THEN
      INSERT INTO public.locations (code, name, address, locality, region, lat, lon)
      VALUES (o.code, o.name, o.name, o.city, o.state, o.lat, o.lon)
      RETURNING id INTO v_id;
      RAISE NOTICE 'staff roster: office % created (%)', o.name, o.code;
    END IF;

    INSERT INTO public.staff_roster_offices (key, location_id, label)
    VALUES (o.key, v_id, o.name)
    ON CONFLICT (key) DO UPDATE
      SET location_id = EXCLUDED.location_id
      WHERE staff_roster_offices.location_id IS DISTINCT FROM EXCLUDED.location_id;
  END LOOP;
END
$offices$;

-- ---------------------------------------------------------------------------
-- 2. The roster
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.staff_roster (
  email          text PRIMARY KEY CHECK (email = lower(btrim(email)) AND email LIKE '%_@_%'),
  full_name      text NOT NULL,
  roles          public.app_role[] NOT NULL CHECK (cardinality(roles) > 0),
  job_title      text,
  primary_office text REFERENCES public.staff_roster_offices(key),
  office_scope   text NOT NULL DEFAULT 'primary'
                 CHECK (office_scope IN ('primary', 'all', 'all_except')),
  except_office  text REFERENCES public.staff_roster_offices(key),
  -- 'hold': a shared mailbox — provision on request, never invite.
  invite_policy  text NOT NULL DEFAULT 'invite' CHECK (invite_policy IN ('invite', 'hold')),
  note           text,
  user_id        uuid,
  last_outcome   text CHECK (last_outcome IN
                   ('created', 'updated', 'unchanged', 'awaiting_account', 'held', 'error')),
  last_detail    text,
  last_changed_at timestamptz,
  account_created_at timestamptz,
  invited_at     timestamptz,
  invited_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (office_scope <> 'all_except' OR except_office IS NOT NULL)
);
ALTER TABLE public.staff_roster ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.staff_roster FROM PUBLIC, anon;
DROP POLICY IF EXISTS staff_roster_read ON public.staff_roster;
CREATE POLICY staff_roster_read ON public.staff_roster
  FOR SELECT TO authenticated
  USING (public.is_privileged((SELECT auth.uid())));
DROP POLICY IF EXISTS staff_roster_update ON public.staff_roster;
CREATE POLICY staff_roster_update ON public.staff_roster
  FOR UPDATE TO authenticated
  USING (public.is_privileged((SELECT auth.uid())))
  WITH CHECK (public.is_privileged((SELECT auth.uid())));
GRANT SELECT, UPDATE ON public.staff_roster TO authenticated;

INSERT INTO public.staff_roster
  (email, full_name, roles, job_title, primary_office, office_scope, except_office, invite_policy, note)
SELECT lower(btrim(r.email)), r.full_name, r.roles::public.app_role[], r.job_title,
       r.primary_office, r.office_scope, r.except_office, r.invite_policy, r.note
FROM (VALUES
  ('alberthtorres340@gmail.com',          'Alberth Torres',      '{crew}',             NULL,                          'lakewood',    'primary',    NULL,       'invite', NULL),
  ('aldo.lopez92@gmail.com',              'Aldo Lopez',          '{crew}',             NULL,                          'los_angeles', 'primary',    NULL,       'invite', NULL),
  ('ab463923@gmail.com',                  'Allan Cubero',        '{crew}',             NULL,                          'lakewood',    'primary',    NULL,       'invite', NULL),
  ('angelina.d@goldstarrestoration.com',  'Angelina Deda',       '{office}',           'Office Administrator',        'brooklyn',    'primary',    NULL,       'invite', NULL),
  ('country262622@gmail.com',             'Anthony Martinez',    '{crew}',             NULL,                          'los_angeles', 'primary',    NULL,       'invite', NULL),
  ('aronf@goldstarrestoration.com',       'Aron Feinstein',      '{location_manager}', 'Project Manager',             'southfield',  'primary',    NULL,       'invite', NULL),
  ('aron@goldstarrestoration.com',        'Aron Reyder',         '{regional}',         'Regional Director',           'atlanta',     'primary',    NULL,       'invite', NULL),
  ('bo@goldstarrestoration.com',          'Back Office',         '{admin}',            NULL,                          NULL,          'primary',    NULL,       'hold',   'Shared mailbox — create but leave uninvited'),
  ('ben.g@goldstarrestoration.com',       'Ben Greenfeld',       '{office}',           'Billing Specialist',          'brooklyn',    'primary',    NULL,       'invite', NULL),
  ('b.weichbrod@goldstarrestoration.com', 'Ben Weichbrod',       '{office}',           NULL,                          'lakewood',    'primary',    NULL,       'invite', NULL),
  ('br1an655@icloud.com',                 'Brian Aguilera',      '{crew}',             NULL,                          'baltimore',   'primary',    NULL,       'invite', NULL),
  ('christophergonz04@icloud.com',        'Christopher Gonzalez','{crew}',             NULL,                          'baltimore',   'primary',    NULL,       'invite', NULL),
  ('d.sauer@goldstarrestoration.com',     'David Sauer',         '{regional}',         'Regional Director',           'skokie',      'primary',    NULL,       'invite', NULL),
  ('david.s@goldstarrestoration.com',     'David Stern',         '{owner}',            NULL,                          'lakewood',    'all_except', 'brooklyn', 'invite', 'Client lead'),
  ('gabyelmono1@gmail.com',               'Gabriel Gaytan',      '{crew}',             NULL,                          'lakewood',    'primary',    NULL,       'invite', NULL),
  ('heshyl@goldstarrestoration.com',      'Heshy Landau',        '{owner}',            'Partner',                     'brooklyn',    'all',        NULL,       'invite', NULL),
  ('isaac@goldstarrestoration.com',       'Isaac C',             '{office}',           NULL,                          'brooklyn',    'primary',    NULL,       'invite', NULL),
  ('ivan@goldstarrestoration.com',        'Ivan Cristobal',      '{regional}',         'Regional Director',           'columbus',    'primary',    NULL,       'invite', NULL),
  ('izzy@goldstarrestoration.com',        'Izzy Hecht',          '{location_manager}', 'Senior PM (T&M)',             'lakewood',    'primary',    NULL,       'invite', NULL),
  ('mz.h@goldstarrestoration.com',        'M.Z. Halberstam',     '{regional}',         'Regional Director, Upstate NY','monsey',     'primary',    NULL,       'invite', NULL),
  ('manuel_manu1914@hotmail.com',         'Manuel Morales',      '{crew}',             NULL,                          'lakewood',    'primary',    NULL,       'invite', NULL),
  ('melly.c@goldstarrestoration.com',     'Melly Chein',         '{sales_head}',       NULL,                          'brooklyn',    'primary',    NULL,       'invite', NULL),
  ('miguel.m@goldstarrestoration.com',    'Miguel Martinez',     '{regional}',         'Regional Director',           'garner',      'primary',    NULL,       'invite', NULL),
  ('m.baruchov@goldstarrestoration.com',  'Moshe Baruchov',      '{regional}',         'Regional Director',           'los_angeles', 'primary',    NULL,       'invite', NULL),
  ('mottyd@goldstarrestoration.com',      'Motty Donat',         '{owner}',            'Partner',                     'brooklyn',    'all',        NULL,       'invite', NULL),
  ('mottym@goldstarrestoration.com',      'Motty Miller',        '{owner}',            'Partner',                     'brooklyn',    'all',        NULL,       'invite', NULL),
  ('n.gelbwachs@goldstarrestoration.com', 'Nachman Gelbwachs',   '{regional}',         'Regional Director',           'lakewood',    'primary',    NULL,       'invite', NULL),
  ('nick.j@goldstarrestoration.com',      'Nick Jordan',         '{crew}',             NULL,                          'garner',      'primary',    NULL,       'invite', NULL),
  ('nissan@goldstarrestoration.com',      'Nissan Goldstein',    '{office}',           'Billing Specialist',          'lakewood',    'all_except', 'brooklyn', 'invite', NULL),
  ('ramon.g@goldstarrestoration.com',     'Ramon Gil',           '{crew}',             NULL,                          'brooklyn',    'primary',    NULL,       'invite', NULL),
  ('rayon@goldstarrestoration.com',       'Rayon Genteles',      '{crew}',             NULL,                          'atlanta',     'primary',    NULL,       'invite', NULL),
  ('shua.k@goldstarrestoration.com',      'Shua Knopf',          '{location_manager}', NULL,                          'houston',     'primary',    NULL,       'invite', NULL),
  ('sol.l@goldstarrestoration.com',       'Sol Landau',          '{office}',           'Finance',                     'brooklyn',    'all',        NULL,       'invite', NULL),
  ('sruli.w@goldstarrestoration.com',     'Sruli Weinberger',    '{sales_person}',     NULL,                          'brooklyn',    'primary',    NULL,       'invite', NULL),
  ('bids@goldstarrestoration.com',        'Tova Herskovitz',     '{office}',           NULL,                          'brooklyn',    'primary',    NULL,       'invite', 'Bids inbox'),
  ('blancowilson058@gmail.com',           'Wilson Blanco',       '{crew}',             NULL,                          'lakewood',    'primary',    NULL,       'invite', NULL),
  ('yossi.f@goldstarrestoration.com',     'Yossi Fisher',        '{regional}',         'Regional Director',           'baltimore',   'primary',    NULL,       'invite', NULL)
) AS r(email, full_name, roles, job_title, primary_office, office_scope, except_office, invite_policy, note)
ON CONFLICT (email) DO UPDATE SET
  full_name      = EXCLUDED.full_name,
  roles          = EXCLUDED.roles,
  job_title      = EXCLUDED.job_title,
  primary_office = EXCLUDED.primary_office,
  office_scope   = EXCLUDED.office_scope,
  except_office  = EXCLUDED.except_office,
  invite_policy  = EXCLUDED.invite_policy,
  note           = EXCLUDED.note,
  updated_at     = now()
WHERE (staff_roster.full_name, staff_roster.roles, staff_roster.job_title, staff_roster.primary_office,
       staff_roster.office_scope, staff_roster.except_office, staff_roster.invite_policy, staff_roster.note)
  IS DISTINCT FROM
      (EXCLUDED.full_name, EXCLUDED.roles, EXCLUDED.job_title, EXCLUDED.primary_office,
       EXCLUDED.office_scope, EXCLUDED.except_office, EXCLUDED.invite_policy, EXCLUDED.note);

-- ---------------------------------------------------------------------------
-- 3. Applying the roster to an account
-- ---------------------------------------------------------------------------
-- The office-membership role each app role works in (location_member_role).
CREATE OR REPLACE FUNCTION public.staff_roster_member_role(_roles public.app_role[])
RETURNS public.location_member_role
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN _roles && ARRAY['owner','regional','location_manager']::public.app_role[] THEN 'manager'
    WHEN _roles && ARRAY['crew','field','field_chaser']::public.app_role[] THEN 'field'
    ELSE 'office'
  END::public.location_member_role;
$$;
REVOKE ALL ON FUNCTION public.staff_roster_member_role(public.app_role[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_roster_member_role(public.app_role[]) TO authenticated, service_role;

-- Applies one roster row (or all, with NULL) to the matching accounts.
-- Callable by a migration (no JWT), the service role, or an admin/owner/dev.
CREATE OR REPLACE FUNCTION public.apply_staff_roster(_email text DEFAULT NULL)
RETURNS TABLE (email text, outcome text, detail text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  r record;
  v_uid uuid;
  v_changes text[];
  v_notes text[];
  v_n integer;
  v_primary uuid;
  v_except uuid;
  v_want uuid[];
  v_member_role public.location_member_role;
  v_prof record;
  v_outcome text;
  v_detail text;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_privileged(auth.uid()) THEN
    RAISE EXCEPTION 'Only an owner, admin or developer can apply the staff roster'
      USING ERRCODE = '42501';
  END IF;

  FOR r IN
    SELECT s.* FROM public.staff_roster s
     WHERE _email IS NULL OR s.email = lower(btrim(_email))
     ORDER BY s.email
  LOOP
    v_changes := ARRAY[]::text[];
    v_notes := ARRAY[]::text[];
    v_uid := NULL;
    SELECT u.id INTO v_uid FROM auth.users u WHERE lower(u.email) = r.email LIMIT 1;

    IF v_uid IS NULL THEN
      v_outcome := CASE WHEN r.invite_policy = 'hold' THEN 'held' ELSE 'awaiting_account' END;
      v_detail := CASE WHEN r.invite_policy = 'hold'
        THEN 'No account; shared mailbox — create it from the roster, do not invite'
        ELSE 'No account yet — provision from Admin → Users → Staff roster' END;
    ELSE
      BEGIN
        -- The profile handle_new_user makes; made here if it never ran.
        INSERT INTO public.profiles (user_id, email, full_name, approval_status)
        VALUES (v_uid, r.email, r.full_name, 'pending')
        ON CONFLICT (user_id) DO NOTHING;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        IF v_n > 0 THEN v_changes := v_changes || 'profile created'::text; END IF;

        SELECT p.full_name, p.job_title, p.approval_status, p.is_active, p.primary_location_id
          INTO v_prof FROM public.profiles p WHERE p.user_id = v_uid;

        IF v_prof.full_name IS DISTINCT FROM r.full_name THEN
          UPDATE public.profiles SET full_name = r.full_name WHERE user_id = v_uid;
          v_changes := v_changes || format('name → %s', r.full_name);
        END IF;
        IF r.job_title IS NOT NULL AND v_prof.job_title IS DISTINCT FROM r.job_title THEN
          UPDATE public.profiles SET job_title = r.job_title WHERE user_id = v_uid;
          v_changes := v_changes || format('title → %s', r.job_title);
        END IF;
        IF v_prof.approval_status IS DISTINCT FROM 'approved' THEN
          UPDATE public.profiles
             SET approval_status = 'approved', approved_at = now(),
                 approved_by = auth.uid(), rejected_reason = NULL
           WHERE user_id = v_uid;
          v_changes := v_changes || 'approved'::text;
        END IF;
        IF v_prof.is_active IS FALSE THEN
          v_notes := v_notes || 'profile is DEACTIVATED — left as is'::text;
        END IF;

        -- Roles: add the roster's, drop others — never admin or dev.
        INSERT INTO public.user_roles (user_id, role)
        SELECT v_uid, x FROM unnest(r.roles) AS x
        ON CONFLICT (user_id, role) DO NOTHING;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        IF v_n > 0 THEN v_changes := v_changes || format('roles +%s', v_n); END IF;
        DELETE FROM public.user_roles ur
         WHERE ur.user_id = v_uid
           AND NOT (ur.role = ANY (r.roles))
           AND ur.role NOT IN ('admin', 'dev');
        GET DIAGNOSTICS v_n = ROW_COUNT;
        IF v_n > 0 THEN v_changes := v_changes || format('roles -%s', v_n); END IF;

        -- Offices.
        SELECT o.location_id INTO v_primary FROM public.staff_roster_offices o WHERE o.key = r.primary_office;
        SELECT o.location_id INTO v_except FROM public.staff_roster_offices o WHERE o.key = r.except_office;
        IF r.office_scope = 'primary' THEN
          v_want := CASE WHEN v_primary IS NULL THEN ARRAY[]::uuid[] ELSE ARRAY[v_primary] END;
        ELSE
          SELECT coalesce(array_agg(l.id ORDER BY l.created_at), ARRAY[]::uuid[]) INTO v_want
            FROM public.locations l
           WHERE (l.active OR l.id = v_primary)
             AND (r.office_scope = 'all' OR l.id IS DISTINCT FROM v_except);
        END IF;
        v_member_role := public.staff_roster_member_role(r.roles);

        DELETE FROM public.location_members lm
         WHERE lm.user_id = v_uid AND NOT (lm.location_id = ANY (v_want));
        GET DIAGNOSTICS v_n = ROW_COUNT;
        IF v_n > 0 THEN v_changes := v_changes || format('offices -%s', v_n); END IF;
        -- The primary first, so the membership trigger's "first wins" agrees.
        INSERT INTO public.location_members (location_id, user_id, role)
        SELECT w, v_uid, v_member_role
          FROM unnest(v_want) WITH ORDINALITY AS t(w, i)
         ORDER BY (w = v_primary) DESC, i
        ON CONFLICT (location_id, user_id) DO NOTHING;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        IF v_n > 0 THEN v_changes := v_changes || format('offices +%s', v_n); END IF;
        UPDATE public.location_members lm SET role = v_member_role
         WHERE lm.user_id = v_uid AND lm.role IS DISTINCT FROM v_member_role;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        IF v_n > 0 THEN v_changes := v_changes || format('office role → %s (%s)', v_member_role, v_n); END IF;

        UPDATE public.profiles p SET primary_location_id = v_primary
         WHERE p.user_id = v_uid AND p.primary_location_id IS DISTINCT FROM v_primary;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        IF v_n > 0 THEN v_changes := v_changes || 'primary office set'::text; END IF;

        -- Regions for a regional director or owner: their primary office's.
        IF r.roles && ARRAY['regional','owner']::public.app_role[] AND v_primary IS NOT NULL THEN
          INSERT INTO public.region_members (region_id, user_id)
          SELECT lr.region_id, v_uid FROM public.location_regions lr WHERE lr.location_id = v_primary
          ON CONFLICT (region_id, user_id) DO NOTHING;
          GET DIAGNOSTICS v_n = ROW_COUNT;
          IF v_n > 0 THEN v_changes := v_changes || format('regions +%s', v_n); END IF;
          IF NOT EXISTS (SELECT 1 FROM public.location_regions lr WHERE lr.location_id = v_primary) THEN
            v_notes := v_notes || 'primary office is in no region yet'::text;
          END IF;
        END IF;

        v_outcome := CASE WHEN cardinality(v_changes) > 0 THEN 'updated' ELSE 'unchanged' END;
        v_detail := nullif(array_to_string(v_changes || v_notes, '; '), '');
      EXCEPTION WHEN OTHERS THEN
        v_outcome := 'error';
        v_detail := SQLERRM;
      END;
    END IF;

    -- The report. Only written when it says something new.
    UPDATE public.staff_roster s
       SET user_id = v_uid,
           last_outcome = v_outcome,
           last_detail = v_detail,
           last_changed_at = CASE WHEN v_outcome IN ('updated', 'error') THEN now() ELSE s.last_changed_at END
     WHERE s.email = r.email
       AND (s.user_id, s.last_outcome, s.last_detail) IS DISTINCT FROM (v_uid, v_outcome, v_detail);

    email := r.email; outcome := v_outcome; detail := v_detail;
    RETURN NEXT;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.apply_staff_roster(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_staff_roster(text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Apply now, to everybody who already has an account; print the report.
-- ---------------------------------------------------------------------------
DO $apply$
DECLARE
  x record;
  c_created int := 0; c_updated int := 0; c_unchanged int := 0;
  c_awaiting int := 0; c_held int := 0; c_error int := 0;
BEGIN
  FOR x IN SELECT * FROM public.apply_staff_roster(NULL) LOOP
    RAISE NOTICE 'staff roster: % — % %', x.email, x.outcome, coalesce('(' || x.detail || ')', '');
    CASE x.outcome
      WHEN 'updated' THEN c_updated := c_updated + 1;
      WHEN 'unchanged' THEN c_unchanged := c_unchanged + 1;
      WHEN 'awaiting_account' THEN c_awaiting := c_awaiting + 1;
      WHEN 'held' THEN c_held := c_held + 1;
      WHEN 'error' THEN c_error := c_error + 1;
      ELSE c_created := c_created + 1;
    END CASE;
  END LOOP;
  RAISE NOTICE 'staff roster: % updated, % unchanged, % awaiting an account, % held, % errors',
    c_updated, c_unchanged, c_awaiting, c_held, c_error;
END
$apply$;
