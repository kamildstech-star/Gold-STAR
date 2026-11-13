-- `dev` becomes the break-glass role, enforced by the database.
--
-- WHY
-- 20260907190000 made every page a switch for every role, at Mark's request.
-- The cost was that the Access screen could be switched off for everybody with
-- no way back through the app: recovery meant raw SQL against production. The
-- app now short-circuits one role, `dev`, to "allowed" for every page and every
-- capability (src/lib/page-access.ts, rule 0), so there is always a way back.
--
-- This migration makes that a property of the DATABASE and not only a claim the
-- interface makes. Without it, "cannot be changed" would mean "the screen does
-- not offer it", and one DELETE in the SQL editor would quietly remove the only
-- guarantee left.
--
-- HOW — four rules, all of them refusals rather than silent repairs, so that
-- anyone who tries gets told why:
--   1. `dev` holds a role_permissions row for every permission in the
--      catalogue, page and capability alike.
--   2. Those rows cannot be deleted or re-pointed. Any DELETE or UPDATE of a
--      role_permissions row whose role is `dev` raises.
--   3. A new permission automatically gets a `dev` row, so rule 1 stays true
--      for pages and capabilities added later.
--   4. A personal revoke cannot be stored against somebody holding `dev`, and
--      granting `dev` to somebody clears any revoke already sitting on them.
--      A break-glass with a personal exception is not a break-glass.
--
-- What is deliberately NOT locked: taking the `dev` role off a person. That is
-- an ordinary user_roles change and remains the way to withdraw it. Owner and
-- Admin stay ordinary editable roles, and the three former floor pages stay
-- ordinary switches — nothing else is re-locked here.
--
-- Re-runnable: every statement is CREATE OR REPLACE, DROP ... IF EXISTS, or an
-- INSERT ... ON CONFLICT DO NOTHING. Running it twice changes nothing.

BEGIN;

-- 1. ---------------------------------------------------------------------
-- Give `dev` everything in the catalogue. ON CONFLICT DO NOTHING, so an
-- existing row (all 88 of them, today) is left exactly as it is.
INSERT INTO public.role_permissions (role, permission_key)
SELECT 'dev'::public.app_role, p.key
FROM public.permissions p
ON CONFLICT (role, permission_key) DO NOTHING;

-- 2. ---------------------------------------------------------------------
-- The rows cannot be removed or re-pointed.
--
-- SECURITY DEFINER is not needed to raise, but the function is pinned to a
-- fixed search_path so it cannot be steered by a caller's setting.
CREATE OR REPLACE FUNCTION public.protect_break_glass_role_permissions()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.role = 'dev'::public.app_role THEN
      RAISE EXCEPTION
        'dev is the break-glass role: its access cannot be removed (permission_key=%)',
        OLD.permission_key
        USING ERRCODE = '42501',
              HINT = 'Remove the dev role from the person instead (public.user_roles). '
                     'See supabase/ACCESS_RECOVERY.md.';
    END IF;
    RETURN OLD;
  END IF;

  -- UPDATE: moving the row to another role, or pointing it at another
  -- permission, is a deletion wearing a different hat.
  IF OLD.role = 'dev'::public.app_role
     AND (NEW.role IS DISTINCT FROM OLD.role
          OR NEW.permission_key IS DISTINCT FROM OLD.permission_key) THEN
    RAISE EXCEPTION
      'dev is the break-glass role: its access cannot be reassigned (permission_key=%)',
      OLD.permission_key
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_break_glass_role_permissions_trg ON public.role_permissions;
CREATE TRIGGER protect_break_glass_role_permissions_trg
  BEFORE DELETE OR UPDATE ON public.role_permissions
  FOR EACH ROW EXECUTE FUNCTION public.protect_break_glass_role_permissions();

-- 3. ---------------------------------------------------------------------
-- A permission added later — a new page, a new capability — carries `dev` from
-- the moment it exists. This is the database's version of the code rule that
-- `dev` reaches a page the catalogue has never heard of.
CREATE OR REPLACE FUNCTION public.grant_new_permission_to_break_glass()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  INSERT INTO public.role_permissions (role, permission_key)
  VALUES ('dev'::public.app_role, NEW.key)
  ON CONFLICT (role, permission_key) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS grant_new_permission_to_break_glass_trg ON public.permissions;
CREATE TRIGGER grant_new_permission_to_break_glass_trg
  AFTER INSERT ON public.permissions
  FOR EACH ROW EXECUTE FUNCTION public.grant_new_permission_to_break_glass();

-- 4. ---------------------------------------------------------------------
-- No personal revoke on a break-glass holder.
--
-- SECURITY DEFINER because the check reads public.user_roles: under RLS a
-- caller who cannot see the target's roles would otherwise slip a revoke past
-- a check that found no rows.
CREATE OR REPLACE FUNCTION public.protect_break_glass_user_permissions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.effect = 'revoke' AND EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = NEW.user_id AND ur.role = 'dev'::public.app_role
  ) THEN
    RAISE EXCEPTION
      'this person holds dev, the break-glass role: their access cannot be revoked (permission_key=%)',
      NEW.permission_key
      USING ERRCODE = '42501',
            HINT = 'Remove the dev role from them first (public.user_roles).';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_break_glass_user_permissions_trg ON public.user_permissions;
CREATE TRIGGER protect_break_glass_user_permissions_trg
  BEFORE INSERT OR UPDATE ON public.user_permissions
  FOR EACH ROW EXECUTE FUNCTION public.protect_break_glass_user_permissions();

-- The other direction: somebody already carrying a revoke is given `dev`.
-- Clearing the stale revoke is the only outcome consistent with rule 4 — and
-- the existing audit trigger on user_permissions records the deletion, so it is
-- not a silent change.
CREATE OR REPLACE FUNCTION public.clear_revokes_on_break_glass_grant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.role = 'dev'::public.app_role THEN
    DELETE FROM public.user_permissions
    WHERE user_id = NEW.user_id AND effect = 'revoke';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS clear_revokes_on_break_glass_grant_trg ON public.user_roles;
CREATE TRIGGER clear_revokes_on_break_glass_grant_trg
  AFTER INSERT ON public.user_roles
  FOR EACH ROW EXECUTE FUNCTION public.clear_revokes_on_break_glass_grant();

-- Tidy up anything already stored that rule 4 forbids.
DELETE FROM public.user_permissions up
WHERE up.effect = 'revoke'
  AND EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = up.user_id AND ur.role = 'dev'::public.app_role
  );

COMMENT ON FUNCTION public.protect_break_glass_role_permissions() IS
  'dev is the break-glass role: its role_permissions rows cannot be deleted or reassigned.';
COMMENT ON FUNCTION public.protect_break_glass_user_permissions() IS
  'No personal revoke may be stored against a holder of the dev break-glass role.';

COMMIT;
