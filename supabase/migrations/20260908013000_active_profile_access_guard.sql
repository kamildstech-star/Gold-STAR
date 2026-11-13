-- Prepared only. Apply transactionally after verifying the exact table list,
-- helper definitions/owners and grants in the target. No business rows change.
-- Private schema must not be added to PostgREST's exposed schemas.
CREATE SCHEMA IF NOT EXISTS goldstar_private;
REVOKE ALL ON SCHEMA goldstar_private FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA goldstar_private TO authenticated, service_role;

-- Nonrecursive: postgres owns this lookup and bypasses profiles RLS. It never
-- calls a role/membership helper, so profile/role policies may safely call it.
CREATE OR REPLACE FUNCTION goldstar_private.profile_is_active(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = _user_id AND p.is_active IS TRUE AND p.approval_status = 'approved'
  );
$$;
ALTER FUNCTION goldstar_private.profile_is_active(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION goldstar_private.profile_is_active(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION goldstar_private.profile_is_active(uuid) TO authenticated, service_role;

DO $$
DECLARE table_name text;
BEGIN
  -- Fail instead of installing a potentially recursive profile lookup.
  IF (SELECT relforcerowsecurity FROM pg_catalog.pg_class WHERE oid = 'public.profiles'::regclass) THEN
    RAISE EXCEPTION 'Inspect FORCE RLS on profiles before installing the status helper';
  END IF;
  -- Explicit reviewed allowlist: no discovery loop over arbitrary relations.
  FOREACH table_name IN ARRAY ARRAY[
    'user_roles', 'location_members', 'region_members', 'permissions',
    'role_permissions', 'user_permissions', 'jobs', 'accounts', 'contacts',
    'projects', 'invoices', 'estimates', 'commission_payouts', 'time_entries',
    'shifts', 'company_credentials', 'integration_connections', 'photo_access_log',
    'property_notes', 'time_entry_corrections', 'documents', 'photos',
    'account_notes', 'job_notes', 'tasks', 'conversations', 'messages',
    'assistant_conversations', 'assistant_messages'
  ] LOOP
    -- Missing tables are deployment drift: fail the transaction, never skip.
    EXECUTE pg_catalog.format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE pg_catalog.format('DROP POLICY IF EXISTS active_profile_required ON public.%I', table_name);
    EXECUTE pg_catalog.format(
      'CREATE POLICY active_profile_required ON public.%I AS RESTRICTIVE FOR ALL TO authenticated USING ((SELECT goldstar_private.profile_is_active(auth.uid()))) WITH CHECK ((SELECT goldstar_private.profile_is_active(auth.uid())))', table_name);
    EXECUTE pg_catalog.format('DROP POLICY IF EXISTS anonymous_business_access_denied ON public.%I', table_name);
    EXECUTE pg_catalog.format('CREATE POLICY anonymous_business_access_denied ON public.%I AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false)', table_name);
  END LOOP;
END;
$$;

-- Own profile SELECT remains possible before approval and after deactivation,
-- for the waiting/rejected-account UI. Existing permissive policies still apply.
-- Auth's handle_new_user trigger is definer-owned and continues to bootstrap
-- profiles. Client profile INSERT/UPDATE/DELETE require an active approved user.
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS profile_status_read_guard ON public.profiles;
CREATE POLICY profile_status_read_guard ON public.profiles AS RESTRICTIVE FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) OR (SELECT goldstar_private.profile_is_active(auth.uid())));
DROP POLICY IF EXISTS profile_status_insert_guard ON public.profiles;
CREATE POLICY profile_status_insert_guard ON public.profiles AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK ((SELECT goldstar_private.profile_is_active(auth.uid())));
DROP POLICY IF EXISTS profile_status_update_guard ON public.profiles;
CREATE POLICY profile_status_update_guard ON public.profiles AS RESTRICTIVE FOR UPDATE TO authenticated
  USING ((SELECT goldstar_private.profile_is_active(auth.uid())))
  WITH CHECK ((SELECT goldstar_private.profile_is_active(auth.uid())));
DROP POLICY IF EXISTS profile_status_delete_guard ON public.profiles;
CREATE POLICY profile_status_delete_guard ON public.profiles AS RESTRICTIVE FOR DELETE TO authenticated
  USING ((SELECT goldstar_private.profile_is_active(auth.uid())));
DROP POLICY IF EXISTS anonymous_profile_access_denied ON public.profiles;
CREATE POLICY anonymous_profile_access_denied ON public.profiles AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

-- Storage object metadata and private object downloads follow the same status
-- requirement. Public bucket URLs/signed URLs already issued are not revoked.
DROP POLICY IF EXISTS active_profile_required ON storage.objects;
CREATE POLICY active_profile_required ON storage.objects AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT goldstar_private.profile_is_active(auth.uid())))
  WITH CHECK ((SELECT goldstar_private.profile_is_active(auth.uid())));

-- Central helpers below preserve their audited signatures and expressions;
-- only the subject profile's active/approved requirement is added. Definer
-- callers still need their own caller-identity gate where they accept a user
-- ID from the request. This is not a blanket guarantee for every public RPC.

-- Source: 20260728004107_7c15f81d-0856-43ca-b438-53cd2fe49385.sql
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT goldstar_private.profile_is_active(_user_id) AND (EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = _role
  ));
$$;

-- Source: 20260728004107_7c15f81d-0856-43ca-b438-53cd2fe49385.sql
CREATE OR REPLACE FUNCTION public.is_member_of(_user_id uuid, _location_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT goldstar_private.profile_is_active(_user_id) AND (EXISTS (
    SELECT 1 FROM public.location_members
    WHERE user_id = _user_id AND location_id = _location_id
  ));
$$;

-- Source: 20260728041824_d0c08d30-c532-4395-8041-e722067c23eb.sql
CREATE OR REPLACE FUNCTION public.has_role_text(_user_id uuid, _role text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT goldstar_private.profile_is_active(_user_id) AND (EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role::text = _role));
$$;

-- Source: 20260728041824_d0c08d30-c532-4395-8041-e722067c23eb.sql
CREATE OR REPLACE FUNCTION public.has_any_role_text(_user_id uuid, _roles text[])
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT goldstar_private.profile_is_active(_user_id) AND (EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role::text = ANY(_roles)));
$$;

-- Source: 20260728044917_38538ea6-7964-4570-b33c-1907de42af62.sql
CREATE OR REPLACE FUNCTION public.is_privileged(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT goldstar_private.profile_is_active(_user_id) AND (EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id
      AND role::text IN ('admin', 'owner', 'dev')
  ));
$$;

-- Source: 20260812170505_2b1633c2-754b-4c19-8214-42318b3057de.sql
CREATE OR REPLACE FUNCTION public.is_regional_for(_user_id uuid, _location_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT goldstar_private.profile_is_active(_user_id) AND (_user_id IS NOT NULL AND _location_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.region_members rm
    JOIN public.location_regions lr ON lr.region_id = rm.region_id
    WHERE rm.user_id = _user_id AND lr.location_id = _location_id
  ));
$function$;

-- Source: 20260810223820_db63c2de-4d4b-4c26-bc0c-7e1ef9fafaef.sql
CREATE OR REPLACE FUNCTION public.has_permission(_user_id uuid, _key text, _location_id uuid DEFAULT NULL)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT goldstar_private.profile_is_active(_user_id) AND (-- explicit revoke wins
    NOT EXISTS (
      SELECT 1 FROM public.user_permissions up
      WHERE up.user_id = _user_id
        AND up.permission_key = _key
        AND up.effect = 'revoke'
        AND (up.expires_at IS NULL OR up.expires_at > now())
        AND (
          (up.location_id IS NULL AND up.region_id IS NULL)
          OR (_location_id IS NOT NULL AND up.location_id = _location_id)
          OR (_location_id IS NOT NULL AND up.region_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM public.location_regions lr
                WHERE lr.location_id = _location_id AND lr.region_id = up.region_id))
        )
    )
    AND (
      EXISTS (
        SELECT 1 FROM public.user_roles ur
        JOIN public.role_permissions rp ON rp.role = ur.role
        WHERE ur.user_id = _user_id AND rp.permission_key = _key
      )
      OR EXISTS (
        SELECT 1 FROM public.user_permissions up
        WHERE up.user_id = _user_id
          AND up.permission_key = _key
          AND up.effect = 'grant'
          AND (up.expires_at IS NULL OR up.expires_at > now())
          AND (
            (up.location_id IS NULL AND up.region_id IS NULL)
            OR (_location_id IS NOT NULL AND up.location_id = _location_id)
            OR (_location_id IS NOT NULL AND up.region_id IS NOT NULL AND EXISTS (
                  SELECT 1 FROM public.location_regions lr
                  WHERE lr.location_id = _location_id AND lr.region_id = up.region_id))
          )
      )
    ));
$$;

REVOKE ALL ON FUNCTION public.has_role(uuid, public.app_role) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.is_member_of(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_member_of(uuid, uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.has_role_text(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_role_text(uuid, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.has_any_role_text(uuid, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_any_role_text(uuid, text[]) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.is_privileged(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_privileged(uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.is_regional_for(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_regional_for(uuid, uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.has_permission(uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_permission(uuid, text, uuid) TO authenticated, service_role;
