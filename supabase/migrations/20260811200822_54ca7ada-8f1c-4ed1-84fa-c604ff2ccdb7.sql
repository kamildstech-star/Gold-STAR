DROP FUNCTION IF EXISTS public.search_accounts_minimal(text);

CREATE FUNCTION public.search_accounts_minimal(_query text)
 RETURNS TABLE(account_id uuid, account_name text, owning_location_id uuid, owning_location_code text, owning_location_name text, status account_status, what_they_do text[], primary_contact_name text, viewer_has_full_access boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  q text := btrim(coalesce(_query, ''));
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  IF length(q) < 2 THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT
    a.id,
    a.name,
    l.id,
    l.code,
    l.name,
    a.status,
    a.what_they_do,
    (SELECT c.full_name FROM public.contacts c
      WHERE c.account_id = a.id
      ORDER BY c.is_primary DESC, c.created_at ASC
      LIMIT 1),
    (public.has_role(auth.uid(), 'admin'::app_role)
     OR public.is_member_of(auth.uid(), a.location_id)
     OR public.is_regional_for(auth.uid(), a.location_id)
     OR a.assigned_rep = auth.uid())
  FROM public.accounts a
  JOIN public.locations l ON l.id = a.location_id
  WHERE a.name ILIKE '%' || q || '%'
  ORDER BY a.name
  LIMIT 25;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.search_accounts_minimal(text) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.search_accounts_minimal(text) FROM anon, PUBLIC;

DO $do$
DECLARE src text;
BEGIN
  SELECT prosrc INTO src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'seed_demo_data' LIMIT 1;
  IF src IS NOT NULL AND src LIKE '%loss_types%' THEN
    EXECUTE 'CREATE OR REPLACE FUNCTION public.seed_demo_data() RETURNS TABLE(table_name text, inserted_count bigint) LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''public'' AS $fn$'
      || replace(src, 'loss_types', 'what_they_do') || '$fn$';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.seed_demo_data() TO authenticated';
    EXECUTE 'REVOKE EXECUTE ON FUNCTION public.seed_demo_data() FROM anon, PUBLIC';
  END IF;
END
$do$;
