-- Field capture on the Rooms tab: doors & windows, cabinet runs, flooring and
-- a +/- SF adjustment per room, so a crew standing in the room with a tape
-- measure leaves with the takeoffs (floor SF, wall SF, baseboard LF, door
-- slabs, cabinet LF) instead of a sketch on the back of a work order.
--
-- Mark, 6 Oct 2026: "yes build field capture into the rooms tab."
--
-- WRITTEN, NOT APPLIED. Re-runnable. Nothing existing changes meaning: two
-- columns are added to job_rooms with defaults that read as "not recorded",
-- and two new tables hang off job_rooms. Until this runs the Rooms tab hides
-- the new sections and works exactly as before.
--
-- The design came from a standalone "Field Capture" package. What was kept is
-- its room model (openings, cabinet runs, flooring, +/- SF) and its takeoff
-- rules; what was deliberately NOT carried over:
--   * its own fc_jobs / fc_units / fc_rooms hierarchy. Rooms already belong
--     to real jobs (job_rooms), and units are job_rooms.unit;
--   * its owner-only RLS (user_id = auth.uid()). Goldstar shares a job by
--     office, so these tables answer exactly the question job_rooms answers;
--   * its own storage bucket. Room photos go into the job album, filed in the
--     room's folder, where claim packages and report PDFs already look.
--
-- ---------------------------------------------------------------------------
-- 1. job_rooms: flooring and the +/- SF adjustment
-- ---------------------------------------------------------------------------
-- Columns, not a side table. Each is one value per room, read every time the
-- room is read, copied whenever the room's layout is copied, and no more
-- sensitive than the room's name beside it. A 1:1 side table would need its
-- own RLS, its own portal deny, a join on every room read, and a second row to
-- keep in step on every room insert — all to hold two scalars.
--
-- job_rooms carries table-level grants (no per-column ACLs), so the new
-- columns inherit SELECT/INSERT/UPDATE and need no GRANT of their own.
ALTER TABLE public.job_rooms
  ADD COLUMN IF NOT EXISTS flooring text,
  -- Added to (or taken off) length x width for the parts of a room a
  -- rectangle does not describe: the leg of an L, a bay, a bump-out, a
  -- closet folded into the room. Zero, never NULL, so the arithmetic never
  -- has to ask.
  ADD COLUMN IF NOT EXISTS extra_sf numeric NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.job_rooms.flooring IS
  'Floor covering in this room as recorded on site ("LVP (wood-look)", "Carpet", ...). NULL = not recorded.';
COMMENT ON COLUMN public.job_rooms.extra_sf IS
  'Square feet added to (positive) or taken off (negative) length x width for L-shapes and bump-outs.';

-- The composite key the children's foreign keys point at, so an opening or a
-- cabinet run can never claim a room on a different job from the job_id its
-- RLS is evaluated on. id is already the primary key, so this cannot fail on
-- existing data.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.job_rooms'::regclass AND conname = 'job_rooms_id_job_id_key'
  ) THEN
    ALTER TABLE public.job_rooms ADD CONSTRAINT job_rooms_id_job_id_key UNIQUE (id, job_id);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Doors & windows
-- ---------------------------------------------------------------------------
-- Client-generated ids on both new tables, so the offline queue can upsert: a
-- door added in a basement with no signal and its width corrected a minute
-- later drain in order and land as one door.
CREATE TABLE IF NOT EXISTS public.job_room_openings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  room_id uuid NOT NULL,
  -- A pair (bifold/slider) is two door slabs; a cased opening and a window
  -- are recorded, and take wall and baseboard away, but are not doors. The
  -- counting rule lives in src/lib/room-takeoff.ts; the list is held here so
  -- a kind the app does not know cannot be stored.
  kind text NOT NULL CHECK (kind IN (
    'entry_door', 'interior_door', 'closet_single', 'closet_double',
    'pocket_door', 'patio_door', 'cased_opening', 'window'
  )),
  width_in numeric CHECK (width_in IS NULL OR width_in > 0),
  height_in numeric CHECK (height_in IS NULL OR height_in > 0),
  qty integer NOT NULL DEFAULT 1 CHECK (qty > 0),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- CASCADE: a door is part of the room. Unlike a moisture reading it is not
  -- evidence that outlives the room it was in.
  FOREIGN KEY (room_id, job_id) REFERENCES public.job_rooms (id, job_id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- 3. Cabinet runs
-- ---------------------------------------------------------------------------
-- One row per run, measured in feet along the wall — the unit a cabinet
-- takeoff is priced in. (The package stored inches, which made "8.5" typed
-- on a phone mean eight and a half inches.)
CREATE TABLE IF NOT EXISTS public.job_room_cabinets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  room_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('base', 'upper', 'tall', 'vanity')),
  length_ft numeric CHECK (length_ft IS NULL OR length_ft > 0),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (room_id, job_id) REFERENCES public.job_rooms (id, job_id) ON DELETE CASCADE
);

-- Both are read per job (the Rooms tab loads the whole job at once) and
-- cascade per room.
CREATE INDEX IF NOT EXISTS job_room_openings_job_idx ON public.job_room_openings (job_id);
CREATE INDEX IF NOT EXISTS job_room_openings_room_idx ON public.job_room_openings (room_id);
CREATE INDEX IF NOT EXISTS job_room_cabinets_job_idx ON public.job_room_cabinets (job_id);
CREATE INDEX IF NOT EXISTS job_room_cabinets_room_idx ON public.job_room_cabinets (room_id);

COMMENT ON TABLE public.job_room_openings IS
  'Doors, windows and cased openings measured in a job room. Office-scoped exactly like job_rooms.';
COMMENT ON TABLE public.job_room_cabinets IS
  'Cabinet runs (base, upper, tall, vanity) measured in a job room, in linear feet. Office-scoped exactly like job_rooms.';

DROP TRIGGER IF EXISTS job_room_openings_set_updated_at ON public.job_room_openings;
CREATE TRIGGER job_room_openings_set_updated_at
  BEFORE UPDATE ON public.job_room_openings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS job_room_cabinets_set_updated_at ON public.job_room_cabinets;
CREATE TRIGGER job_room_cabinets_set_updated_at
  BEFORE UPDATE ON public.job_room_cabinets
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---------------------------------------------------------------------------
-- 4. Grants and RLS — job_rooms' own, clause for clause
-- ---------------------------------------------------------------------------
-- job_rooms (20260810184457): anyone who can see the job reads its rooms;
-- whoever can manage the job (its office's managers, privileged users, the
-- crew chief) writes them. A door or a cabinet run is part of a room, so it
-- is seen and written by exactly the same people — no wider (the package's
-- per-user rows would have hidden a tech's measurements from the office) and
-- no narrower.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.job_room_openings TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.job_room_cabinets TO authenticated;
GRANT ALL ON public.job_room_openings TO service_role;
GRANT ALL ON public.job_room_cabinets TO service_role;
-- Closed to the signed-out by the default privileges already
-- (20260929120000); said again by name so the file stands on its own.
REVOKE ALL ON public.job_room_openings FROM anon;
REVOKE ALL ON public.job_room_cabinets FROM anon;

ALTER TABLE public.job_room_openings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_room_cabinets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "job_room_openings_select" ON public.job_room_openings;
CREATE POLICY "job_room_openings_select" ON public.job_room_openings
  FOR SELECT TO authenticated USING (public.can_view_job(auth.uid(), job_id));
DROP POLICY IF EXISTS "job_room_openings_insert" ON public.job_room_openings;
CREATE POLICY "job_room_openings_insert" ON public.job_room_openings
  FOR INSERT TO authenticated WITH CHECK (public.can_manage_job(auth.uid(), job_id));
DROP POLICY IF EXISTS "job_room_openings_update" ON public.job_room_openings;
CREATE POLICY "job_room_openings_update" ON public.job_room_openings
  FOR UPDATE TO authenticated USING (public.can_manage_job(auth.uid(), job_id))
  WITH CHECK (public.can_manage_job(auth.uid(), job_id));
DROP POLICY IF EXISTS "job_room_openings_delete" ON public.job_room_openings;
CREATE POLICY "job_room_openings_delete" ON public.job_room_openings
  FOR DELETE TO authenticated USING (public.can_manage_job(auth.uid(), job_id));

DROP POLICY IF EXISTS "job_room_cabinets_select" ON public.job_room_cabinets;
CREATE POLICY "job_room_cabinets_select" ON public.job_room_cabinets
  FOR SELECT TO authenticated USING (public.can_view_job(auth.uid(), job_id));
DROP POLICY IF EXISTS "job_room_cabinets_insert" ON public.job_room_cabinets;
CREATE POLICY "job_room_cabinets_insert" ON public.job_room_cabinets
  FOR INSERT TO authenticated WITH CHECK (public.can_manage_job(auth.uid(), job_id));
DROP POLICY IF EXISTS "job_room_cabinets_update" ON public.job_room_cabinets;
CREATE POLICY "job_room_cabinets_update" ON public.job_room_cabinets
  FOR UPDATE TO authenticated USING (public.can_manage_job(auth.uid(), job_id))
  WITH CHECK (public.can_manage_job(auth.uid(), job_id));
DROP POLICY IF EXISTS "job_room_cabinets_delete" ON public.job_room_cabinets;
CREATE POLICY "job_room_cabinets_delete" ON public.job_room_cabinets
  FOR DELETE TO authenticated USING (public.can_manage_job(auth.uid(), job_id));

-- ---------------------------------------------------------------------------
-- 5. Customers: denied outright
-- ---------------------------------------------------------------------------
-- portal_customer has no table privileges at all (20260928130000), so this is
-- the second lock, not the first — and the live audit
-- (supabase/tests/client-portal-live-audit.sql) fails any RLS table without
-- it. Guarded so the file still runs on a database the portal migrations have
-- not reached yet.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'portal_customer') THEN
    DROP POLICY IF EXISTS portal_customer_denied ON public.job_room_openings;
    CREATE POLICY portal_customer_denied ON public.job_room_openings
      AS RESTRICTIVE FOR ALL TO portal_customer USING (false) WITH CHECK (false);
    DROP POLICY IF EXISTS portal_customer_denied ON public.job_room_cabinets;
    CREATE POLICY portal_customer_denied ON public.job_room_cabinets
      AS RESTRICTIVE FOR ALL TO portal_customer USING (false) WITH CHECK (false);
  END IF;
END $$;
