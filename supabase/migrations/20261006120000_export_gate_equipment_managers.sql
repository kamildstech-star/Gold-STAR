-- Exports: office managers may take the Equipment register, and the large
-- export alert stops breaking every export of 500 rows or more.
--
-- 1. OFFICE MANAGERS AND THE EQUIPMENT REGISTER. Mark, 6 Oct, on the
--    Equipment page's new export (#283): office managers get it too. Exports
--    stay a leak surface — "Reps never get files" — so this opens exactly one
--    entity, 'equipment', to exactly the managers: location_manager, its
--    legacy alias office, and regional. The register carries tags, types,
--    office, serial, make, model and notes; no money. Everything else keeps
--    can_export (owner, sales_head, admin, dev). The client lists the same
--    entity and roles in src/lib/export-guard.ts (MANAGER_EXPORTABLE_ENTITIES,
--    EXPORT_MANAGER_ROLES); this function is the gate, the button is not.
--    Every export, manager or not, is still written to export_audit first.
--
-- 2. THE LARGE EXPORT ALERT WAS BROKEN. Past 500 records log_export tells the
--    owners, with
--      INSERT INTO notifications (user_id, kind, title, body, link, priority)
--      VALUES (..., 'export_alert', ...)
--    but notifications has no `kind` and no `link` column — they are `type`
--    (notification_type, NOT NULL, no default) and `href` — and
--    'export_alert' was not a notification_type at all. PL/pgSQL checks a
--    statement when it runs, so this only failed at 500+, where it raised and
--    took the export down with it: the file is produced only after
--    log_export returns. export_audit holds no export of 500+ rows, ever.
--    The alert now writes type/href, and 'export_alert' joins the enum.
--
-- An enum value added in a transaction cannot be used in that same
-- transaction, which is why ADD VALUE stands apart; the function only names
-- it when it runs, by which time it is committed. CREATE OR REPLACE keeps the
-- function's grants: authenticated and service_role, never anon (#247).

ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'export_alert';

CREATE OR REPLACE FUNCTION public.log_export(_surface text, _entity text, _record_count integer, _format text DEFAULT 'csv'::text, _filters jsonb DEFAULT '{}'::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_id uuid; v_name text; v_owner uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF NOT (
    public.can_export(auth.uid())
    -- The one exception: the Equipment register, for office managers.
    OR (
      _entity = 'equipment'
      AND EXISTS (
        SELECT 1 FROM public.user_roles
         WHERE user_id = auth.uid()
           AND role::text IN ('location_manager', 'office', 'regional')
      )
    )
  ) THEN
    RAISE EXCEPTION 'Export is restricted to Sales Head and Owner';
  END IF;
  INSERT INTO public.export_audit (user_id, surface, entity, format, record_count, filters)
  VALUES (auth.uid(), _surface, _entity, _format, GREATEST(_record_count, 0), COALESCE(_filters,'{}'::jsonb))
  RETURNING id INTO v_id;

  IF _record_count >= 500 THEN
    SELECT COALESCE(full_name, email) INTO v_name FROM public.profiles WHERE user_id = auth.uid();
    FOR v_owner IN SELECT user_id FROM public.user_roles WHERE role::text = 'owner' LOOP
      INSERT INTO public.notifications (user_id, type, title, body, href, priority)
      VALUES (v_owner, 'export_alert', 'Large export',
              COALESCE(v_name,'A user') || ' exported ' || _record_count || ' ' || _entity || ' records from ' || _surface || '.',
              '/admin/exports', 'high');
    END LOOP;
  END IF;
  RETURN v_id;
END $function$;
