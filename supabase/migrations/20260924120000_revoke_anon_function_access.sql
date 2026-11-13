-- anon could execute 836 functions in public. Now it executes none of ours.
--
-- APPLIED to production on 2026-09-24 and ledgered as 20260924120000.
-- 61 revoked, 775 skipped. Every one of the 775 belongs to the postgis or
-- pg_trgm extension and is owned by supabase_admin, which postgres may not
-- revoke -- checked one by one, not assumed: no application function is left
-- reachable. They are geometry maths and trigram index support, they read no
-- tables, and revoking pg_trgm's operator support would break the search
-- indexes that use it. st_estimatedextent is the only one that touches
-- anything (planner statistics) and it needs table rights of its own.
--
-- Verified from outside afterwards with nothing but the publishable key:
-- can_view_tradeshow_lead_media, resolve_billing_location,
-- commission_overview, sales_director_reps, global_activity, is_employee and
-- undo_exposure_incident all now answer 42501 permission denied, where two of
-- them used to answer. Tables still return [] as they did before.
--
-- And verified inwards, which is the half that could have broken the app:
-- as an admin, leaderboard_standings 32 rows, scorecard_action_counts 64,
-- sales_director_reps 15, touchpoint_activity_days 4, job_running_cost 1,
-- global_activity 5, is_employee true. Nothing signed-in lost anything.
--
-- From the security review Mark commissioned, section 1: "Revoke anon access to
-- RPC functions. Run REVOKE EXECUTE ... FROM anon, public on all functions,
-- then grant access back only where it is intended. PostgREST exposes functions
-- automatically, and SECURITY DEFINER functions bypass RLS."
--
-- WHAT WAS ACTUALLY REACHABLE, probed from outside with nothing but the
-- publishable key before writing this:
--
--   Every table read came back empty -- RLS held on accounts, contacts, jobs,
--   invoices, touchpoints, documents and tasks. No data leaked.
--
--   Of the 19 SECURITY DEFINER functions anon could call with arguments, the
--   ones that matter refused properly: global_activity "Not authorised to read
--   global activity", set_commission_payout_status "Not permitted to change
--   commission payouts", reset_layout_overrides and count_layout_overrides
--   "Not authorized", sales_director_reps returned []. commission_overview
--   returned zeros even for a real rep's id.
--
--   Two answered anyway. resolve_billing_location handed back a real location
--   uuid. can_view_tradeshow_lead_media returned true -- it compares the two
--   uuids the caller passes, so a stranger passing the same value twice gets
--   "yes" (no policy consumes it, so nothing is unlocked by that today).
--
-- So this is not a breach. It is a surface: 836 doors an unauthenticated
-- caller may knock on, where the only thing stopping them is that each door
-- happens to check. Defence that holds because every function remembered to
-- check is defence that fails the first time one forgets, and the next
-- SECURITY DEFINER function is one migration away.
--
-- WHY THIS IS SAFE FOR SIGNED-IN USERS. Measured, not assumed: 1,011 functions
-- are executable by `authenticated`, and every one of them holds its own
-- explicit `authenticated=X` grant -- zero rely on the PUBLIC grant being
-- revoked here. So dropping PUBLIC and anon cannot take anything from a
-- signed-in user. The query behind that claim is in the PR.
--
-- WHY anon NEEDS NOTHING. The unauthenticated paths do not go through
-- PostgREST as anon. Sign-in is Supabase Auth. The public intake form and its
-- address lookup are TanStack server functions holding the service key
-- (src/lib/intake-public.functions.ts), token-gated and rate-limited. Nothing
-- in the client calls an RPC before sign-in.
--
-- PostGIS owns some functions in public as supabase_admin; a REVOKE we lack
-- rights for is skipped rather than failing the migration, and the count is
-- raised as a NOTICE so a survivor is visible rather than silent.

DO $$
DECLARE
  f record;
  revoked int := 0;
  skipped int := 0;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND (has_function_privilege('anon', p.oid, 'EXECUTE')
            OR coalesce(array_to_string(p.proacl, ','), '') LIKE '%=X/%')
  LOOP
    BEGIN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon, PUBLIC', f.sig);
      revoked := revoked + 1;
    EXCEPTION WHEN insufficient_privilege OR OTHERS THEN
      skipped := skipped + 1;
    END;
  END LOOP;
  RAISE NOTICE 'anon revoke sweep: % revoked, % skipped', revoked, skipped;
END $$;

-- Future functions. Postgres grants EXECUTE to PUBLIC on every new function
-- unless told otherwise, so without this the surface grows back one migration
-- at a time. Default privileges are per creating role, so both roles that
-- create functions here are named.
-- Only the role running the migration can set its own defaults; asking for
-- supabase_admin's is refused outright ("permission denied to change default
-- privileges") and takes the whole migration with it, so it is attempted and
-- skipped rather than assumed.
DO $$
BEGIN
  EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'default privileges unchanged: not permitted as %', current_user;
END $$;

DO $$
BEGIN
  EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'supabase_admin default privileges unchanged: not permitted as %', current_user;
END $$;
