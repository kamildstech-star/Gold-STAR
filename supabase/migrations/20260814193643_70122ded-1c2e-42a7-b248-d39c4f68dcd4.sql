CREATE OR REPLACE FUNCTION public.search_my_past_leads(_q text)
RETURNS TABLE(
  id uuid,
  address text,
  locality text,
  postal_code text,
  incident_type incident_type,
  reported_at timestamp with time zone,
  accepted_at timestamp with time zone,
  arrived_at timestamp with time zone,
  outcome incident_outcome,
  lifecycle incident_lifecycle
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT i.id, i.address, i.locality, i.postal_code, i.incident_type,
         i.reported_at, i.accepted_at, i.arrived_at, i.outcome, i.lifecycle
    FROM public.incidents i
   WHERE auth.uid() IS NOT NULL
     AND i.accepted_by = auth.uid()
     AND public.incident_market_allowed(auth.uid(), i.market_id)
     AND length(btrim(coalesce(_q, ''))) >= public.chase_setting_num('search_min_chars', 3)::integer
     AND i.reported_at > now() - make_interval(days => public.chase_setting_num('past_lead_search_days', 14)::integer)
     AND (i.address ILIKE '%' || btrim(_q) || '%' OR i.postal_code ILIKE btrim(_q) || '%' OR i.locality ILIKE btrim(_q) || '%')
   ORDER BY i.reported_at DESC
   LIMIT LEAST(public.chase_setting_num('search_result_limit', 20)::integer, 20);
$$;

GRANT EXECUTE ON FUNCTION public.search_my_past_leads(text) TO authenticated;