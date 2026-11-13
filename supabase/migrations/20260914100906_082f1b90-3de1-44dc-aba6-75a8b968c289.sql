ALTER TABLE public.role_change_audit DROP CONSTRAINT IF EXISTS role_change_audit_action_check;
ALTER TABLE public.role_change_audit ADD CONSTRAINT role_change_audit_action_check
  CHECK (action = ANY (ARRAY[
    'role_granted','role_revoked','location_added','location_removed','location_role_changed',
    'region_added','region_removed','activated','deactivated',
    'role_permission_added','role_permission_removed','role_permission_changed',
    'user_permission_added','user_permission_removed','user_permission_changed',
    'permission_granted','permission_revoked','permission_changed','permission_removed'
  ]));

CREATE OR REPLACE FUNCTION public.audit_user_permissions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  BEGIN
    IF TG_OP = 'INSERT' THEN
      INSERT INTO public.role_change_audit (target_user_id, actor_id, action, entity, new_value)
      VALUES (NEW.user_id, (select auth.uid()), 'user_permission_added', 'user_permissions', to_jsonb(NEW));
    ELSIF TG_OP = 'UPDATE' THEN
      INSERT INTO public.role_change_audit (target_user_id, actor_id, action, entity, old_value, new_value)
      VALUES (NEW.user_id, (select auth.uid()), 'user_permission_changed', 'user_permissions', to_jsonb(OLD), to_jsonb(NEW));
    ELSE
      INSERT INTO public.role_change_audit (target_user_id, actor_id, action, entity, old_value)
      VALUES (OLD.user_id, (select auth.uid()), 'user_permission_removed', 'user_permissions', to_jsonb(OLD));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'audit_user_permissions: could not record % on user_permissions: %', TG_OP, SQLERRM;
  END;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.audit_user_permissions() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.audit_role_permissions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  BEGIN
    IF TG_OP = 'DELETE' THEN
      INSERT INTO public.role_change_audit (actor_id, action, entity, old_value)
      VALUES ((select auth.uid()), 'role_permission_removed', 'role_permissions', to_jsonb(OLD));
    ELSIF TG_OP = 'UPDATE' THEN
      INSERT INTO public.role_change_audit (actor_id, action, entity, old_value, new_value)
      VALUES ((select auth.uid()), 'role_permission_changed', 'role_permissions', to_jsonb(OLD), to_jsonb(NEW));
    ELSE
      INSERT INTO public.role_change_audit (actor_id, action, entity, new_value)
      VALUES ((select auth.uid()), 'role_permission_added', 'role_permissions', to_jsonb(NEW));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'audit_role_permissions: could not record % on role_permissions: %', TG_OP, SQLERRM;
  END;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.audit_role_permissions() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS audit_user_permissions_trg ON public.user_permissions;
CREATE TRIGGER audit_user_permissions_trg
  AFTER INSERT OR UPDATE OR DELETE ON public.user_permissions
  FOR EACH ROW EXECUTE FUNCTION public.audit_user_permissions();

DROP TRIGGER IF EXISTS audit_role_permissions_trg ON public.role_permissions;
CREATE TRIGGER audit_role_permissions_trg
  AFTER INSERT OR UPDATE OR DELETE ON public.role_permissions
  FOR EACH ROW EXECUTE FUNCTION public.audit_role_permissions();

CREATE INDEX IF NOT EXISTS idx_role_audit_entity_time
  ON public.role_change_audit (entity, occurred_at DESC);