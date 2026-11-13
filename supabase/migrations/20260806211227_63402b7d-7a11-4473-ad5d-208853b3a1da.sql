-- 1. A view is a bypass by default: without security_invoker it runs as the view
--    owner and ignores RLS on every underlying table. Every view over
--    RLS-protected tables must set this.
ALTER VIEW public.account_fire_rollup SET (security_invoker = true);

-- 2. tasks UPDATE: WITH CHECK must mirror USING, otherwise an editable row can
--    be rewritten into another location or assignee and pushed out of scope.
DROP POLICY IF EXISTS "tasks update in scope" ON public.tasks;
CREATE POLICY "tasks update in scope" ON public.tasks
  FOR UPDATE TO authenticated
  USING (
    assignee = auth.uid()
    OR created_by = auth.uid()
    OR (location_id IS NOT NULL AND public.can_manage_location(auth.uid(), location_id))
  )
  WITH CHECK (
    assignee = auth.uid()
    OR created_by = auth.uid()
    OR (location_id IS NOT NULL AND public.can_manage_location(auth.uid(), location_id))
  );

-- 3. time_entry_corrections INSERT: this feeds payroll, so a correction may only
--    be raised by a manager or by the owner of the time entry.
DROP POLICY IF EXISTS "corrections insert by manager or owner" ON public.time_entry_corrections;
CREATE POLICY "corrections insert by manager or owner" ON public.time_entry_corrections
  FOR INSERT TO authenticated
  WITH CHECK (
    public.has_role(auth.uid(), 'admin')
    OR public.has_role(auth.uid(), 'owner')
    OR public.has_role(auth.uid(), 'dev')
    OR public.has_role(auth.uid(), 'regional')
    OR public.has_role(auth.uid(), 'location_manager')
    OR EXISTS (
      SELECT 1 FROM public.time_entries te
      WHERE te.id = time_entry_corrections.time_entry_id
        AND te.user_id = auth.uid()
    )
  );

-- 4. translations: INSERT stays open so the system can auto-translate on save,
--    but correcting existing text is managers only — a wrong Spanish work-order
--    scope handed to a crew on site is a safety matter.
DROP POLICY IF EXISTS "translations readable" ON public.translations;
CREATE POLICY "translations readable" ON public.translations
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "translations writable" ON public.translations;
CREATE POLICY "translations writable" ON public.translations
  FOR INSERT TO authenticated WITH CHECK (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS "translations correctable" ON public.translations;
CREATE POLICY "translations correctable" ON public.translations
  FOR UPDATE TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR public.has_role(auth.uid(), 'owner')
    OR public.has_role(auth.uid(), 'dev')
    OR public.has_role(auth.uid(), 'regional')
    OR public.has_role(auth.uid(), 'location_manager')
    OR public.has_role(auth.uid(), 'sales_head')
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'admin')
    OR public.has_role(auth.uid(), 'owner')
    OR public.has_role(auth.uid(), 'dev')
    OR public.has_role(auth.uid(), 'regional')
    OR public.has_role(auth.uid(), 'location_manager')
    OR public.has_role(auth.uid(), 'sales_head')
  );

-- 5. Audit helper: lists views in public that do not run as the querying user.
--    PostGIS system views are excluded; they are extension-owned reference data.
CREATE OR REPLACE FUNCTION public.views_missing_security_invoker()
RETURNS TABLE(view_name text)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT c.relname::text
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'v'
    AND c.relname NOT IN ('geometry_columns', 'geography_columns')
    AND NOT coalesce(
      (SELECT o = 'security_invoker=true'
       FROM unnest(coalesce(c.reloptions, '{}')) o
       WHERE o LIKE 'security_invoker=%'
       LIMIT 1),
      false)
  ORDER BY 1
$$;

REVOKE ALL ON FUNCTION public.views_missing_security_invoker() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.views_missing_security_invoker() TO authenticated;