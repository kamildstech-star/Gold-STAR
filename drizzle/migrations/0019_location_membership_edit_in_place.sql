GRANT UPDATE ON public.location_members TO authenticated;

CREATE OR REPLACE FUNCTION public.audit_location_members()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  BEGIN
    IF TG_OP = 'INSERT' THEN
      INSERT INTO public.role_change_audit(target_user_id, actor_id, action, entity, new_value)
      VALUES (NEW.user_id, (SELECT auth.uid()), 'location_added', 'location_members',
              jsonb_build_object('location_id', NEW.location_id, 'role', NEW.role));
    ELSIF TG_OP = 'UPDATE' AND NEW.location_id IS DISTINCT FROM OLD.location_id THEN
      INSERT INTO public.role_change_audit(target_user_id, actor_id, action, entity, old_value)
      VALUES (OLD.user_id, (SELECT auth.uid()), 'location_removed', 'location_members',
              jsonb_build_object('location_id', OLD.location_id, 'role', OLD.role));
      INSERT INTO public.role_change_audit(target_user_id, actor_id, action, entity, new_value)
      VALUES (NEW.user_id, (SELECT auth.uid()), 'location_added', 'location_members',
              jsonb_build_object('location_id', NEW.location_id, 'role', NEW.role));
    ELSIF TG_OP = 'UPDATE' AND NEW.role IS DISTINCT FROM OLD.role THEN
      INSERT INTO public.role_change_audit(target_user_id, actor_id, action, entity, old_value, new_value)
      VALUES (NEW.user_id, (SELECT auth.uid()), 'location_role_changed', 'location_members',
              jsonb_build_object('location_id', OLD.location_id, 'role', OLD.role),
              jsonb_build_object('location_id', NEW.location_id, 'role', NEW.role));
    ELSIF TG_OP = 'DELETE' THEN
      INSERT INTO public.role_change_audit(target_user_id, actor_id, action, entity, old_value)
      VALUES (OLD.user_id, (SELECT auth.uid()), 'location_removed', 'location_members',
              jsonb_build_object('location_id', OLD.location_id, 'role', OLD.role));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'audit_location_members: could not record % on location_members: %', TG_OP, SQLERRM;
  END;
  RETURN COALESCE(NEW, OLD);
END $$;
REVOKE EXECUTE ON FUNCTION public.audit_location_members() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.tg_location_member_moved_primary()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.location_id IS DISTINCT FROM OLD.location_id THEN
    UPDATE public.profiles p
       SET primary_location_id = NEW.location_id
     WHERE p.user_id = NEW.user_id
       AND (p.primary_location_id = OLD.location_id OR p.primary_location_id IS NULL);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.tg_location_member_moved_primary() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS location_member_moved_primary ON public.location_members;
CREATE TRIGGER location_member_moved_primary
  AFTER UPDATE OF location_id ON public.location_members
  FOR EACH ROW EXECUTE FUNCTION public.tg_location_member_moved_primary();