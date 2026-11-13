-- spatial_ref_sys: PostGIS's reference table of coordinate systems, flagged by
-- Supabase's security advisor (rls_disabled_in_public, 31 Oct 2026).
--
-- It holds no Gold Star data, but anon and authenticated still held every
-- privilege on it — INSERT, UPDATE, DELETE, TRUNCATE — so anyone with the
-- project URL could empty it and break every geography function. RLS cannot
-- be enabled on it (the extension owns the table; 20260806223501 tried and
-- skipped), so the API roles lose their grants instead. PostGIS functions
-- read it as their owner and are unaffected.
--
-- Re-runnable. When the migration role does not hold the grant option, the
-- REVOKE is a no-op with a warning — then ask Supabase support to run it.
DO $$
BEGIN
  EXECUTE 'REVOKE ALL ON TABLE public.spatial_ref_sys FROM anon, authenticated';
EXCEPTION WHEN undefined_table OR insufficient_privilege THEN
  RAISE NOTICE 'spatial_ref_sys revoke skipped: %', SQLERRM;
END $$;
