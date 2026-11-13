
DROP FUNCTION IF EXISTS public.search_my_past_leads(text);

CREATE OR REPLACE FUNCTION public.my_chase_region()
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT m.name FROM public.chaser_territories t
    JOIN public.markets m ON m.id = t.market_id
   WHERE t.user_id = auth.uid()
   LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.mask_past_lead_address(_addr text)
RETURNS text
LANGUAGE sql IMMUTABLE SET search_path TO 'public'
AS $$
  SELECT CASE
    WHEN _addr IS NULL OR btrim(_addr) = '' THEN '*** (address withheld)'
    ELSE '*** ' || regexp_replace(btrim(_addr), '^\S+\s*', '')
  END;
$$;

CREATE OR REPLACE FUNCTION public.search_my_past_leads(_q text, _type text DEFAULT NULL)
RETURNS TABLE(
  id uuid, address text, locality text, postal_code text,
  incident_type incident_type, reported_at timestamp with time zone,
  accepted_at timestamp with time zone, arrived_at timestamp with time zone,
  outcome incident_outcome, lifecycle incident_lifecycle,
  attempt_count integer, is_masked boolean, status_code text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  WITH mine AS (
    SELECT i.id, i.address, i.locality, i.postal_code, i.incident_type,
           i.reported_at, i.accepted_at, i.arrived_at, i.outcome, i.lifecycle,
           i.accepted_by,
           (i.reported_at <= now() - make_interval(days => public.chase_setting_num('past_lead_search_days', 14)::integer)) AS masked
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
       AND i.reported_at > now() - make_interval(days => public.chase_setting_num('past_lead_archive_days', 180)::integer)
       AND (_type IS NULL OR _type = '' OR _type = 'all' OR i.incident_type::text = _type)
       AND (i.address ILIKE '%' || btrim(_q) || '%' OR i.postal_code ILIKE btrim(_q) || '%' OR i.locality ILIKE btrim(_q) || '%')
  )
  SELECT m.id,
         CASE WHEN m.masked THEN public.mask_past_lead_address(m.address) ELSE m.address END,
         CASE WHEN m.masked THEN NULL ELSE m.locality END,
         CASE WHEN m.masked THEN NULL ELSE m.postal_code END,
         m.incident_type, m.reported_at,
         CASE WHEN m.masked THEN NULL ELSE m.accepted_at END,
         CASE WHEN m.masked THEN NULL ELSE m.arrived_at END,
         CASE WHEN m.masked THEN NULL ELSE m.outcome END,
         m.lifecycle,
         (SELECT count(*)::integer FROM public.incident_attempts a
           WHERE a.incident_id = m.id AND a.chaser_id = auth.uid()),
         m.masked,
         CASE WHEN m.masked THEN 'office_only'
              WHEN m.accepted_by = auth.uid() THEN 'view_only'
              WHEN m.accepted_by IS NOT NULL THEN 'claimed_elsewhere'
              ELSE 'view_only' END
    FROM mine m
   ORDER BY m.reported_at DESC
   LIMIT LEAST(public.chase_setting_num('search_result_limit', 20)::integer, 20);
$$;

CREATE OR REPLACE FUNCTION public.my_past_lead_summary(_id uuid)
RETURNS TABLE(
  id uuid, address text, locality text, postal_code text,
  incident_type incident_type, reported_at timestamp with time zone,
  accepted_at timestamp with time zone, arrived_at timestamp with time zone,
  outcome incident_outcome, lifecycle incident_lifecycle,
  is_masked boolean, my_attempts jsonb
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  WITH one AS (
    SELECT i.*, (i.reported_at <= now() - make_interval(days => public.chase_setting_num('past_lead_search_days', 14)::integer)) AS masked
      FROM public.incidents i
     WHERE i.id = _id
       AND auth.uid() IS NOT NULL
       AND (
         i.accepted_by = auth.uid()
         OR EXISTS (SELECT 1 FROM public.incident_attempts a
                     WHERE a.incident_id = i.id AND a.chaser_id = auth.uid())
         OR EXISTS (SELECT 1 FROM public.incident_dispatches d
                     WHERE d.incident_id = i.id AND d.user_id = auth.uid())
       )
       AND public.incident_market_allowed(auth.uid(), i.market_id)
  )
  SELECT o.id,
         CASE WHEN o.masked THEN public.mask_past_lead_address(o.address) ELSE o.address END,
         CASE WHEN o.masked THEN NULL ELSE o.locality END,
         CASE WHEN o.masked THEN NULL ELSE o.postal_code END,
         o.incident_type, o.reported_at,
         CASE WHEN o.masked THEN NULL ELSE o.accepted_at END,
         CASE WHEN o.masked THEN NULL ELSE o.arrived_at END,
         CASE WHEN o.masked THEN NULL ELSE o.outcome END,
         o.lifecycle, o.masked,
         CASE WHEN o.masked THEN '[]'::jsonb ELSE COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
                    'at', a.attended_at, 'reason', a.reason_label,
                    'sub_reason', a.sub_reason_label, 'note', a.note,
                    'kept_live', a.kept_live)
                  ORDER BY a.attended_at DESC)
             FROM public.incident_attempts a
            WHERE a.incident_id = o.id AND a.chaser_id = auth.uid()
         ), '[]'::jsonb) END
    FROM one o;
$$;

REVOKE ALL ON FUNCTION public.search_my_past_leads(text, text) FROM public;
REVOKE ALL ON FUNCTION public.my_past_lead_summary(uuid) FROM public;
REVOKE ALL ON FUNCTION public.my_chase_region() FROM public;
GRANT EXECUTE ON FUNCTION public.search_my_past_leads(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.my_past_lead_summary(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.my_chase_region() TO authenticated;
