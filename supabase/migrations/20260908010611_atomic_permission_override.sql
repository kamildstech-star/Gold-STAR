-- Replace every scoped override for one user/key in a single transaction.
-- Invoker rights preserve table RLS and existing audit triggers. The advisory
-- transaction lock serializes concurrent calls even when no override exists.
CREATE OR REPLACE FUNCTION public.replace_user_permission(
  _user_id uuid,
  _key text,
  _effect text,
  _location_id uuid DEFAULT NULL,
  _region_id uuid DEFAULT NULL,
  _expires_at timestamptz DEFAULT NULL,
  _reason text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE result_id uuid;
BEGIN
  IF auth.uid() IS NULL OR public.is_privileged(auth.uid()) IS NOT TRUE THEN
    RAISE EXCEPTION 'Only an owner, admin or developer can replace permissions' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE user_id = auth.uid() AND is_active IS TRUE AND approval_status = 'approved'
  ) THEN
    RAISE EXCEPTION 'Account access is not approved or active' USING ERRCODE = '42501';
  END IF;
  IF _user_id IS NULL OR _key IS NULL OR _effect IS NULL OR _effect NOT IN ('grant', 'revoke') THEN
    RAISE EXCEPTION 'Invalid permission override' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(_user_id::text || ':' || _key, 0));
  DELETE FROM public.user_permissions WHERE user_id = _user_id AND permission_key = _key;
  INSERT INTO public.user_permissions (
    user_id, permission_key, effect, location_id, region_id, expires_at, reason, granted_by
  ) VALUES (
    _user_id, _key, _effect, _location_id, _region_id, _expires_at, _reason, auth.uid()
  ) RETURNING id INTO result_id;
  RETURN result_id;
END;
$$;
REVOKE ALL ON FUNCTION public.replace_user_permission(uuid, text, text, uuid, uuid, timestamptz, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.replace_user_permission(uuid, text, text, uuid, uuid, timestamptz, text)
  TO authenticated;
