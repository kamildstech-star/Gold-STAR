-- 1. Add dev to app_role
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'dev';

-- 2. Widen the privileged helper to include dev.
CREATE OR REPLACE FUNCTION public.is_privileged(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id
      AND role::text IN ('admin', 'owner', 'dev')
  )
$$;

-- 3. Staff-account helper: any admin / owner / dev.
CREATE OR REPLACE FUNCTION public.is_staff_account(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id
      AND role::text IN ('admin', 'owner', 'dev')
  )
$$;
REVOKE ALL ON FUNCTION public.is_staff_account(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_staff_account(uuid) TO authenticated;

-- 4. Staff user ID list — used by dashboards to filter aggregated numbers.
CREATE OR REPLACE FUNCTION public.staff_user_ids()
RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT DISTINCT user_id FROM public.user_roles
   WHERE role::text IN ('admin','owner','dev')
$$;
REVOKE ALL ON FUNCTION public.staff_user_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.staff_user_ids() TO authenticated;

-- 5. Real business reps (excludes staff). For future rep-picker dropdowns.
CREATE OR REPLACE FUNCTION public.list_business_reps()
RETURNS TABLE(user_id uuid, full_name text, email text, roles public.app_role[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.user_id,
         p.full_name,
         p.email,
         COALESCE(
           (SELECT array_agg(ur.role ORDER BY ur.role)
              FROM public.user_roles ur
             WHERE ur.user_id = p.user_id),
           ARRAY[]::public.app_role[]
         ) AS roles
    FROM public.profiles p
   WHERE COALESCE(p.is_active, true)
     AND NOT public.is_staff_account(p.user_id)
     AND EXISTS (
       SELECT 1 FROM public.user_roles ur2
        WHERE ur2.user_id = p.user_id
          AND ur2.role::text IN (
            'sales_rep','sales_manager','location_manager','regional',
            'field_chaser','field','crew','office'
          )
     );
$$;
REVOKE ALL ON FUNCTION public.list_business_reps() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_business_reps() TO authenticated;

-- 6. Target-user scope, used by impersonation. Privileged callers only.
CREATE OR REPLACE FUNCTION public.get_user_scope(_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  result jsonb;
BEGIN
  IF NOT public.is_privileged(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  SELECT jsonb_build_object(
    'user_id', _user_id,
    'full_name', p.full_name,
    'email', p.email,
    'is_active', COALESCE(p.is_active, true),
    'roles', COALESCE(
      (SELECT array_agg(role) FROM public.user_roles WHERE user_id = _user_id),
      ARRAY[]::public.app_role[]
    ),
    'location_ids', COALESCE(
      (SELECT array_agg(location_id) FROM public.location_members WHERE user_id = _user_id),
      ARRAY[]::uuid[]
    ),
    'region_ids', COALESCE(
      (SELECT array_agg(region_id) FROM public.region_members WHERE user_id = _user_id),
      ARRAY[]::uuid[]
    )
  ) INTO result
  FROM public.profiles p
  WHERE p.user_id = _user_id;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.get_user_scope(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_user_scope(uuid) TO authenticated;

-- 7. Impersonation audit.
CREATE TABLE public.impersonation_audit (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id       uuid NOT NULL,
  target_user_id uuid,
  preview_role   public.app_role,
  started_at     timestamptz NOT NULL DEFAULT now(),
  ended_at       timestamptz,
  ended_reason   text,
  CHECK (
    (target_user_id IS NOT NULL AND preview_role IS NULL)
    OR (target_user_id IS NULL AND preview_role IS NOT NULL)
  )
);

CREATE UNIQUE INDEX one_open_impersonation_per_actor
  ON public.impersonation_audit(actor_id)
  WHERE ended_at IS NULL;

CREATE INDEX idx_impersonation_actor
  ON public.impersonation_audit(actor_id, started_at DESC);

CREATE INDEX idx_impersonation_target
  ON public.impersonation_audit(target_user_id, started_at DESC);

GRANT SELECT ON public.impersonation_audit TO authenticated;
GRANT ALL ON public.impersonation_audit TO service_role;

ALTER TABLE public.impersonation_audit ENABLE ROW LEVEL SECURITY;

-- Actor sees own history; privileged users see everyone's.
CREATE POLICY "Read own impersonation" ON public.impersonation_audit
  FOR SELECT TO authenticated
  USING (actor_id = auth.uid() OR public.is_privileged(auth.uid()));

-- No client INSERT/UPDATE/DELETE: only server functions write.

-- 8. Server-callable helpers: start / end / read active session.
-- These run as SECURITY DEFINER so they can insert into the audit table
-- without exposing INSERT to the client role.

CREATE OR REPLACE FUNCTION public.start_impersonation(
  _target_user_id uuid,
  _preview_role   public.app_role
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  new_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT public.is_privileged(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF (_target_user_id IS NULL AND _preview_role IS NULL)
     OR (_target_user_id IS NOT NULL AND _preview_role IS NOT NULL) THEN
    RAISE EXCEPTION 'Provide exactly one of target user id or preview role';
  END IF;
  IF _target_user_id IS NOT NULL AND _target_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Cannot impersonate yourself';
  END IF;

  -- Close any existing open session for this actor.
  UPDATE public.impersonation_audit
     SET ended_at = now(), ended_reason = 'replaced'
   WHERE actor_id = auth.uid() AND ended_at IS NULL;

  INSERT INTO public.impersonation_audit(actor_id, target_user_id, preview_role)
  VALUES (auth.uid(), _target_user_id, _preview_role)
  RETURNING id INTO new_id;

  RETURN new_id;
END $$;
REVOKE ALL ON FUNCTION public.start_impersonation(uuid, public.app_role) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.start_impersonation(uuid, public.app_role) TO authenticated;

CREATE OR REPLACE FUNCTION public.end_impersonation()
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  UPDATE public.impersonation_audit
     SET ended_at = now(), ended_reason = 'exit'
   WHERE actor_id = auth.uid() AND ended_at IS NULL;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.end_impersonation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.end_impersonation() TO authenticated;

CREATE OR REPLACE FUNCTION public.get_active_impersonation()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  row_ public.impersonation_audit%ROWTYPE;
  scope jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO row_
    FROM public.impersonation_audit
   WHERE actor_id = auth.uid() AND ended_at IS NULL
   LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF row_.target_user_id IS NOT NULL THEN
    SELECT jsonb_build_object(
      'user_id', row_.target_user_id,
      'full_name', p.full_name,
      'email', p.email,
      'is_active', COALESCE(p.is_active, true),
      'roles', COALESCE(
        (SELECT array_agg(role) FROM public.user_roles WHERE user_id = row_.target_user_id),
        ARRAY[]::public.app_role[]
      ),
      'location_ids', COALESCE(
        (SELECT array_agg(location_id) FROM public.location_members WHERE user_id = row_.target_user_id),
        ARRAY[]::uuid[]
      ),
      'region_ids', COALESCE(
        (SELECT array_agg(region_id) FROM public.region_members WHERE user_id = row_.target_user_id),
        ARRAY[]::uuid[]
      )
    ) INTO scope
      FROM public.profiles p
     WHERE p.user_id = row_.target_user_id;
  ELSE
    scope := NULL;
  END IF;

  RETURN jsonb_build_object(
    'id', row_.id,
    'started_at', row_.started_at,
    'target_user_id', row_.target_user_id,
    'preview_role', row_.preview_role,
    'target_scope', scope
  );
END $$;
REVOKE ALL ON FUNCTION public.get_active_impersonation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_active_impersonation() TO authenticated;