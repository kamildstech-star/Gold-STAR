-- One primary office per user.
--
-- A user can belong to several offices (location_members) and to regions on
-- top of that, but nothing said which office is *theirs*. Every "default
-- location" in the app fell back to the first membership row the database
-- happened to return, so a Jersey rep who was also added to Baltimore got
-- Baltimore pre-filled on every new job and account.
--
-- The primary is the office that pre-fills forms. It never restricts what the
-- user can see or write — that stays with memberships and regions.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS primary_location_id uuid REFERENCES public.locations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS profiles_primary_location_idx
  ON public.profiles(primary_location_id) WHERE primary_location_id IS NOT NULL;

-- Backfill: the office a user was added to first is the best guess we have.
-- Only rows with no primary are touched, so re-running never overrides a
-- choice an admin made later.
UPDATE public.profiles p
   SET primary_location_id = m.location_id
  FROM (
    SELECT DISTINCT ON (user_id) user_id, location_id
      FROM public.location_members
     ORDER BY user_id, created_at, location_id
  ) m
 WHERE m.user_id = p.user_id
   AND p.primary_location_id IS NULL;

-- A primary must be an office the user is actually a member of. When the
-- membership goes, the primary follows it — to the next membership if there
-- is one, otherwise to NULL — so a form never defaults to an office RLS
-- would reject.
CREATE OR REPLACE FUNCTION public.tg_location_member_deleted_reset_primary()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.profiles p
     SET primary_location_id = (
       SELECT m.location_id
         FROM public.location_members m
        WHERE m.user_id = OLD.user_id
          AND m.location_id <> OLD.location_id
        ORDER BY m.created_at, m.location_id
        LIMIT 1
     )
   WHERE p.user_id = OLD.user_id
     AND p.primary_location_id = OLD.location_id;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS location_member_deleted_reset_primary ON public.location_members;
CREATE TRIGGER location_member_deleted_reset_primary
  AFTER DELETE ON public.location_members
  FOR EACH ROW EXECUTE FUNCTION public.tg_location_member_deleted_reset_primary();

-- The first membership a user gets becomes their primary automatically, so a
-- newly invited user with one office never sits with a NULL primary.
CREATE OR REPLACE FUNCTION public.tg_location_member_added_set_primary()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.profiles p
     SET primary_location_id = NEW.location_id
   WHERE p.user_id = NEW.user_id
     AND p.primary_location_id IS NULL;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS location_member_added_set_primary ON public.location_members;
CREATE TRIGGER location_member_added_set_primary
  AFTER INSERT ON public.location_members
  FOR EACH ROW EXECUTE FUNCTION public.tg_location_member_added_set_primary();
