-- 1. Library documents live under library/<location-or-all>/... in the compliance
--    bucket. Certificates belong to a Gold Star entity, not to one client.
CREATE OR REPLACE FUNCTION public.can_view_compliance_file_path(_path text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT CASE
    WHEN split_part(_path, '/', 1) = 'library' THEN
      NULLIF(split_part(_path, '/', 2), '') IS NOT NULL
      AND (
        split_part(_path, '/', 2) = 'all'
        OR public.can_view_location((SELECT auth.uid()), NULLIF(split_part(_path, '/', 2), '')::uuid)
      )
    ELSE EXISTS (
      SELECT 1 FROM public.accounts a
      WHERE a.id = NULLIF(split_part(_path, '/', 1), '')::uuid
        AND (a.created_by = (SELECT auth.uid())
          OR a.assigned_rep = (SELECT auth.uid())
          OR public.can_view_location((SELECT auth.uid()), a.location_id))
    )
  END
$$;

CREATE OR REPLACE FUNCTION public.can_manage_compliance_file_path(_path text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT CASE
    WHEN split_part(_path, '/', 1) = 'library' THEN
      NULLIF(split_part(_path, '/', 2), '') IS NOT NULL
      AND (
        split_part(_path, '/', 2) = 'all'
        OR public.can_manage_location((SELECT auth.uid()), NULLIF(split_part(_path, '/', 2), '')::uuid)
      )
    ELSE EXISTS (
      SELECT 1 FROM public.accounts a
      WHERE a.id = NULLIF(split_part(_path, '/', 1), '')::uuid
        AND (a.assigned_rep = (SELECT auth.uid())
          OR public.can_manage_location((SELECT auth.uid()), a.location_id))
    )
  END
$$;

GRANT EXECUTE ON FUNCTION public.can_view_compliance_file_path(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_manage_compliance_file_path(text) TO authenticated;

-- 2. Daily countdown on the credentials library: 7 days out, then every day,
--    then daily once expired. One notification per person per credential per day.
CREATE OR REPLACE FUNCTION public.run_credential_expiry_alerts()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  rec record; u uuid; n integer := 0; label text; affected integer;
BEGIN
  FOR rec IN
    SELECT c.id, c.kind, c.name, c.expiry_date, c.holder_location_id,
           (c.expiry_date - current_date) AS days_left
    FROM public.company_credentials c
    WHERE c.expiry_date IS NOT NULL
      AND c.expiry_date <= current_date + 7
  LOOP
    label := COALESCE(NULLIF(rec.name, ''), rec.kind);

    SELECT count(*) INTO affected
    FROM public.account_compliance_requirements r
    JOIN public.accounts a ON a.id = r.account_id
    WHERE r.requirement_type = rec.kind
      AND (rec.holder_location_id IS NULL OR a.location_id = rec.holder_location_id);

    FOR u IN
      SELECT DISTINCT x FROM (
        SELECT a.assigned_rep AS x
        FROM public.account_compliance_requirements r
        JOIN public.accounts a ON a.id = r.account_id
        WHERE r.requirement_type = rec.kind
          AND (rec.holder_location_id IS NULL OR a.location_id = rec.holder_location_id)
        UNION
        SELECT ur.user_id FROM public.user_roles ur WHERE ur.role IN ('sales_head','admin','owner')
      ) t WHERE x IS NOT NULL
    LOOP
      CONTINUE WHEN EXISTS (
        SELECT 1 FROM public.notifications nt
        WHERE nt.user_id = u AND nt.entity_type = 'company_credential'
          AND nt.entity_id = rec.id AND nt.created_at > now() - interval '20 hours');

      INSERT INTO public.notifications (user_id, type, title, body, entity_type, entity_id, href, priority)
      VALUES (
        u, 'vendor_doc_expiring',
        CASE WHEN rec.days_left < 0 THEN format('%s has expired', label)
             WHEN rec.days_left = 0 THEN format('%s expires today', label)
             ELSE format('%s expires in %s days', label, rec.days_left) END,
        CASE WHEN affected > 0 THEN format('Affects %s account requirement(s).', affected)
             ELSE 'No client currently requires this.' END,
        'company_credential', rec.id, '/compliance',
        CASE WHEN rec.days_left <= 0 THEN 'high'::notification_priority ELSE 'normal'::notification_priority END
      );
      n := n + 1;
    END LOOP;
  END LOOP;
  RETURN n;
END; $$;

GRANT EXECUTE ON FUNCTION public.run_credential_expiry_alerts() TO authenticated;
REVOKE EXECUTE ON FUNCTION public.run_credential_expiry_alerts() FROM anon, PUBLIC;

SELECT cron.schedule('credential-expiry-daily', '5 7 * * *',
  $cron$SELECT public.run_credential_expiry_alerts();$cron$);
