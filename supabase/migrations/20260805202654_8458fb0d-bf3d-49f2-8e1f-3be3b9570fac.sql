CREATE OR REPLACE FUNCTION public.scorecard_team_medians(_from timestamp with time zone, _to timestamp with time zone, _location_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(cohort_size integer, touchpoints numeric, meetings_held numeric, accounts_advanced numeric, cadence_health numeric, contact_attempts numeric, jobs_won numeric, billed_value numeric, chase_acceptance numeric, median_tta_minutes numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  ident jsonb := public.scorecard_identity();
  locs uuid[];
  cohort uuid[];
  n integer;
BEGIN
  IF ident IS NULL THEN RETURN; END IF;
  SELECT COALESCE(array_agg(value::uuid), ARRAY[]::uuid[]) INTO locs
    FROM jsonb_array_elements_text(ident->'location_ids') value;

  SELECT COALESCE(array_agg(DISTINCT r.user_id), ARRAY[]::uuid[]) INTO cohort
    FROM public.list_business_reps() r
    JOIN public.location_members lm ON lm.user_id = r.user_id
   WHERE lm.location_id = ANY(locs)
     AND (_location_id IS NULL OR lm.location_id = _location_id);

  n := cardinality(cohort);
  IF n < 3 THEN RETURN; END IF;

  RETURN QUERY
  WITH m AS (
    SELECT * FROM public.scorecard_metrics_raw(_from, _to, cohort)
  )
  SELECT n,
         (percentile_cont(0.5) WITHIN GROUP (ORDER BY m.touchpoints))::numeric,
         (percentile_cont(0.5) WITHIN GROUP (ORDER BY m.meetings_held))::numeric,
         (percentile_cont(0.5) WITHIN GROUP (ORDER BY m.accounts_advanced))::numeric,
         (percentile_cont(0.5) WITHIN GROUP (ORDER BY m.cadence_health))::numeric,
         (percentile_cont(0.5) WITHIN GROUP (ORDER BY m.contact_attempts))::numeric,
         (percentile_cont(0.5) WITHIN GROUP (ORDER BY m.jobs_won))::numeric,
         (percentile_cont(0.5) WITHIN GROUP (ORDER BY m.billed_value))::numeric,
         (percentile_cont(0.5) WITHIN GROUP (ORDER BY m.chase_acceptance))::numeric,
         (percentile_cont(0.5) WITHIN GROUP (ORDER BY m.median_tta_minutes))::numeric
    FROM m;
END $function$;

REVOKE EXECUTE ON FUNCTION public.scorecard_team_medians(timestamptz, timestamptz, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.scorecard_team_medians(timestamptz, timestamptz, uuid) TO authenticated;