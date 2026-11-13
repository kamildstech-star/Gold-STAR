CREATE OR REPLACE FUNCTION public.purge_demo_data()
 RETURNS TABLE(table_name text, deleted_count bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE t text; n bigint; demo_users uuid[];
BEGIN
  IF NOT (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'owner')) THEN
    RAISE EXCEPTION 'Only owners and admins can remove demo data';
  END IF;

  SELECT coalesce(array_agg(user_id), '{}') INTO demo_users
  FROM public.profiles WHERE is_demo;

  FOREACH t IN ARRAY public.demo_tables() LOOP
    IF t = 'profiles' THEN CONTINUE; END IF;
    IF t = 'accounts' THEN
      -- Reference accounts (carriers, public adjusting firms) are real shared
      -- data even when created while demo rows are around. Never purge them.
      EXECUTE 'WITH d AS (DELETE FROM public.accounts WHERE is_demo AND NOT coalesce(is_reference,false) RETURNING 1) SELECT count(*) FROM d' INTO n;
    ELSE
      EXECUTE format('WITH d AS (DELETE FROM public.%I WHERE is_demo RETURNING 1) SELECT count(*) FROM d', t) INTO n;
    END IF;
    IF n > 0 THEN table_name := t; deleted_count := n; RETURN NEXT; END IF;
  END LOOP;

  IF array_length(demo_users, 1) > 0 THEN
    DELETE FROM auth.users WHERE id = ANY(demo_users);
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN table_name := 'profiles'; deleted_count := n; RETURN NEXT; END IF;
  END IF;

  DELETE FROM public.profiles WHERE is_demo;
END $function$;