DO $$
BEGIN
  BEGIN
    EXECUTE 'REVOKE EXECUTE ON FUNCTION public.st_estimatedextent(text, text) FROM anon, PUBLIC';
    EXECUTE 'REVOKE EXECUTE ON FUNCTION public.st_estimatedextent(text, text, text) FROM anon, PUBLIC';
    EXECUTE 'REVOKE EXECUTE ON FUNCTION public.st_estimatedextent(text, text, text, boolean) FROM anon, PUBLIC';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'postgis functions owned by extension superuser; skipped';
  END;
END $$;