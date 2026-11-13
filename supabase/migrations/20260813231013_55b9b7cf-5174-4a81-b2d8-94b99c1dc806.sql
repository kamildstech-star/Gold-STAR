
-- Incident property lookups: scope to incident visibility
DROP POLICY IF EXISTS incident_property_lookups_select ON public.incident_property_lookups;
CREATE POLICY incident_property_lookups_select
ON public.incident_property_lookups
FOR SELECT
TO authenticated
USING (
  is_privileged((SELECT auth.uid()))
  OR EXISTS (
    SELECT 1 FROM public.incidents i
    WHERE i.id = incident_property_lookups.incident_id
      AND incident_market_allowed((SELECT auth.uid()), i.market_id)
      AND (
        i.accepted_by = (SELECT auth.uid())
        OR i.created_by = (SELECT auth.uid())
        OR (i.location_id IS NOT NULL AND can_view_location((SELECT auth.uid()), i.location_id))
      )
  )
);

-- Labour rates: drop the regional-visibility branch
DROP POLICY IF EXISTS "rates visible to managers only" ON public.labour_rates;
CREATE POLICY "rates visible to managers only"
ON public.labour_rates
FOR SELECT
TO authenticated
USING (
  is_privileged((SELECT auth.uid()))
  OR (location_id IS NOT NULL AND can_manage_location((SELECT auth.uid()), location_id))
);

-- Internal trigger routines should not be callable by signed-out visitors
REVOKE EXECUTE ON FUNCTION public.assign_estimate_seq() FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.recalc_estimate_totals() FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.recalc_estimate_totals_on_rate() FROM anon, PUBLIC;
