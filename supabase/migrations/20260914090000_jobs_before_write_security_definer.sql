-- Job creation has been dead since 6 August. This is the one-line cause.
--
-- WRITTEN, NOT APPLIED. One function is replaced. No table, column, policy,
-- trigger or grant changes, and nothing is dropped.
--
-- THE SYMPTOM. Every attempt to create a job, by every role in every office,
-- fails with HTTP 403 and:
--
--   {"code":"42501","message":"permission denied for function next_job_number"}
--
-- Reproduced 14 Sep as a single-office salesperson creating in their OWN
-- office (qa-guards/job-create-diagnosis.md). Not an office-permission
-- problem: see "WHY THIS IS NOT THE OFFICE WALL" below.
--
-- THE CAUSE, in three facts that only bite together:
--
--   1. `public.jobs_before_write()` is the BEFORE INSERT OR UPDATE trigger on
--      `public.jobs` (20260728041824). On INSERT it allocates the job number by
--      calling `public.next_job_number()` (20260805193344).
--   2. That trigger function is SECURITY INVOKER — the default, because no
--      definition ever said otherwise. So it executes as whoever is inserting,
--      and THAT role needs EXECUTE on `next_job_number()`.
--   3. EXECUTE on `next_job_number()` was revoked from `authenticated` twice:
--        20260806223501 — a loop revoking from a named list that includes it
--        20260818170611 — explicitly, under the heading
--                         "maintenance/cron-only routines are not for end users"
--      No migration grants it back. The whole history of that function is its
--      definition, its one call site, and those two revokes.
--
-- `next_job_number()` is not a maintenance routine. It is on the hot path of
-- every job insert. Revoking it from end users while the trigger still ran as
-- the end user is what killed job creation, and it went unnoticed because of
-- the reporting problem noted at the end of this header.
--
-- THE FIX, and why this one. Mark the TRIGGER function SECURITY DEFINER so it
-- calls `next_job_number()` with the owner's rights. The alternative — granting
-- EXECUTE on `next_job_number()` back to `authenticated` — is rejected on
-- purpose:
--
--   * It would undo two deliberate security migrations and hand every signed-in
--     user the ability to call the counter DIRECTLY, burning job numbers at
--     will. `next_job_number()` INSERTs into `job_number_counters` with
--     ON CONFLICT DO UPDATE last_value + 1; a loop against it would advance the
--     sequence indefinitely and permanently skew every future job number.
--   * The number must only ever be allocated as part of inserting a job. Making
--     the trigger the only thing that can reach it expresses exactly that.
--
-- So after this migration `next_job_number()` STAYS un-callable by `anon` and
-- `authenticated`. Nothing here grants it to anybody. The only caller remains
-- the trigger, which now has the rights to do it.
--
-- WHY THIS IS NOT THE OFFICE WALL. The membership check is an RLS WITH CHECK:
--
--   CREATE POLICY jobs_insert ON public.jobs FOR INSERT TO authenticated
--   WITH CHECK (public.can_create_job((SELECT auth.uid()), location_id));
--
-- PostgreSQL applies an INSERT's WITH CHECK to the FINAL row — after BEFORE ROW
-- triggers have run. So the trigger fires first and the office wall is never
-- reached. This migration does not touch that policy: once the trigger can
-- allocate a number, `can_create_job` resumes deciding who may insert where,
-- exactly as designed, and a cross-office attempt is still correctly refused.
--
-- INJECTION AUDIT, required because the function becomes SECURITY DEFINER.
-- The body below is reproduced verbatim from 20260805193344 and was read line
-- by line:
--
--   * No EXECUTE, no format(), no quote_ident/quote_literal, no dynamic SQL of
--     any kind. There is nothing for a crafted value to be interpolated into.
--   * No user-supplied identifier ever names an object. The only identifiers
--     are literals written here.
--   * Every statement assigns a COMPUTED value to a NEW.* column
--     (`next_job_number()`, `ST_SetSRID(ST_MakePoint(...))`, `now()`, NULL) or
--     raises on a rule violation. NEW.* values are data, never code.
--   * It calls exactly two things: `public.next_job_number()` (schema-qualified,
--     ours) and PostGIS constructors on two float columns.
--   * It reads no table and writes no row outside the one being inserted or
--     updated, so definer rights buy it nothing beyond the counter call.
--   * `SET search_path = public, pg_temp` pins resolution. `public` stays FIRST,
--     exactly as the current definition has it, so PostGIS and
--     `next_job_number` resolve precisely as they do today. Naming `pg_temp`
--     explicitly, and last, is the point: left unnamed it is searched FIRST
--     implicitly, which would let a caller pre-create a temp object that
--     shadows a public one — the standard SECURITY DEFINER hijack. This closes
--     it.
--
-- The body is otherwise UNCHANGED — job_number allocation on INSERT, the
-- immutability guard on UPDATE, geom from lat/lon, updated_at on UPDATE. The
-- only edits are the two lines `SECURITY DEFINER` and the widened
-- `SET search_path`.
--
-- TRIGGER BINDING IS NOT TOUCHED. CREATE OR REPLACE FUNCTION keeps the existing
-- `trg_jobs_before_write` binding (20260728041824) pointing at the same
-- function, and a replaced function is picked up immediately. Dropping and
-- recreating the trigger would open a window in which inserts carry no job
-- number at all, so it is deliberately not done.
--
-- OWNERSHIP. SECURITY DEFINER runs as the function's OWNER, which is the role
-- that created it — the migration role (`postgres`), which holds EXECUTE on
-- `next_job_number()`. CREATE OR REPLACE does not change ownership, so applying
-- this keeps whatever owner the function has today.
--
-- RE-RUNNABLE. CREATE OR REPLACE only; applying twice is identical to once.
-- No grants are issued, so replay cannot widen access.

CREATE OR REPLACE FUNCTION public.jobs_before_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND (NEW.job_number IS NULL OR NEW.job_number = '') THEN
    NEW.job_number := public.next_job_number();
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.job_number IS DISTINCT FROM OLD.job_number THEN
    RAISE EXCEPTION 'job_number is immutable once assigned';
  END IF;
  IF NEW.lat IS NOT NULL AND NEW.lon IS NOT NULL THEN
    NEW.geom := ST_SetSRID(ST_MakePoint(NEW.lon, NEW.lat), 4326)::geography;
  ELSE
    NEW.geom := NULL;
  END IF;
  IF TG_OP = 'UPDATE' THEN NEW.updated_at := now(); END IF;
  RETURN NEW;
END $$;

COMMENT ON FUNCTION public.jobs_before_write() IS
  'BEFORE INSERT OR UPDATE on public.jobs: allocates job_number, enforces its immutability, derives geom, stamps updated_at. SECURITY DEFINER so it can call next_job_number(), which stays revoked from anon and authenticated so end users cannot burn job numbers directly. See 20260914090000.';

-- ===========================================================================
-- Verification after applying
-- ===========================================================================
--
--   -- 1. The function is now definer, with a pinned search_path.
--   SELECT p.prosecdef AS security_definer, p.proconfig
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND p.proname = 'jobs_before_write';
--   -- expected: security_definer = true, proconfig = {search_path=public\, pg_temp}
--
--   -- 2. next_job_number() is STILL locked to end users. This is the half of
--   --    the fix that is easy to undo by accident.
--   SELECT has_function_privilege('authenticated', 'public.next_job_number()', 'EXECUTE') AS authenticated_execute,
--          has_function_privilege('anon',          'public.next_job_number()', 'EXECUTE') AS anon_execute;
--   -- expected: both false
--
--   -- 3. The trigger still points at it, once.
--   SELECT tgname, tgenabled FROM pg_trigger
--    WHERE tgrelid = 'public.jobs'::regclass AND NOT tgisinternal;
--   -- expected: trg_jobs_before_write present and enabled
--
-- STAGING VERIFICATION (the behaviour, not the catalogue). The repository's
-- pglite harness covers this offline —
-- `node supabase/tests/job-create-grant.pglite.mjs node_modules/@electric-sql/pglite/dist/index.js`
-- proves the insert fails before the change and succeeds after it. On staging,
-- repeat the probe from qa-guards/job-create-diagnosis.md:
--
--   1. Sign in as a single-office salesperson (mark+rep-ny@falconmarketing.com).
--   2. New Job -> address + job name, leave GSR location on their own office.
--   3. Expect: the job is created and shows a job_number like GS-EXP-####.
--   4. Then confirm the wall still works: an office the user is NOT a member of
--      must still be refused — and now with the office message being TRUE.
--
-- ALSO WORTH FIXING, SEPARATELY (not this migration, no schema change):
-- `isAccessError` (src/lib/db-errors.ts:143) treats SQLSTATE 42501 and any
-- "permission denied" text as an office-permission problem, so jobs.new.tsx
-- reported this bug to users as "You can't create jobs for the X office —
-- you're not a member." and logged it as "blocked by jobs_insert policy". That
-- mislabelling is why a total outage of job creation looked like a permissions
-- question for five weeks. Worth narrowing so a function-permission error is
-- never again dressed up as an office wall.
--
-- Rollback (restores the broken state — only to prove causation):
--   CREATE OR REPLACE FUNCTION public.jobs_before_write()
--   RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$ ... $$;
--   -- i.e. the same body without SECURITY DEFINER, per 20260805193344.
