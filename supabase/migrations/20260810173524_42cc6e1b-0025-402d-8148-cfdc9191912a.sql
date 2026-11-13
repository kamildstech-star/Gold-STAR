CREATE OR REPLACE FUNCTION public.accounts_at_address(
  _address text,
  _lat double precision DEFAULT NULL,
  _lon double precision DEFAULT NULL
)
RETURNS TABLE(
  account_id uuid,
  account_name text,
  owning_location_id uuid,
  owning_location_code text,
  owning_location_name text,
  matched_by text,
  match_label text,
  viewer_has_full_access boolean
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  key text := public.normalize_address(_address);
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  IF key IS NULL AND (_lat IS NULL OR _lon IS NULL) THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH hits AS (
    SELECT a.id AS aid,
           a.name AS aname,
           a.location_id AS loc,
           'account_address'::text AS how,
           a.address_line1 AS lbl,
           1 AS pri
    FROM public.accounts a
    WHERE key IS NOT NULL
      AND a.address_line1 IS NOT NULL
      AND public.normalize_address(a.address_line1) = key

    UNION ALL

    SELECT a.id, a.name, a.location_id,
           CASE WHEN key IS NOT NULL AND public.normalize_address(p.address) = key
                THEN 'project_address' ELSE 'project_proximity' END,
           p.name,
           2
    FROM public.projects p
    JOIN public.accounts a ON a.id = p.account_id
    WHERE p.archived_at IS NULL
      AND (
        (key IS NOT NULL AND public.normalize_address(p.address) = key)
        OR (
          _lat IS NOT NULL AND _lon IS NOT NULL
          AND p.lat IS NOT NULL AND p.lon IS NOT NULL
          AND ST_DWithin(
                ST_SetSRID(ST_MakePoint(p.lon, p.lat), 4326)::geography,
                ST_SetSRID(ST_MakePoint(_lon, _lat), 4326)::geography,
                75)
        )
      )
  ), ranked AS (
    SELECT DISTINCT ON (aid) aid, aname, loc, how, lbl
    FROM hits
    ORDER BY aid, pri
  )
  SELECT r.aid, r.aname, l.id, l.code, l.name, r.how, r.lbl,
         (public.has_role(auth.uid(), 'admin'::app_role)
          OR public.has_role(auth.uid(), 'owner'::app_role)
          OR public.can_view_location(auth.uid(), r.loc))
  FROM ranked r
  JOIN public.locations l ON l.id = r.loc
  LIMIT 5;
END;
$$;

REVOKE ALL ON FUNCTION public.accounts_at_address(text, double precision, double precision) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.accounts_at_address(text, double precision, double precision) TO authenticated;