-- Security audit fixes: money leaks, fail-open policies, and a broken sweep.
--
-- Found by auditing the live database as each role. Every item below was
-- reproduced by running a real query as a real user before being changed.

-- ---------------------------------------------------------------------------
-- 1. Crew and chasers could read invoice and estimate money.
--
-- Reproduced: as the crew test user, `select sum(billed_amount) from invoices`
-- returned $182,800 across 4 invoices, including $83,412.50 collected. The
-- policy asked only "can you see this location", with no finance predicate --
-- unlike job_cost_lines, which correctly gates on role. The permission model
-- already says crew hold neither job.view_costs nor job.view_margin, so RLS
-- and the permission model disagreed; RLS is what actually runs.
--
-- The new rule keeps location scope, then requires one of:
--   * the job.view_costs permission (admin, owner, dev, regional, office,
--     location_manager, sales_head, sales_manager), or
--   * you created the record, or
--   * you are the assigned rep on the account it belongs to -- so a sales rep
--     keeps sight of the money on their own book without holding the
--     org-wide permission.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS invoices_select ON public.invoices;
CREATE POLICY invoices_select ON public.invoices
  FOR SELECT TO authenticated
  USING (
    public.can_view_location((SELECT auth.uid()), location_id)
    AND (
      public.has_permission((SELECT auth.uid()), 'job.view_costs', location_id)
      OR created_by = (SELECT auth.uid())
      OR EXISTS (
        SELECT 1 FROM public.accounts a
        WHERE a.id = invoices.account_id
          AND a.assigned_rep = (SELECT auth.uid())
      )
    )
  );

DROP POLICY IF EXISTS estimates_select ON public.estimates;
CREATE POLICY estimates_select ON public.estimates
  FOR SELECT TO authenticated
  USING (
    public.can_view_location((SELECT auth.uid()), location_id)
    AND (
      public.has_permission((SELECT auth.uid()), 'job.view_costs', location_id)
      OR created_by = (SELECT auth.uid())
      OR EXISTS (
        SELECT 1 FROM public.accounts a
        WHERE a.id = estimates.account_id
          AND a.assigned_rep = (SELECT auth.uid())
      )
    )
  );

-- ---------------------------------------------------------------------------
-- 2. The whole fleet was visible to every authenticated user.
--
-- The policy read `location_id IS NULL OR can_view_location(...)`, and all 31
-- vehicles have a null location -- so the escape hatch was the only branch that
-- ever evaluated. Vehicles with no location now require the fleet permission
-- rather than being public to anyone with a login.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS vehicles_select ON public.vehicles;
CREATE POLICY vehicles_select ON public.vehicles
  FOR SELECT TO authenticated
  USING (
    CASE
      WHEN location_id IS NULL
        THEN public.has_permission((SELECT auth.uid()), 'fleet.view', NULL)
             OR public.is_privileged((SELECT auth.uid()))
      ELSE public.can_view_location((SELECT auth.uid()), location_id)
    END
  );

-- ---------------------------------------------------------------------------
-- 3. Reference accounts were readable by users with no role and no location.
--
-- The policy qual was literally `is_reference`, with no reference to the
-- caller at all, so a signed-in user with zero roles and zero location
-- memberships read all 25 shared carrier records. Reference data is meant to
-- be shared across offices, not with people who have not been onboarded yet.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS accounts_select_reference ON public.accounts;
CREATE POLICY accounts_select_reference ON public.accounts
  FOR SELECT TO authenticated
  USING (
    is_reference
    AND (
      public.is_privileged((SELECT auth.uid()))
      OR EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = (SELECT auth.uid()))
    )
  );

DROP POLICY IF EXISTS contacts_select_reference ON public.contacts;
CREATE POLICY contacts_select_reference ON public.contacts
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.accounts a
      WHERE a.id = contacts.account_id AND a.is_reference
    )
    AND (
      public.is_privileged((SELECT auth.uid()))
      OR EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = (SELECT auth.uid()))
    )
  );

-- ---------------------------------------------------------------------------
-- 4. effective_permissions() let any user read anyone else's permissions.
--
-- Calling it with another user's id returned their full permission set -- a
-- map of the privilege model for any logged-in account. Callers may now ask
-- about themselves; only privileged users may ask about others.
-- ---------------------------------------------------------------------------

DO $do$
DECLARE src text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO src
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'effective_permissions';
  IF src IS NULL THEN RETURN; END IF;

  -- Body kept verbatim; only WHO the rows are computed for is narrowed, so the
  -- permission logic itself is untouched.
  src := replace(src, 'WHERE ur.user_id = _user_id',
    'WHERE ur.user_id = _user_id AND (_user_id = auth.uid() OR public.is_privileged(auth.uid()))');
  src := replace(src, 'WHERE up.user_id = _user_id',
    'WHERE up.user_id = _user_id AND (_user_id = auth.uid() OR public.is_privileged(auth.uid()))');
  EXECUTE src;
END
$do$;

-- ---------------------------------------------------------------------------
-- 5. chase_shift_overtime_sweep() has failed on every run since 20 Aug.
--
-- 858 consecutive failures: it filters location_members on role IN
-- ('manager','owner'), but location_member_role is (manager, office, field) --
-- there is no 'owner'. Postgres raises on the invalid enum literal and the
-- whole function aborts, so no overtime alert has ever been delivered. The
-- literal appears twice; both are replaced with the roles that exist.
-- ---------------------------------------------------------------------------

DO $do$
DECLARE src text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO src
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'chase_shift_overtime_sweep';

  IF src IS NULL THEN RETURN; END IF;

  src := replace(src, '''manager'',''owner''', '''manager'',''office''');
  src := replace(src, '''manager'', ''owner''', '''manager'', ''office''');
  EXECUTE src;
END
$do$;

-- ---------------------------------------------------------------------------
-- 6. Stage auto-advance has never fired, because it is edge-triggered only.
--
-- Two stages are configured and all four triggers are live, but accounts whose
-- activity predates the configuration never get re-evaluated -- at least two
-- already satisfy their condition and are sitting still. stage_advance_sweep()
-- exists as the retroactive backstop and was on no schedule and had no caller.
-- ---------------------------------------------------------------------------

SELECT cron.schedule(
  'stage-advance-sweep',
  '*/10 * * * *',
  $cron$SELECT public.stage_advance_sweep();$cron$
);

-- ---------------------------------------------------------------------------
-- 7. A rep could approve their own expense request.
--
-- er_update_own's USING correctly required status = 'pending', but its
-- WITH CHECK constrained only user_id -- so pending -> approved satisfied both
-- halves. UPDATE policies are permissive and OR'd, and the approvals page had
-- no role guard, so the Approve button rendered over the rep's own request and
-- worked. approval.ts already says "A rep never approves their own entry".
--
-- They may still amend or withdraw their own pending request.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS er_update_own ON public.expense_requests;
CREATE POLICY er_update_own ON public.expense_requests
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid()) AND status = 'pending'::expense_request_status)
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND status IN ('pending'::expense_request_status, 'cancelled'::expense_request_status)
  );
