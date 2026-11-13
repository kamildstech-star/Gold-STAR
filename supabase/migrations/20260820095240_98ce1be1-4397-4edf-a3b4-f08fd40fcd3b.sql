CREATE OR REPLACE FUNCTION public.search_my_past_leads(_q text)
RETURNS TABLE (
  id uuid, address text, locality text, postal_code text,
  incident_type public.incident_type, reported_at timestamptz,
  accepted_at timestamptz, arrived_at timestamptz,
  outcome public.incident_outcome, lifecycle public.incident_lifecycle
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT i.id, i.address, i.locality, i.postal_code, i.incident_type,
         i.reported_at, i.accepted_at, i.arrived_at, i.outcome, i.lifecycle
    FROM public.incidents i
   WHERE auth.uid() IS NOT NULL
     AND (
       i.accepted_by = auth.uid()
       OR EXISTS (SELECT 1 FROM public.incident_attempts a
                   WHERE a.incident_id = i.id AND a.chaser_id = auth.uid())
       OR EXISTS (SELECT 1 FROM public.incident_dispatches d
                   WHERE d.incident_id = i.id AND d.user_id = auth.uid()
                     AND d.response IN ('declined','declined_race','no_action'))
     )
     AND public.incident_market_allowed(auth.uid(), i.market_id)
     AND length(btrim(coalesce(_q, ''))) >= public.chase_setting_num('search_min_chars', 3)::integer
     AND i.reported_at > now() - make_interval(days => public.chase_setting_num('past_lead_search_days', 14)::integer)
     AND (i.address ILIKE '%' || btrim(_q) || '%' OR i.postal_code ILIKE btrim(_q) || '%' OR i.locality ILIKE btrim(_q) || '%')
   ORDER BY i.reported_at DESC
   LIMIT LEAST(public.chase_setting_num('search_result_limit', 20)::integer, 20);
$$;