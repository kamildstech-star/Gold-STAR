DO $$
BEGIN
  EXECUTE 'REVOKE SELECT ON TABLE public.spatial_ref_sys FROM anon, authenticated';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'could not revoke on spatial_ref_sys: %', SQLERRM;
END $$;