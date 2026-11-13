ALTER VIEW public.account_fire_rollup SET (security_invoker = true);

DROP POLICY IF EXISTS "calendar update own" ON public.calendar_events;
CREATE POLICY "calendar update own" ON public.calendar_events
FOR UPDATE TO authenticated
USING (
  user_id = (SELECT auth.uid()) OR created_by = (SELECT auth.uid())
  OR public.is_privileged((SELECT auth.uid()))
  OR public.has_role((SELECT auth.uid()), 'location_manager'::app_role)
  OR public.has_role((SELECT auth.uid()), 'sales_manager'::app_role)
)
WITH CHECK (
  user_id = (SELECT auth.uid()) OR created_by = (SELECT auth.uid())
  OR public.is_privileged((SELECT auth.uid()))
  OR public.has_role((SELECT auth.uid()), 'location_manager'::app_role)
  OR public.has_role((SELECT auth.uid()), 'sales_manager'::app_role)
);

DROP POLICY IF EXISTS "captured_comms_update" ON public.captured_communications;
CREATE POLICY "captured_comms_update" ON public.captured_communications
FOR UPDATE TO authenticated
USING (user_id = (SELECT auth.uid()) OR public.is_privileged((SELECT auth.uid())))
WITH CHECK (user_id = (SELECT auth.uid()) OR public.is_privileged((SELECT auth.uid())));

DROP POLICY IF EXISTS "rates visible to managers only" ON public.labour_rates;
CREATE POLICY "rates visible to managers only" ON public.labour_rates
FOR SELECT TO authenticated
USING (
  public.is_privileged((SELECT auth.uid()))
  OR public.can_view_finance((SELECT auth.uid()))
);

DROP POLICY IF EXISTS "property_notes_select" ON public.property_notes;
CREATE POLICY "property_notes_select" ON public.property_notes
FOR SELECT TO authenticated
USING (
  public.is_privileged((SELECT auth.uid()))
  OR created_by = (SELECT auth.uid())
  OR (location_id IS NOT NULL AND public.can_view_location((SELECT auth.uid()), location_id))
);

REVOKE SELECT ON public.profiles FROM authenticated;
GRANT SELECT (
  user_id, full_name, created_at, updated_at, is_active, deactivated_at,
  deactivated_by, language, is_demo, approval_status, approved_at,
  approved_by, rejected_reason
) ON public.profiles TO authenticated;