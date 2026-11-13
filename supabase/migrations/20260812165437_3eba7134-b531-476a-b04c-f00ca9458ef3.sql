-- 1. contact_note_dumps / contact_relationship_facts: scope to contact visibility
CREATE OR REPLACE FUNCTION public.can_view_contact_row(_user_id uuid, _contact_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.contacts c
    WHERE c.id = _contact_id
      AND (
        public.is_privileged(_user_id)
        OR public.can_view_location(_user_id, c.location_id)
        OR EXISTS (
          SELECT 1 FROM public.accounts a
          WHERE a.id = c.account_id
            AND (public.can_view_location(_user_id, a.location_id) OR a.assigned_rep = _user_id)
        )
      )
  )
$$;

CREATE OR REPLACE FUNCTION public.can_manage_contact_row(_user_id uuid, _contact_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.contacts c
    WHERE c.id = _contact_id
      AND (
        public.is_privileged(_user_id)
        OR public.can_manage_location(_user_id, c.location_id)
        OR EXISTS (
          SELECT 1 FROM public.accounts a
          WHERE a.id = c.account_id
            AND (public.can_manage_location(_user_id, a.location_id) OR a.assigned_rep = _user_id)
        )
      )
  )
$$;

GRANT EXECUTE ON FUNCTION public.can_view_contact_row(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_manage_contact_row(uuid, uuid) TO authenticated;

DROP POLICY IF EXISTS contact_note_dumps_select ON public.contact_note_dumps;
CREATE POLICY contact_note_dumps_select ON public.contact_note_dumps
  FOR SELECT TO authenticated
  USING (public.can_view_contact_row((SELECT auth.uid()), contact_id));

DROP POLICY IF EXISTS contact_note_dumps_insert ON public.contact_note_dumps;
CREATE POLICY contact_note_dumps_insert ON public.contact_note_dumps
  FOR INSERT TO authenticated
  WITH CHECK (
    created_by = (SELECT auth.uid())
    AND public.can_view_contact_row((SELECT auth.uid()), contact_id)
  );

DROP POLICY IF EXISTS contact_relationship_facts_select ON public.contact_relationship_facts;
CREATE POLICY contact_relationship_facts_select ON public.contact_relationship_facts
  FOR SELECT TO authenticated
  USING (public.can_view_contact_row((SELECT auth.uid()), contact_id));

DROP POLICY IF EXISTS contact_relationship_facts_write ON public.contact_relationship_facts;
CREATE POLICY contact_relationship_facts_write ON public.contact_relationship_facts
  FOR ALL TO authenticated
  USING (public.can_manage_contact_row((SELECT auth.uid()), contact_id))
  WITH CHECK (public.can_manage_contact_row((SELECT auth.uid()), contact_id));

-- 2. incident_attempts: mirror incidents_select scoping
DROP POLICY IF EXISTS incident_attempts_select ON public.incident_attempts;
CREATE POLICY incident_attempts_select ON public.incident_attempts
  FOR SELECT TO authenticated
  USING (
    chaser_id = (SELECT auth.uid())
    OR is_privileged((SELECT auth.uid()))
    OR EXISTS (
      SELECT 1 FROM public.incidents i
      WHERE i.id = incident_attempts.incident_id
        AND public.incident_market_allowed((SELECT auth.uid()), i.market_id)
        AND (
          i.accepted_by = (SELECT auth.uid())
          OR i.created_by = (SELECT auth.uid())
          OR (i.location_id IS NOT NULL AND public.can_view_location((SELECT auth.uid()), i.location_id))
        )
    )
  );

-- 3. company_credentials: scope reads
DROP POLICY IF EXISTS cc_select ON public.company_credentials;
CREATE POLICY cc_select ON public.company_credentials
  FOR SELECT TO authenticated
  USING (
    is_privileged((SELECT auth.uid()))
    OR holder_user_id = (SELECT auth.uid())
    OR holder_location_id IS NULL
    OR public.can_view_location((SELECT auth.uid()), holder_location_id)
  );

-- 4. job_number_counters: internal only
DROP POLICY IF EXISTS job_number_counters_select ON public.job_number_counters;
CREATE POLICY job_number_counters_select ON public.job_number_counters
  FOR SELECT TO authenticated
  USING (is_privileged((SELECT auth.uid())));

-- 5. compliance file path: 'library/all' management restricted to privileged roles
CREATE OR REPLACE FUNCTION public.can_manage_compliance_file_path(_path text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT CASE
    WHEN split_part(_path, '/', 1) = 'library' THEN
      NULLIF(split_part(_path, '/', 2), '') IS NOT NULL
      AND (
        CASE WHEN split_part(_path, '/', 2) = 'all'
          THEN public.is_privileged((SELECT auth.uid()))
          ELSE public.can_manage_location((SELECT auth.uid()), NULLIF(split_part(_path, '/', 2), '')::uuid)
        END
      )
    ELSE EXISTS (
      SELECT 1 FROM public.accounts a
      WHERE a.id = NULLIF(split_part(_path, '/', 1), '')::uuid
        AND (a.assigned_rep = (SELECT auth.uid())
          OR public.can_manage_location((SELECT auth.uid()), a.location_id))
    )
  END
$function$;

CREATE OR REPLACE FUNCTION public.can_view_compliance_file_path(_path text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT CASE
    WHEN split_part(_path, '/', 1) = 'library' THEN
      NULLIF(split_part(_path, '/', 2), '') IS NOT NULL
      AND (
        CASE WHEN split_part(_path, '/', 2) = 'all'
          THEN (SELECT auth.uid()) IS NOT NULL
          ELSE public.can_view_location((SELECT auth.uid()), NULLIF(split_part(_path, '/', 2), '')::uuid)
        END
      )
    ELSE EXISTS (
      SELECT 1 FROM public.accounts a
      WHERE a.id = NULLIF(split_part(_path, '/', 1), '')::uuid
        AND (a.created_by = (SELECT auth.uid())
          OR a.assigned_rep = (SELECT auth.uid())
          OR public.can_view_location((SELECT auth.uid()), a.location_id))
    )
  END
$function$;

-- 6. No anonymous execution of project SECURITY DEFINER functions; cron-only
--    routines are removed from the client API surface entirely.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef
      AND p.prorettype <> 'trigger'::regtype
      AND pg_get_userbyid(p.proowner) = 'postgres'
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e'
      )
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon, PUBLIC', r.sig);
  END LOOP;

  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef
      AND p.proname IN (
        'escalate_incidents',
        'expire_stale_dispatches',
        'release_stale_incident_locks',
        'release_expired_claims',
        'run_credential_expiry_alerts'
      )
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon, authenticated, PUBLIC', r.sig);
  END LOOP;
END $$;

-- 7. spatial_ref_sys (PostGIS reference table) is not writable by us; remove it
--    from the client-facing API surface where permissions allow.
DO $$
BEGIN
  EXECUTE 'REVOKE ALL ON TABLE public.spatial_ref_sys FROM anon, authenticated';
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;
