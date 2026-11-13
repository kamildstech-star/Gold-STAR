-- Demo-data mechanism: an explicit column, never a convention.

CREATE OR REPLACE FUNCTION public.demo_tables()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  -- Child-first ordering: purge walks this array in order.
  SELECT ARRAY[
    'feature_request_status_history','feature_request_comments','feature_request_votes','feature_requests',
    'gift_campaign_recipients','gift_sends','gift_campaigns','gift_catalog',
    'automation_events','automation_rules',
    'incident_events','incidents',
    'money_events','invoice_payments','invoices',
    'quote_line_items','quotes',
    'documents',
    'equipment_placements','equipment',
    'time_entries','shifts',
    'tasks','notifications',
    'job_assignments','job_contacts','job_notes','job_status_history','jobs',
    'captured_communications','touchpoints','account_notes','account_stage_history','contacts',
    'goals','expense_requests','expenses',
    'accounts',
    'location_members','user_roles','profiles'
  ]::text[];
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY public.demo_tables() LOOP
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false', t);
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON public.%I (is_demo) WHERE is_demo',
      t || '_is_demo_idx', t);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.demo_data_counts()
RETURNS TABLE (table_name text, row_count bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE t text; n bigint;
BEGIN
  IF NOT (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'owner')
          OR public.has_role(auth.uid(),'dev')) THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;
  FOREACH t IN ARRAY public.demo_tables() LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE is_demo', t) INTO n;
    IF n > 0 THEN
      table_name := t; row_count := n; RETURN NEXT;
    END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.demo_data_total()
RETURNS bigint
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE t text; n bigint; total bigint := 0;
BEGIN
  FOREACH t IN ARRAY public.demo_tables() LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE is_demo', t) INTO n;
    total := total + n;
  END LOOP;
  RETURN total;
END $$;

CREATE OR REPLACE FUNCTION public.purge_demo_data()
RETURNS TABLE (table_name text, deleted_count bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE t text; n bigint; demo_users uuid[];
BEGIN
  IF NOT (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'owner')) THEN
    RAISE EXCEPTION 'Only owners and admins can remove demo data';
  END IF;

  SELECT coalesce(array_agg(user_id), '{}') INTO demo_users
  FROM public.profiles WHERE is_demo;

  FOREACH t IN ARRAY public.demo_tables() LOOP
    IF t = 'profiles' THEN CONTINUE; END IF;
    EXECUTE format('WITH d AS (DELETE FROM public.%I WHERE is_demo RETURNING 1) SELECT count(*) FROM d', t) INTO n;
    IF n > 0 THEN table_name := t; deleted_count := n; RETURN NEXT; END IF;
  END LOOP;

  -- Demo staff logins: removing the auth user cascades to its profile.
  IF array_length(demo_users, 1) > 0 THEN
    DELETE FROM auth.users WHERE id = ANY(demo_users);
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN table_name := 'profiles'; deleted_count := n; RETURN NEXT; END IF;
  END IF;

  DELETE FROM public.profiles WHERE is_demo;
END $$;

REVOKE ALL ON FUNCTION public.purge_demo_data() FROM public, anon;
REVOKE ALL ON FUNCTION public.demo_data_counts() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.purge_demo_data() TO authenticated;
GRANT EXECUTE ON FUNCTION public.demo_data_counts() TO authenticated;
GRANT EXECUTE ON FUNCTION public.demo_data_total() TO authenticated;
GRANT EXECUTE ON FUNCTION public.demo_tables() TO authenticated;

NOTIFY pgrst, 'reload schema';