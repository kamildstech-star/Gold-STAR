CREATE OR REPLACE FUNCTION public.seed_demo_addresses()
RETURNS TABLE(table_name text, inserted_count integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated integer := 0;
  v_acc record;
  v_streets text[] := ARRAY['Maple Ave','Oakridge Dr','Franklin St','Industrial Pkwy','Sunset Blvd','Cedar Ln','Washington Ave','Highland Rd','Riverside Dr','Commerce Way','Park Place','Lincoln Hwy','Willow Creek Rd','Broad St','Harbor View Dr'];
BEGIN
  IF NOT (public.is_privileged(auth.uid()) OR public.has_role(auth.uid(), 'owner')) THEN
    RAISE EXCEPTION 'Not authorised to seed demo data';
  END IF;

  FOR v_acc IN
    SELECT a.id, l.locality, l.region, l.postal_code
      FROM public.accounts a
      JOIN public.locations l ON l.id = a.location_id
     WHERE a.is_demo
       AND (a.address_line1 IS NULL OR btrim(a.address_line1) = '')
  LOOP
    UPDATE public.accounts
       SET address_line1 = (100 + floor(random() * 8900))::int::text || ' ' ||
                           v_streets[1 + floor(random() * array_length(v_streets, 1))::int],
           city = COALESCE(NULLIF(btrim(city), ''), v_acc.locality),
           state = COALESCE(NULLIF(btrim(state), ''), v_acc.region),
           postal_code = COALESCE(NULLIF(btrim(postal_code), ''), v_acc.postal_code)
     WHERE id = v_acc.id;
    v_updated := v_updated + 1;
  END LOOP;

  RETURN QUERY SELECT 'accounts (addresses)'::text, v_updated;
END;
$$;

REVOKE ALL ON FUNCTION public.seed_demo_addresses() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.seed_demo_addresses() TO authenticated;

-- Backfill existing demo records right away (runs as migration owner).
DO $do$
DECLARE
  v_acc record;
  v_streets text[] := ARRAY['Maple Ave','Oakridge Dr','Franklin St','Industrial Pkwy','Sunset Blvd','Cedar Ln','Washington Ave','Highland Rd','Riverside Dr','Commerce Way','Park Place','Lincoln Hwy','Willow Creek Rd','Broad St','Harbor View Dr'];
BEGIN
  FOR v_acc IN
    SELECT a.id, l.locality, l.region, l.postal_code
      FROM public.accounts a
      JOIN public.locations l ON l.id = a.location_id
     WHERE a.is_demo
       AND (a.address_line1 IS NULL OR btrim(a.address_line1) = '')
  LOOP
    UPDATE public.accounts
       SET address_line1 = (100 + floor(random() * 8900))::int::text || ' ' ||
                           v_streets[1 + floor(random() * array_length(v_streets, 1))::int],
           city = COALESCE(NULLIF(btrim(city), ''), v_acc.locality),
           state = COALESCE(NULLIF(btrim(state), ''), v_acc.region),
           postal_code = COALESCE(NULLIF(btrim(postal_code), ''), v_acc.postal_code)
     WHERE id = v_acc.id;
  END LOOP;
END
$do$;