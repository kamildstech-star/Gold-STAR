DO $$
DECLARE
  r record;
  sig text;
BEGIN
  FOR r IN
    SELECT p.oid, n.nspname, p.proname,
           pg_get_function_identity_arguments(p.oid) AS args,
           pg_get_function_result(p.oid) AS result
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_roles o ON o.oid = p.proowner
    WHERE n.nspname = 'public'
      AND p.prosecdef
      AND o.rolname NOT IN ('supabase_admin', 'postgres_admin')
  LOOP
    sig := format('%I.%I(%s)', r.nspname, r.proname, r.args);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', sig);
    IF r.result = 'trigger' THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', sig);
    ELSE
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', sig);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', sig);
    END IF;
  END LOOP;
END
$$;