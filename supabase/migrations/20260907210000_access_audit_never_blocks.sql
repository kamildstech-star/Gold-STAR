-- Access change history: make it actually record, and never let it block.
--
-- Every access change already has a home. role_change_audit receives one row
-- per write to user_roles, role_permissions and user_permissions through
-- SECURITY DEFINER triggers, with actor (auth.uid()), time, the target user,
-- the entity and the before/after row as JSON. Page access is stored in those
-- same two permission tables (a page is a `page.<id>` permission), so page
-- changes are covered by the same triggers with no new table.
--
-- Except that one of the triggers has been broken since 13 August.
--
--   20260810 created audit_user_permissions(), emitting the actions
--            permission_granted / permission_revoked / permission_changed /
--            permission_removed.
--   20260813 replaced role_change_audit's action CHECK with a list that names
--            user_permission_added / user_permission_removed /
--            user_permission_changed instead — and none of the four above.
--
-- An AFTER trigger that violates a CHECK fails the statement that fired it, so
-- EVERY insert, update and delete on user_permissions has failed since then.
-- Production has 0 rows in user_permissions and 0 user_permission_* audit rows;
-- the grant dialog on the user page and the Allow/Block control on the Access
-- screen both die with "violates check constraint". A history mechanism that
-- refuses the change it was meant to record is the wrong way round.
--
-- This migration:
--   1. rewrites audit_user_permissions() to emit the names the CHECK allows;
--   2. wraps the audit INSERT in both permission triggers in an exception
--      block, so if history ever cannot be written again the change still
--      lands and a WARNING goes to the log — never block a change because
--      history could not be written;
--   3. adds the original four names to the CHECK as well, so a row written by
--      the old function (there are none) or a stale schema cache never trips it.
--
-- No column, table or type changes: src/integrations/supabase/types.ts is
-- unchanged. Re-runnable: CREATE OR REPLACE and DROP/ADD CONSTRAINT.

BEGIN;

ALTER TABLE public.role_change_audit DROP CONSTRAINT IF EXISTS role_change_audit_action_check;
ALTER TABLE public.role_change_audit ADD CONSTRAINT role_change_audit_action_check
  CHECK (action = ANY (ARRAY[
    'role_granted','role_revoked','location_added','location_removed','location_role_changed',
    'region_added','region_removed','activated','deactivated',
    'role_permission_added','role_permission_removed','role_permission_changed',
    'user_permission_added','user_permission_removed','user_permission_changed',
    -- names the first trigger emitted; kept so nothing ever trips on them
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
    -- History must never cost the change. Log it and let the write through.
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

-- The triggers already exist (20260810); re-point them so a database that
-- somehow lost one gets it back. DROP/CREATE keeps this re-runnable.
DROP TRIGGER IF EXISTS audit_user_permissions_trg ON public.user_permissions;
CREATE TRIGGER audit_user_permissions_trg
  AFTER INSERT OR UPDATE OR DELETE ON public.user_permissions
  FOR EACH ROW EXECUTE FUNCTION public.audit_user_permissions();

DROP TRIGGER IF EXISTS audit_role_permissions_trg ON public.role_permissions;
CREATE TRIGGER audit_role_permissions_trg
  AFTER INSERT OR UPDATE OR DELETE ON public.role_permissions
  FOR EACH ROW EXECUTE FUNCTION public.audit_role_permissions();

-- The Access screen asks "history for role X", which lives inside the JSON.
CREATE INDEX IF NOT EXISTS idx_role_audit_entity_time
  ON public.role_change_audit (entity, occurred_at DESC);

COMMIT;
