-- 1. Profiles: hide staff email from ordinary signed-in users (names stay readable)
REVOKE SELECT ON public.profiles FROM authenticated, anon;
GRANT SELECT (user_id, full_name, created_at, updated_at, is_active, deactivated_at, deactivated_by, language, is_demo) ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;

-- 2. Fixed search_path on remaining project functions
ALTER FUNCTION public.demo_tables() SET search_path = public;
ALTER FUNCTION public.set_location_geom() SET search_path = public;

-- 3. Revoke EXECUTE from anon/PUBLIC on all project (non-extension) functions,
--    and from authenticated on trigger-only + admin-only routines.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig, p.prorettype = 'trigger'::regtype AS is_trigger, p.proname
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    LEFT JOIN pg_depend d ON d.objid = p.oid AND d.deptype = 'e'
    WHERE n.nspname = 'public' AND d.objid IS NULL
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', r.sig);
    IF r.is_trigger OR r.proname IN (
      'admin_list_users','match_incidents_to_fire_leads','notify_lead_approvers',
      'resolve_escalation_target','record_last_movement','next_job_number','nearest_location'
    ) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', r.sig);
    END IF;
  END LOOP;
END $$;

-- 4. PostGIS reference table: enable RLS, keep it readable reference data
DO $$
BEGIN
  EXECUTE 'ALTER TABLE public.spatial_ref_sys ENABLE ROW LEVEL SECURITY';
  BEGIN
    EXECUTE 'CREATE POLICY "spatial_ref_sys readable" ON public.spatial_ref_sys FOR SELECT TO authenticated, anon USING (true)';
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
EXCEPTION WHEN insufficient_privilege OR wrong_object_type THEN
  RAISE NOTICE 'spatial_ref_sys not owned by migration role; skipping RLS';
END $$;

-- 5. Chat attachment deletes must also re-check conversation membership
DROP POLICY IF EXISTS "Chat attachments: uploader deletes own" ON storage.objects;
CREATE POLICY "Chat attachments: uploader deletes own"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'chat-attachments'
  AND owner = auth.uid()
  AND name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
  AND public.is_conversation_member((split_part(name, '/', 1))::uuid, auth.uid())
);

-- 6. Feature-request attachment files scoped to a visible attachment row
DROP POLICY IF EXISTS feature_requests_objects_select ON storage.objects;
CREATE POLICY feature_requests_objects_select
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'feature-requests'
  AND (
    owner = auth.uid()
    OR public.is_privileged(auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.feature_request_attachments fa
      WHERE fa.storage_path = storage.objects.name
    )
  )
);

-- 7. Labour rates: regional managers limited to their own region's locations
DROP POLICY IF EXISTS "rates visible to managers only" ON public.labour_rates;
CREATE POLICY "rates visible to managers only"
ON public.labour_rates FOR SELECT TO authenticated
USING (
  public.is_privileged(auth.uid())
  OR (location_id IS NOT NULL AND public.can_manage_location(auth.uid(), location_id))
  OR (location_id IS NOT NULL AND public.is_regional_for(auth.uid(), location_id))
);