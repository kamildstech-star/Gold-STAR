-- 1. Pin search_path on the remaining mutable-search_path functions
ALTER FUNCTION public.cleanup_rate_limit_counters() SET search_path = public, pg_temp;
ALTER FUNCTION public.consume_rate_limit(text,text,integer,integer,integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.peek_rate_limit(text,text,integer,integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.reset_rate_limit(text,text) SET search_path = public, pg_temp;

-- 2. Vehicles: remove the permissive policy that bypassed fleet.view for company-wide rows
DROP POLICY IF EXISTS "vehicles viewable by members" ON public.vehicles;

-- 3. job_calculations: cost/margin rows require a finance capability
DROP POLICY IF EXISTS job_calculations_select ON public.job_calculations;
CREATE POLICY job_calculations_select ON public.job_calculations
FOR SELECT TO authenticated
USING (
  (can_view_location((SELECT auth.uid()), location_id) OR created_by = (SELECT auth.uid()))
  AND (
    public.has_permission((SELECT auth.uid()), 'job.view_costs', NULL::uuid)
    OR public.can_view_finance((SELECT auth.uid()))
    OR public.is_privileged((SELECT auth.uid()))
  )
);

DROP POLICY IF EXISTS job_calculations_insert ON public.job_calculations;
CREATE POLICY job_calculations_insert ON public.job_calculations
FOR INSERT TO authenticated
WITH CHECK (
  created_by = (SELECT auth.uid())
  AND can_view_location((SELECT auth.uid()), location_id)
  AND (
    public.has_permission((SELECT auth.uid()), 'job.view_costs', NULL::uuid)
    OR public.can_view_finance((SELECT auth.uid()))
    OR public.is_privileged((SELECT auth.uid()))
  )
  AND (job_id IS NULL OR EXISTS (
    SELECT 1 FROM public.jobs j
    WHERE j.id = job_calculations.job_id
      AND j.location_id = job_calculations.location_id
      AND can_view_location((SELECT auth.uid()), j.location_id)
  ))
);

DROP POLICY IF EXISTS job_calculations_update ON public.job_calculations;
CREATE POLICY job_calculations_update ON public.job_calculations
FOR UPDATE TO authenticated
USING (
  (can_manage_location((SELECT auth.uid()), location_id) OR created_by = (SELECT auth.uid()))
  AND (
    public.has_permission((SELECT auth.uid()), 'job.view_costs', NULL::uuid)
    OR public.can_view_finance((SELECT auth.uid()))
    OR public.is_privileged((SELECT auth.uid()))
  )
)
WITH CHECK (
  (can_manage_location((SELECT auth.uid()), location_id) OR created_by = (SELECT auth.uid()))
  AND (
    public.has_permission((SELECT auth.uid()), 'job.view_costs', NULL::uuid)
    OR public.can_view_finance((SELECT auth.uid()))
    OR public.is_privileged((SELECT auth.uid()))
  )
  AND (job_id IS NULL OR EXISTS (
    SELECT 1 FROM public.jobs j
    WHERE j.id = job_calculations.job_id
      AND j.location_id = job_calculations.location_id
      AND can_view_location((SELECT auth.uid()), j.location_id)
  ))
);