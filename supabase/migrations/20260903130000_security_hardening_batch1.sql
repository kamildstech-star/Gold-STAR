-- Security hardening, batch 1. NOT YET APPLIED — review before running.
--
-- Re-runnable: every CREATE POLICY is preceded by DROP POLICY IF EXISTS, every
-- REVOKE/GRANT is idempotent by nature, and the one new function/trigger uses
-- CREATE OR REPLACE / DROP TRIGGER IF EXISTS.
--
-- Read the section headers before running any of it. Two sections deviate from
-- the audit that prompted them, and say why in place.

/* ==================================================================== */
/* B1. SECURITY DEFINER functions still executable by everyone           */
/* ==================================================================== */
--
-- Correction to the audit's framing: PUBLIC and anon are *already* revoked on
-- all of these. Two blanket DO-loops did it — 20260806223501 and, decisively,
-- 20260810221956, which loops over every SECURITY DEFINER function in `public`
-- and runs `REVOKE ... FROM PUBLIC, anon` followed by
-- `GRANT EXECUTE ... TO authenticated`. So the live exposure is the
-- `authenticated` role, not PUBLIC, and it was granted wholesale rather than
-- left over from the Postgres default.
--
-- WARNING for whoever writes the next migration: if that blanket-grant loop is
-- ever run again, every revoke below silently evaporates. It is the single
-- most dangerous pattern in this migration set.
--
-- Each revoke below was checked against every caller — SQL and TypeScript —
-- before being written. `authenticated` is only removed where nothing calls it
-- as that role.

-- Hourly pay rate. Only callers are public.job_labour_summary(uuid) and
-- public.job_person_hours(uuid), both SECURITY DEFINER, so they keep working:
-- the privilege check inside a definer function is against the function owner,
-- not the caller. No browser call site exists.
REVOKE ALL ON FUNCTION public.rate_for(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rate_for(uuid, date) TO service_role;

-- Commission plan in force for a person. No SQL caller at all, and the one
-- TypeScript wrapper (`commissionTermsOn`, src/lib/pay.ts:162) has no UI call
-- site — it is dead code today. If it is ever wired up it must be re-granted
-- WITH a self-or-finance guard in the body, not re-granted bare.
REVOKE ALL ON FUNCTION public.commission_terms_on(uuid, text, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commission_terms_on(uuid, text, date) TO service_role;

-- Fire-lead matcher. Already revoked from authenticated in 20260818170611;
-- re-asserted here so it survives another blanket grant loop.
REVOKE ALL ON FUNCTION public.match_incidents_to_fire_leads() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.match_incidents_to_fire_leads() TO service_role;

-- These three keep `authenticated` deliberately. Revoking it would break a
-- real flow, and the audit did not ask for it here either:
--   expense_threshold_for  — src/lib/expenses.ts:68 calls it from the browser,
--                            always for the signed-in user's own id.
--   visible_fields         — public.jobs_scoped(uuid[]) is SECURITY INVOKER
--                            (20260806170640) and calls it as the caller.
--   on_duty_chasers        — no caller today, but it is the chase rota read
--                            and the leak is a user-id list, not pay data.
-- Each still leaks another person's row when called with someone else's id.
-- The correct follow-up is a self-or-privileged guard inside each body, which
-- means converting them from LANGUAGE sql to plpgsql — a behavioural change
-- that does not belong in a policy-only migration. Tracked, not done here.
REVOKE ALL ON FUNCTION public.expense_threshold_for(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.on_duty_chasers(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.visible_fields(uuid, text) FROM PUBLIC, anon;

-- Stops the Postgres default (EXECUTE TO PUBLIC) applying to functions created
-- from here on. Note this only covers functions created by the role that runs
-- this statement, so it is a floor, not a fence.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

/* ==================================================================== */
/* B2. time_entries — an employee could approve and inflate their own    */
/* ==================================================================== */
--
-- `time_entries_update` had no WITH CHECK, so Postgres reused USING, and
-- neither expression mentioned `status`. Owning the row was enough to PATCH
-- {"status":"approved","minutes":960} straight into payroll and job costing.
--
-- Correction to the audit: it asked to pin `status = 'pending'`. There is no
-- such value. `public.time_entry_status` is ('draft','submitted','approved',
-- 'rejected') and the column default is 'submitted'. The pin below is
-- ('draft','submitted') — everything before a manager has signed it off.
--
-- WIDENING, deliberate, called out: the old manager path was
-- `EXISTS (shifts s WHERE s.id = shift_id AND can_manage_location(...))`.
-- Rows created by the crew-chief bulk entry path (src/lib/labour.ts:124) have
-- shift_id NULL and job_id set, so that predicate is false for them and the
-- only reason approval works today is the self-approval hole this migration
-- closes. Closing it without a job-based manager path would make those entries
-- unapprovable by anyone. `can_manage_job` is the existing helper for exactly
-- this and is already granted to authenticated.

DROP POLICY IF EXISTS "time_entries_insert" ON public.time_entries;
CREATE POLICY "time_entries_insert" ON public.time_entries
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND status = ANY (ARRAY['draft', 'submitted']::public.time_entry_status[])
    AND approved_by IS NULL
    AND approved_at IS NULL
  );

-- Replaced by the two policies below. Permissive policies OR, so the old one
-- must go rather than sit alongside them.
DROP POLICY IF EXISTS "time_entries_update" ON public.time_entries;

-- Your own row, only while it is still unapproved, and you cannot approve it.
DROP POLICY IF EXISTS "time_entries_update_own" ON public.time_entries;
CREATE POLICY "time_entries_update_own" ON public.time_entries
  FOR UPDATE TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    AND status = ANY (ARRAY['draft', 'submitted']::public.time_entry_status[])
  )
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND status = ANY (ARRAY['draft', 'submitted']::public.time_entry_status[])
    AND approved_by IS NULL
    AND approved_at IS NULL
  );

-- A manager of the shift's location, or of the job, or an owner/admin/dev.
-- This is the only path that may set 'approved' or 'rejected'.
DROP POLICY IF EXISTS "time_entries_update_manager" ON public.time_entries;
CREATE POLICY "time_entries_update_manager" ON public.time_entries
  FOR UPDATE TO authenticated
  USING (
    public.is_privileged((SELECT auth.uid()))
    OR EXISTS (
      SELECT 1 FROM public.shifts s
       WHERE s.id = time_entries.shift_id
         AND public.can_manage_location((SELECT auth.uid()), s.location_id)
    )
    OR (time_entries.job_id IS NOT NULL
        AND public.can_manage_job((SELECT auth.uid()), time_entries.job_id))
  )
  WITH CHECK (
    public.is_privileged((SELECT auth.uid()))
    OR EXISTS (
      SELECT 1 FROM public.shifts s
       WHERE s.id = time_entries.shift_id
         AND public.can_manage_location((SELECT auth.uid()), s.location_id)
    )
    OR (time_entries.job_id IS NOT NULL
        AND public.can_manage_job((SELECT auth.uid()), time_entries.job_id))
  );

/* ==================================================================== */
/* B3. profiles — a pending or rejected signup could approve itself      */
/* ==================================================================== */
--
-- 20260814064957 is a two-line file that re-granted `SELECT, INSERT, UPDATE`
-- on profiles to authenticated. 20260821175812 revoked SELECT and replaced it
-- with a column list; it did not touch UPDATE. With the self-update policy
-- checking only `user_id = auth.uid() AND is_active = true`, a rejected user
-- could PATCH {"approval_status":"approved","is_active":true} on their own row
-- — and a deactivated one could switch themselves back on.
--
-- DEVIATION from the audit, and the reason for it:
--
-- The audit's grant list (full_name, language, work_phone, extension,
-- mobile_phone, job_title) is right about what a person may edit on
-- themselves, but column privileges are held by the `authenticated` DATABASE
-- ROLE, which every signed-in user shares. Postgres cannot tell an admin from
-- a crew member here. Three real admin flows write the other columns through
-- the caller's own client and would break on that list alone:
--   src/lib/admin.functions.ts:349  adminApproveUser  (approval_status,
--                                   approved_at, approved_by,
--                                   rejected_reason, is_active)
--   src/lib/admin.functions.ts:403  adminRejectUser
--   src/components/user-editor.tsx:94  the is_active toggle
-- adminApproveUser goes through context.supabase on purpose, so the audit
-- triggers see a real actor rather than the service role.
--
-- So the grant keeps those columns and the escalation is blocked one level
-- down, by a trigger that can see auth.uid(). Everything not named below —
-- email, is_demo, user_id, created_at — becomes unwritable by authenticated
-- at all, which the previous table-wide grant did not manage.

-- Nothing in the app inserts a profile from the client: public.handle_new_user
-- is SECURITY DEFINER on auth.users, so signup is unaffected.
REVOKE INSERT, UPDATE ON public.profiles FROM authenticated;

-- The grant list, restricted to the columns that exist when this runs. The
-- four contact columns (work_phone, extension, mobile_phone, job_title) arrive
-- with 20260826100000_profile_contact_details, which is unapplied in
-- production as of 2026-09-03 and may run after this file; a literal GRANT
-- naming a missing column would abort the whole migration. That file grants
-- UPDATE on its own four columns, so the end state is the same in either
-- order. Nothing outside this list is ever granted.
DO $$
DECLARE cols text;
BEGIN
  SELECT string_agg(quote_ident(column_name), ', ' ORDER BY column_name) INTO cols
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'profiles'
    AND column_name IN (
      -- self-service
      'full_name', 'language', 'work_phone', 'extension', 'mobile_phone', 'job_title',
      -- privileged, and gated by profiles_privilege_guard below
      'is_active', 'deactivated_at', 'deactivated_by',
      'approval_status', 'approved_at', 'approved_by', 'rejected_reason'
    );
  EXECUTE format('GRANT UPDATE (%s) ON public.profiles TO authenticated', cols);
END $$;

CREATE OR REPLACE FUNCTION public.tg_profiles_privilege_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- No JWT means service_role or a definer job (handle_new_user, seeds,
  -- admin RPCs). Those are already trusted; the guard is about signed-in
  -- users acting on their own behalf.
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  IF public.is_privileged(auth.uid()) THEN RETURN NEW; END IF;

  IF NEW.approval_status  IS DISTINCT FROM OLD.approval_status
     OR NEW.approved_at    IS DISTINCT FROM OLD.approved_at
     OR NEW.approved_by    IS DISTINCT FROM OLD.approved_by
     OR NEW.rejected_reason IS DISTINCT FROM OLD.rejected_reason
     OR NEW.is_active      IS DISTINCT FROM OLD.is_active
     OR NEW.deactivated_at IS DISTINCT FROM OLD.deactivated_at
     OR NEW.deactivated_by IS DISTINCT FROM OLD.deactivated_by
     OR NEW.user_id        IS DISTINCT FROM OLD.user_id
     OR NEW.email          IS DISTINCT FROM OLD.email
     OR NEW.is_demo        IS DISTINCT FROM OLD.is_demo
  THEN
    RAISE EXCEPTION 'Only an owner, admin or developer can change approval or activation on a profile';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.tg_profiles_privilege_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS profiles_privilege_guard ON public.profiles;
CREATE TRIGGER profiles_privilege_guard
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.tg_profiles_privilege_guard();

/* ==================================================================== */
/* B4. Credential tables that permit on a NULL scope                     */
/* ==================================================================== */
--
-- `X IS NULL OR ...` is the right shape for the seventeen tables where a NULL
-- scope genuinely means "company-wide, everyone" — document_templates,
-- automation_rules and friends. It is the wrong shape for a table whose rows
-- are credentials. Only the three below are changed.

-- Company-wide insurance and licence records: policy numbers, carriers,
-- limits. Every authenticated user could read them.
DROP POLICY IF EXISTS cc_select ON public.company_credentials;
CREATE POLICY cc_select ON public.company_credentials
  FOR SELECT TO authenticated
  USING (
    -- The company-wide branch is the leading is_privileged() clause; the bare
    -- `holder_location_id IS NULL OR` that used to sit here is simply gone.
    public.is_privileged((SELECT auth.uid()))
    OR holder_user_id = (SELECT auth.uid())
    OR public.can_view_location((SELECT auth.uid()), holder_location_id)
  );

-- Integration connections carry a `config` jsonb. A global (location_id NULL)
-- connection was readable by anyone signed in.
DROP POLICY IF EXISTS "connections viewable by members" ON public.integration_connections;
CREATE POLICY "connections viewable by members" ON public.integration_connections
  FOR SELECT TO authenticated
  USING (
    (location_id IS NULL AND public.is_privileged((SELECT auth.uid())))
    OR public.can_view_location((SELECT auth.uid()), location_id)
  );

-- Judged warranted: photo_access_log rows carry the IP address and user agent
-- of whoever opened a share link — including customers. Rows are written with
-- project_id NULL by the SECURITY DEFINER insert in 20260820191259, so the
-- NULL branch was not an empty set.
DROP POLICY IF EXISTS "photo_access_log_select_manager" ON public.photo_access_log;
CREATE POLICY "photo_access_log_select_manager" ON public.photo_access_log
  FOR SELECT TO authenticated
  USING (
    (project_id IS NULL AND public.is_privileged((SELECT auth.uid())))
    OR public.can_manage_project((SELECT auth.uid()), project_id)
  );

/* ==================================================================== */
/* B5. Commission and achievement rewriters granted to everyone          */
/* ==================================================================== */

-- recompute_all_commissions() rewrites commission_payouts for every job and
-- was callable by any authenticated user with no check at all. It is called
-- from the browser (src/lib/commissions.ts:114), so it needs the guard rather
-- than a revoke. Body is unchanged apart from the guard; the pattern is copied
-- from set_commission_payout_status in the same file (bare RAISE EXCEPTION —
-- no migration in this repo uses ERRCODE).
CREATE OR REPLACE FUNCTION public.recompute_all_commissions()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE r record; n int := 0;
BEGIN
  IF NOT public.can_view_finance(auth.uid()) THEN
    RAISE EXCEPTION 'Not permitted to recompute commissions';
  END IF;

  FOR r IN SELECT id FROM public.jobs LOOP
    n := n + public.compute_job_commissions(r.id);
  END LOOP;
  RETURN n;
END;
$$;

-- DEVIATION: the audit asked for the same can_view_finance guard inside
-- award_achievements(). That would break it. Its only caller is the cron hook
-- src/routes/api/public/hooks/run-automations.ts:69, which uses the service
-- role — auth.uid() is NULL there, so `NOT can_view_finance(NULL)` is true and
-- the guard would raise on every scheduled run. Revoking the `authenticated`
-- grant achieves the same end without touching a 230-line body: the cron keeps
-- its service_role EXECUTE, nobody else has any.
REVOKE ALL ON FUNCTION public.award_achievements() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.award_achievements() TO service_role;

/* ==================================================================== */
/* B6. property_notes — writable by anyone signed in                     */
/* ==================================================================== */
--
-- SELECT is scoped; INSERT and UPDATE were `WITH CHECK (auth.uid() IS NOT
-- NULL)`. A note you cannot read was still yours to rewrite, and UPDATE had no
-- constraint on the new row, so a note could be moved to a location you cannot
-- see. Both now mirror the SELECT predicate, on both sides of the update.

DROP POLICY IF EXISTS "property_notes_insert" ON public.property_notes;
CREATE POLICY "property_notes_insert" ON public.property_notes
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_privileged((SELECT auth.uid()))
    OR created_by = (SELECT auth.uid())
    OR (location_id IS NOT NULL
        AND public.can_view_location((SELECT auth.uid()), location_id))
  );

DROP POLICY IF EXISTS "property_notes_update" ON public.property_notes;
CREATE POLICY "property_notes_update" ON public.property_notes
  FOR UPDATE TO authenticated
  USING (
    public.is_privileged((SELECT auth.uid()))
    OR created_by = (SELECT auth.uid())
    OR (location_id IS NOT NULL
        AND public.can_view_location((SELECT auth.uid()), location_id))
  )
  WITH CHECK (
    public.is_privileged((SELECT auth.uid()))
    OR created_by = (SELECT auth.uid())
    OR (location_id IS NOT NULL
        AND public.can_view_location((SELECT auth.uid()), location_id))
  );

/* ==================================================================== */
/* B7. time_entry_corrections — forgeable payroll audit rows             */
/* ==================================================================== */
--
-- 20260806211227 meant to replace the open INSERT policy, but its
-- `DROP POLICY IF EXISTS` named the new policy rather than the old one, so
-- "system records corrections" WITH CHECK (true) survived alongside it.
-- Permissive policies OR, so the tightened policy has been a no-op since.
DROP POLICY IF EXISTS "system records corrections" ON public.time_entry_corrections;
