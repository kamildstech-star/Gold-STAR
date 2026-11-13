-- Named groupings of offices, for choosing an office rather than for access.
--
-- The client wants the Office on an estimate to be picked from a list that is
-- organised by "a grouping that we're gonna set". public.regions already groups
-- offices, but regions are an ACCESS boundary: public.is_regional_for() and the
-- job/document RLS policies read public.location_regions, so putting an office
-- into a region to tidy a dropdown would hand every regional manager of that
-- region the data of that office. Presentation grouping must not be an access
-- grant, so this is its own concept.
--
-- Many-to-many rather than a locations.group_id column, for the same reason the
-- one-to-many locations.region_id had to be replaced by public.location_regions
-- in 20260810193154: an office belongs to a brand AND a territory AND whatever
-- the client invents next, and a single FK forces them to pick one and lose the
-- rest. Unlike location_regions this join deliberately has no trigger writing a
-- "primary" group back onto locations — nothing downstream needs one.

CREATE TABLE IF NOT EXISTS public.location_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  -- The client orders these to taste; alphabetical order buries the group they
  -- pick most often.
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Two groups with the same name are indistinguishable in a picker.
CREATE UNIQUE INDEX IF NOT EXISTS location_groups_name_key
  ON public.location_groups (lower(name));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.location_groups TO authenticated;
GRANT ALL ON public.location_groups TO service_role;
ALTER TABLE public.location_groups ENABLE ROW LEVEL SECURITY;

-- Matches how public.locations and public.regions are already secured: every
-- signed-in user reads them (the picker is used by anyone writing an estimate),
-- only privileged users write them.
DROP POLICY IF EXISTS "location_groups_select" ON public.location_groups;
CREATE POLICY "location_groups_select" ON public.location_groups
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "location_groups_write" ON public.location_groups;
CREATE POLICY "location_groups_write" ON public.location_groups
  FOR ALL TO authenticated
  USING (public.is_privileged((select auth.uid())))
  WITH CHECK (public.is_privileged((select auth.uid())));

-- Live state (2026-09-03): both tables and all four policies already exist in
-- production (Lovable applied them, with an extra created_by column on
-- location_groups that is left alone), but the unique name index and the two
-- member indexes do not, and the updated_at trigger exists under the name
-- location_groups_updated_at. Creating a second one would stamp the same
-- column twice, so this file's trigger is only created where no other one is.
DROP TRIGGER IF EXISTS location_groups_set_updated_at ON public.location_groups;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.location_groups'::regclass
      AND tgname = 'location_groups_updated_at'
  ) THEN
    CREATE TRIGGER location_groups_set_updated_at BEFORE UPDATE ON public.location_groups
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END $$;

-- CASCADE on group_id only: dropping a group drops its memberships, never the
-- offices themselves. An office is a legal entity with an EIN and live jobs.
CREATE TABLE IF NOT EXISTS public.location_group_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES public.location_groups(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (group_id, location_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.location_group_members TO authenticated;
GRANT ALL ON public.location_group_members TO service_role;
ALTER TABLE public.location_group_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "location_group_members_select" ON public.location_group_members;
CREATE POLICY "location_group_members_select" ON public.location_group_members
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "location_group_members_write" ON public.location_group_members;
CREATE POLICY "location_group_members_write" ON public.location_group_members
  FOR ALL TO authenticated
  USING (public.is_privileged((select auth.uid())))
  WITH CHECK (public.is_privileged((select auth.uid())));

CREATE INDEX IF NOT EXISTS location_group_members_group_idx
  ON public.location_group_members (group_id);
CREATE INDEX IF NOT EXISTS location_group_members_location_idx
  ON public.location_group_members (location_id);
