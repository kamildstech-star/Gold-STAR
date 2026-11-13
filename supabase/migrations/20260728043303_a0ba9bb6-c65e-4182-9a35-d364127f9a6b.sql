-- =========================================================
-- PART 1 — Admin foundation: audit, self-escalation guards, user search
-- =========================================================

-- 1) profiles.is_active + audit column
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS deactivated_at timestamptz,
  ADD COLUMN IF NOT EXISTS deactivated_by uuid;

-- 2) role_change_audit
CREATE TABLE IF NOT EXISTS public.role_change_audit (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_user_id  uuid NOT NULL,
  actor_id        uuid,
  action          text NOT NULL CHECK (action IN (
                    'role_granted','role_revoked',
                    'location_added','location_removed','location_role_changed',
                    'region_added','region_removed',
                    'activated','deactivated'
                  )),
  entity          text,
  old_value       jsonb,
  new_value       jsonb,
  occurred_at     timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.role_change_audit TO authenticated;
GRANT ALL    ON public.role_change_audit TO service_role;

ALTER TABLE public.role_change_audit ENABLE ROW LEVEL SECURITY;

-- Only admin/owner can read the audit trail. No INSERT/UPDATE/DELETE policies:
-- rows are written exclusively by SECURITY DEFINER triggers, and any direct
-- write from the app is rejected.
CREATE POLICY "Admins and owners read audit"
  ON public.role_change_audit FOR SELECT TO authenticated
  USING (public.is_privileged(auth.uid()));

CREATE INDEX IF NOT EXISTS idx_role_audit_target ON public.role_change_audit(target_user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_role_audit_actor  ON public.role_change_audit(actor_id, occurred_at DESC);

-- 3) audit triggers ---------------------------------------------------------

CREATE OR REPLACE FUNCTION public.audit_user_roles()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.role_change_audit(target_user_id, actor_id, action, entity, new_value)
    VALUES (NEW.user_id, auth.uid(), 'role_granted', 'user_roles',
            jsonb_build_object('role', NEW.role));
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO public.role_change_audit(target_user_id, actor_id, action, entity, old_value)
    VALUES (OLD.user_id, auth.uid(), 'role_revoked', 'user_roles',
            jsonb_build_object('role', OLD.role));
    RETURN OLD;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_audit_user_roles ON public.user_roles;
CREATE TRIGGER trg_audit_user_roles
  AFTER INSERT OR DELETE ON public.user_roles
  FOR EACH ROW EXECUTE FUNCTION public.audit_user_roles();

CREATE OR REPLACE FUNCTION public.audit_location_members()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.role_change_audit(target_user_id, actor_id, action, entity, new_value)
    VALUES (NEW.user_id, auth.uid(), 'location_added', 'location_members',
            jsonb_build_object('location_id', NEW.location_id, 'role', NEW.role));
  ELSIF TG_OP = 'UPDATE' AND NEW.role IS DISTINCT FROM OLD.role THEN
    INSERT INTO public.role_change_audit(target_user_id, actor_id, action, entity, old_value, new_value)
    VALUES (NEW.user_id, auth.uid(), 'location_role_changed', 'location_members',
            jsonb_build_object('location_id', OLD.location_id, 'role', OLD.role),
            jsonb_build_object('location_id', NEW.location_id, 'role', NEW.role));
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO public.role_change_audit(target_user_id, actor_id, action, entity, old_value)
    VALUES (OLD.user_id, auth.uid(), 'location_removed', 'location_members',
            jsonb_build_object('location_id', OLD.location_id, 'role', OLD.role));
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

DROP TRIGGER IF EXISTS trg_audit_location_members ON public.location_members;
CREATE TRIGGER trg_audit_location_members
  AFTER INSERT OR UPDATE OR DELETE ON public.location_members
  FOR EACH ROW EXECUTE FUNCTION public.audit_location_members();

CREATE OR REPLACE FUNCTION public.audit_region_members()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.role_change_audit(target_user_id, actor_id, action, entity, new_value)
    VALUES (NEW.user_id, auth.uid(), 'region_added', 'region_members',
            jsonb_build_object('region_id', NEW.region_id));
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO public.role_change_audit(target_user_id, actor_id, action, entity, old_value)
    VALUES (OLD.user_id, auth.uid(), 'region_removed', 'region_members',
            jsonb_build_object('region_id', OLD.region_id));
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

DROP TRIGGER IF EXISTS trg_audit_region_members ON public.region_members;
CREATE TRIGGER trg_audit_region_members
  AFTER INSERT OR DELETE ON public.region_members
  FOR EACH ROW EXECUTE FUNCTION public.audit_region_members();

CREATE OR REPLACE FUNCTION public.audit_profile_active()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.is_active IS DISTINCT FROM OLD.is_active THEN
    INSERT INTO public.role_change_audit(target_user_id, actor_id, action, entity, old_value, new_value)
    VALUES (NEW.user_id, auth.uid(),
            CASE WHEN NEW.is_active THEN 'activated' ELSE 'deactivated' END,
            'profiles',
            jsonb_build_object('is_active', OLD.is_active),
            jsonb_build_object('is_active', NEW.is_active));
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_audit_profile_active ON public.profiles;
CREATE TRIGGER trg_audit_profile_active
  AFTER UPDATE OF is_active ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.audit_profile_active();

-- 4) LOCK DOWN role/membership writes: privileged only, never self ----------

-- user_roles
DROP POLICY IF EXISTS "Admins manage roles" ON public.user_roles;
DROP POLICY IF EXISTS "Users read own role assignments" ON public.user_roles;

CREATE POLICY "Read own roles or all if privileged"
  ON public.user_roles FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_privileged(auth.uid()));

CREATE POLICY "Privileged grant roles to others"
  ON public.user_roles FOR INSERT TO authenticated
  WITH CHECK (public.is_privileged(auth.uid()) AND user_id <> auth.uid());

CREATE POLICY "Privileged revoke roles from others"
  ON public.user_roles FOR DELETE TO authenticated
  USING (public.is_privileged(auth.uid()) AND user_id <> auth.uid());
-- No UPDATE policy: role rows are grant/revoke only.

-- location_members
DROP POLICY IF EXISTS "Admins manage memberships" ON public.location_members;
DROP POLICY IF EXISTS "Members view their office rosters" ON public.location_members;

CREATE POLICY "Read own or privileged all"
  ON public.location_members FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR public.is_member_of(auth.uid(), location_id)
    OR public.is_privileged(auth.uid())
  );

CREATE POLICY "Privileged add memberships (not self)"
  ON public.location_members FOR INSERT TO authenticated
  WITH CHECK (public.is_privileged(auth.uid()) AND user_id <> auth.uid());

CREATE POLICY "Privileged update memberships (not self)"
  ON public.location_members FOR UPDATE TO authenticated
  USING (public.is_privileged(auth.uid()) AND user_id <> auth.uid())
  WITH CHECK (public.is_privileged(auth.uid()) AND user_id <> auth.uid());

CREATE POLICY "Privileged remove memberships (not self)"
  ON public.location_members FOR DELETE TO authenticated
  USING (public.is_privileged(auth.uid()) AND user_id <> auth.uid());

-- region_members
DROP POLICY IF EXISTS "Admins manage region_members" ON public.region_members;
DROP POLICY IF EXISTS "Users view own region memberships" ON public.region_members;

CREATE POLICY "Read own or privileged all regions"
  ON public.region_members FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_privileged(auth.uid()));

CREATE POLICY "Privileged add region memberships (not self)"
  ON public.region_members FOR INSERT TO authenticated
  WITH CHECK (public.is_privileged(auth.uid()) AND user_id <> auth.uid());

CREATE POLICY "Privileged remove region memberships (not self)"
  ON public.region_members FOR DELETE TO authenticated
  USING (public.is_privileged(auth.uid()) AND user_id <> auth.uid());

-- profiles UPDATE: allow privileged users to update ANY profile (for is_active),
-- but forbid privileged users from deactivating themselves.
DROP POLICY IF EXISTS "Users update own profile" ON public.profiles;
CREATE POLICY "Users update own profile"
  ON public.profiles FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid() AND is_active = true);
  -- self-updates cannot toggle is_active to false

CREATE POLICY "Privileged toggle other profiles"
  ON public.profiles FOR UPDATE TO authenticated
  USING (public.is_privileged(auth.uid()) AND user_id <> auth.uid())
  WITH CHECK (public.is_privileged(auth.uid()) AND user_id <> auth.uid());

-- 5) Locations / regions CRUD: only privileged users can write --------------

DROP POLICY IF EXISTS "Anyone can read active locations" ON public.locations;
CREATE POLICY "Read locations"
  ON public.locations FOR SELECT TO authenticated USING (true);

CREATE POLICY "Privileged insert locations"
  ON public.locations FOR INSERT TO authenticated
  WITH CHECK (public.is_privileged(auth.uid()));

CREATE POLICY "Privileged update locations"
  ON public.locations FOR UPDATE TO authenticated
  USING (public.is_privileged(auth.uid()))
  WITH CHECK (public.is_privileged(auth.uid()));

CREATE POLICY "Privileged delete locations"
  ON public.locations FOR DELETE TO authenticated
  USING (public.is_privileged(auth.uid()));

DROP POLICY IF EXISTS "regions_select" ON public.regions;
DROP POLICY IF EXISTS "regions_all" ON public.regions;
CREATE POLICY "Read regions"
  ON public.regions FOR SELECT TO authenticated USING (true);
CREATE POLICY "Privileged manage regions"
  ON public.regions FOR ALL TO authenticated
  USING (public.is_privileged(auth.uid()))
  WITH CHECK (public.is_privileged(auth.uid()));

-- 6) Keep locations.geom in sync when lat/lon are edited from admin UI ------

CREATE OR REPLACE FUNCTION public.set_location_geom()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.lat IS NOT NULL AND NEW.lon IS NOT NULL THEN
    NEW.geom := ST_SetSRID(ST_MakePoint(NEW.lon, NEW.lat), 4326)::geography;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_set_location_geom ON public.locations;
CREATE TRIGGER trg_set_location_geom
  BEFORE INSERT OR UPDATE OF lat, lon ON public.locations
  FOR EACH ROW EXECUTE FUNCTION public.set_location_geom();

-- 7) admin_list_users: single SECURITY DEFINER function returning
--    denormalized rows for the Users screen. Only privileged callers succeed.

CREATE OR REPLACE FUNCTION public.admin_list_users()
RETURNS TABLE (
  user_id uuid,
  full_name text,
  email text,
  is_active boolean,
  roles app_role[],
  location_ids uuid[],
  location_roles text[],
  region_ids uuid[]
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_privileged(auth.uid()) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  RETURN QUERY
  SELECT
    p.user_id,
    p.full_name,
    p.email,
    p.is_active,
    COALESCE((SELECT array_agg(ur.role ORDER BY ur.role) FROM public.user_roles ur WHERE ur.user_id = p.user_id), ARRAY[]::app_role[]) AS roles,
    COALESCE((SELECT array_agg(lm.location_id) FROM public.location_members lm WHERE lm.user_id = p.user_id), ARRAY[]::uuid[]) AS location_ids,
    COALESCE((SELECT array_agg(lm.role::text) FROM public.location_members lm WHERE lm.user_id = p.user_id), ARRAY[]::text[]) AS location_roles,
    COALESCE((SELECT array_agg(rm.region_id) FROM public.region_members rm WHERE rm.user_id = p.user_id), ARRAY[]::uuid[]) AS region_ids
  FROM public.profiles p
  ORDER BY p.full_name NULLS LAST, p.email;
END $$;

REVOKE ALL ON FUNCTION public.admin_list_users() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_list_users() TO authenticated;