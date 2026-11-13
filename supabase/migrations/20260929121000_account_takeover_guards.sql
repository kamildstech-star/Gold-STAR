-- Account-takeover guards: an unapproved account reads nothing, and a
-- deactivated account or a changed password ends the sessions that were open.
--
-- WRITTEN, NOT APPLIED. Run after 20260929120000. Re-runnable.
--
-- From the security review Mark commissioned (external-access hardening):
-- "a freshly signed-up account can read nothing", role assignment only through
-- the privileged path, and existing sessions revoked on deactivation and on
-- password change.
--
-- WHAT WAS ALREADY TRUE, proven by supabase/tests/account-takeover.pglite.mjs
-- against the real policies (not retyped):
--   * user_roles, location_members, region_members: writes are privileged
--     only and never to oneself (20260728043303).
--   * profiles: approval / activation columns are written only by the
--     privileged path, enforced by a trigger that sees auth.uid()
--     (20260903130000); insert, update and delete need an active approved
--     profile (20260908013000).
--   * signup metadata grants nothing: handle_new_user reads raw_user_meta_data
--     only for the display name (and to recognise a portal customer, who gets
--     no staff profile at all). A `role` in user_metadata is ignored.
--
-- THE GAP this file closes: 20260908013000 put the active-approved-profile
-- guard on an explicit list of 29 tables, deliberately "no discovery loop".
-- Every table since — and any older one not on the list whose policy reads
-- `TO authenticated USING (true)` — was readable by a signup nobody had
-- approved yet. A pending account needs nothing but its own profile row (the
-- waiting-for-approval screen reads only that), so the guard now goes on every
-- RLS table in public, including ones created later: re-run this file, or
-- see the live audit, supabase/tests/anon-surface-live-audit.sql §5.
--
-- Tables with NO RLS at all are not touched — turning RLS on without policies
-- would lock staff out — and are listed by the live audit §6 for review.

-- ---------------------------------------------------------------------------
-- 1. The active-profile guard on every RLS table
-- ---------------------------------------------------------------------------
-- Same two restrictive policies, same names, same expression as 20260908013000,
-- so a table on its list is simply re-installed identically. `profiles` keeps
-- its own guards (a pending user must still read their own row), and is
-- skipped. Extension-owned tables are reference data and are skipped.
DO $$
DECLARE
  t record;
  n int := 0;
BEGIN
  IF to_regprocedure('goldstar_private.profile_is_active(uuid)') IS NULL THEN
    RAISE EXCEPTION 'goldstar_private.profile_is_active is missing: apply 20260908013000 first';
  END IF;
  FOR t IN
    SELECT c.relname
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'public'
       AND c.relkind IN ('r', 'p')
       AND c.relrowsecurity
       AND c.relname <> 'profiles'
       AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                        WHERE d.classid = 'pg_catalog.pg_class'::regclass
                          AND d.objid = c.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS active_profile_required ON public.%I', t.relname);
    EXECUTE format(
      'CREATE POLICY active_profile_required ON public.%I AS RESTRICTIVE FOR ALL TO authenticated USING ((SELECT goldstar_private.profile_is_active(auth.uid()))) WITH CHECK ((SELECT goldstar_private.profile_is_active(auth.uid())))',
      t.relname);
    EXECUTE format('DROP POLICY IF EXISTS anonymous_business_access_denied ON public.%I', t.relname);
    EXECUTE format(
      'CREATE POLICY anonymous_business_access_denied ON public.%I AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false)',
      t.relname);
    n := n + 1;
  END LOOP;
  RAISE NOTICE 'active-profile guard on % RLS tables', n;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Ending a user's sessions
-- ---------------------------------------------------------------------------
-- A ban (offboarding.functions.ts) stops new sign-ins; it does not end the
-- sessions already open, and a refresh token would keep minting access
-- tokens. Deleting the user's rows from auth.sessions ends them: refresh
-- tokens belong to a session and go with it. An access token already issued
-- lives until it expires (the JWT expiry, a dashboard setting) — but the
-- guard above already refuses that token every row, because the profile is no
-- longer active.
--
-- service_role only. There is no path by which a signed-in user may end
-- somebody else's sessions, or an anonymous caller anyone's.
CREATE OR REPLACE FUNCTION public.revoke_user_sessions(_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE n integer;
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'A user id is required' USING ERRCODE = '22023';
  END IF;
  DELETE FROM auth.refresh_tokens WHERE user_id::text = _user_id::text;
  DELETE FROM auth.sessions WHERE user_id = _user_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

REVOKE ALL ON FUNCTION public.revoke_user_sessions(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_user_sessions(uuid) TO service_role;

-- The same, from a trigger. It must NEVER fail the statement that fired it —
-- an admin's deactivation, a user's password change — so a refusal is a
-- WARNING, not an error: the deactivation stands and the data guard already
-- holds; the server function reports sessionsRevoked honestly.
CREATE OR REPLACE FUNCTION goldstar_private.revoke_sessions_quietly(_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.revoke_user_sessions(_user_id);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'sessions for % were not revoked: %', _user_id, SQLERRM;
END $$;

REVOKE ALL ON FUNCTION goldstar_private.revoke_sessions_quietly(uuid) FROM PUBLIC, anon, authenticated;

-- 2a. On deactivation, whichever path deactivates: the offboarding RPC, the
-- Active toggle on the user editor, an admin approval being revoked.
CREATE OR REPLACE FUNCTION goldstar_private.tg_profile_deactivated_end_sessions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF (OLD.is_active IS TRUE AND NEW.is_active IS NOT TRUE)
     OR (OLD.approval_status = 'approved' AND NEW.approval_status IS DISTINCT FROM 'approved') THEN
    PERFORM goldstar_private.revoke_sessions_quietly(NEW.user_id);
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION goldstar_private.tg_profile_deactivated_end_sessions() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS profiles_deactivated_end_sessions ON public.profiles;
CREATE TRIGGER profiles_deactivated_end_sessions
  AFTER UPDATE OF is_active, approval_status ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION goldstar_private.tg_profile_deactivated_end_sessions();

-- 2b. On a password change. Every open session ends, the one that changed the
-- password included: whoever set it signs in again with it, and whoever had
-- the old one is out. A first password (an invitation being accepted, where
-- the old value is empty) ends nothing.
CREATE OR REPLACE FUNCTION goldstar_private.tg_password_changed_end_sessions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.encrypted_password IS DISTINCT FROM OLD.encrypted_password
     AND coalesce(OLD.encrypted_password, '') <> '' THEN
    PERFORM goldstar_private.revoke_sessions_quietly(NEW.id);
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION goldstar_private.tg_password_changed_end_sessions() FROM PUBLIC, anon, authenticated;

-- A trigger on auth.users is how handle_new_user already works. If this
-- project does not let this role create one, say so and carry on: the
-- deactivation trigger and the RPC above still stand.
DO $$
BEGIN
  DROP TRIGGER IF EXISTS on_auth_user_password_changed ON auth.users;
  CREATE TRIGGER on_auth_user_password_changed
    AFTER UPDATE OF encrypted_password ON auth.users
    FOR EACH ROW EXECUTE FUNCTION goldstar_private.tg_password_changed_end_sessions();
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'password-change trigger not installed: % may not create triggers on auth.users', current_user;
END $$;
