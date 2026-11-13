-- The drying log against Heshy Landau's checklist (IICRC S500), part 2 of 2:
-- FIXED MATERIAL TEST POINTS and their daily moisture readings.
--
-- WRITTEN, NOT APPLIED. Two new tables, RLS on both. Nothing existing is
-- touched. Re-runnable. Run after 20260928160000.
--
-- The air readings (temp / RH / dew point / GPP) prove the ROOM is drying.
-- An audit also wants proof the STRUCTURE is: the same spot on the same
-- drywall, baseboard, subfloor or framing member, read every day with a
-- moisture meter until it reaches the Dry Standard -- the reading taken on the
-- same material in an unaffected area, which is what "dry" means for this
-- building. A point that moves every day proves nothing, so a point is a row
-- of its own and every reading hangs off it.
--
--   job_moisture_points     one fixed spot: room, material, where on it,
--                           and its dry standard (%).
--   job_moisture_readings   one meter reading of one point on one day.
--
-- Client-generated ids on both, so the offline queue can upsert: a point
-- established in a basement with no signal and its first reading taken a
-- minute later drain in order and land as one point with one reading.
--
-- RLS mirrors job_drying_readings exactly (20260901120000): readable and
-- insertable by anyone who can see the job, as themselves; updatable by the
-- author or a job manager; deletable only by a privileged user, because a
-- moisture log with rows quietly removed is worth nothing to an adjuster.
-- Customers (portal_customer) are denied outright, per the portal rule that
-- every new RLS table carries the restrictive deny policy.

CREATE TABLE IF NOT EXISTS public.job_moisture_points (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  -- SET NULL, never CASCADE: deleting a room must not erase the evidence that
  -- the room's materials were dried.
  room_id uuid REFERENCES public.job_rooms(id) ON DELETE SET NULL,
  -- The four structural materials the checklist names, plus a way out for
  -- cabinetry, hardwood, plaster and whatever else a job turns up.
  material text NOT NULL
    CHECK (material IN ('drywall', 'baseboard', 'subfloor', 'framing', 'other')),
  -- Where on it: "north wall, 12 in up, left of the door". Fixed means a
  -- second tech can find it tomorrow, and this is how they do.
  location text,
  -- The unaffected-reference reading for this material, in the meter's own
  -- scale (%). Nullable because the reference is sometimes read after the
  -- point is marked; a point with no standard reads as "no standard yet",
  -- never as dry.
  dry_standard numeric CHECK (dry_standard IS NULL OR dry_standard >= 0),
  -- Material cut out rather than dried (a category 3 loss, a wall opened up).
  -- The point stays, with its readings, and stops being asked for.
  removed_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- The composite key the readings' foreign key points at, so a reading can
  -- never claim a point on a different job from the one its RLS is read on.
  UNIQUE (id, job_id)
);

CREATE TABLE IF NOT EXISTS public.job_moisture_readings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  point_id uuid NOT NULL,
  job_id uuid NOT NULL,
  reading_date date NOT NULL DEFAULT current_date,
  moisture_pct numeric NOT NULL CHECK (moisture_pct >= 0),
  notes text,
  -- When the tech pressed save, not when the phone found signal.
  captured_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (point_id, job_id)
    REFERENCES public.job_moisture_points (id, job_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS job_moisture_points_job_idx
  ON public.job_moisture_points (job_id, created_at);
CREATE INDEX IF NOT EXISTS job_moisture_readings_job_idx
  ON public.job_moisture_readings (job_id, reading_date DESC);
CREATE INDEX IF NOT EXISTS job_moisture_readings_point_idx
  ON public.job_moisture_readings (point_id, reading_date DESC);

COMMENT ON TABLE public.job_moisture_points IS
  'Fixed material moisture test points per IICRC S500: one spot on drywall, baseboard, subfloor or framing, read daily until it meets its dry standard.';
COMMENT ON TABLE public.job_moisture_readings IS
  'Daily moisture-meter reading (%) of one fixed test point.';

DROP TRIGGER IF EXISTS job_moisture_points_set_updated_at ON public.job_moisture_points;
CREATE TRIGGER job_moisture_points_set_updated_at
  BEFORE UPDATE ON public.job_moisture_points
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS job_moisture_readings_set_updated_at ON public.job_moisture_readings;
CREATE TRIGGER job_moisture_readings_set_updated_at
  BEFORE UPDATE ON public.job_moisture_readings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

GRANT SELECT, INSERT, UPDATE, DELETE ON public.job_moisture_points TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.job_moisture_readings TO authenticated;
GRANT ALL ON public.job_moisture_points TO service_role;
GRANT ALL ON public.job_moisture_readings TO service_role;

ALTER TABLE public.job_moisture_points ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_moisture_readings ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Points
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "job_moisture_points_select" ON public.job_moisture_points;
CREATE POLICY "job_moisture_points_select" ON public.job_moisture_points
  FOR SELECT TO authenticated USING (public.can_view_job(auth.uid(), job_id));

DROP POLICY IF EXISTS "job_moisture_points_insert" ON public.job_moisture_points;
CREATE POLICY "job_moisture_points_insert" ON public.job_moisture_points
  FOR INSERT TO authenticated
  WITH CHECK (public.can_view_job(auth.uid(), job_id) AND created_by = auth.uid());

-- The author or a manager may correct a point (its dry standard, where it
-- is, that the material came out). Same bar as a drying reading.
DROP POLICY IF EXISTS "job_moisture_points_update" ON public.job_moisture_points;
CREATE POLICY "job_moisture_points_update" ON public.job_moisture_points
  FOR UPDATE TO authenticated
  USING (created_by = auth.uid() OR public.can_manage_job(auth.uid(), job_id))
  WITH CHECK (created_by = auth.uid() OR public.can_manage_job(auth.uid(), job_id));

DROP POLICY IF EXISTS "job_moisture_points_delete" ON public.job_moisture_points;
CREATE POLICY "job_moisture_points_delete" ON public.job_moisture_points
  FOR DELETE TO authenticated USING (public.is_privileged(auth.uid()));

-- ---------------------------------------------------------------------------
-- Readings
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "job_moisture_readings_select" ON public.job_moisture_readings;
CREATE POLICY "job_moisture_readings_select" ON public.job_moisture_readings
  FOR SELECT TO authenticated USING (public.can_view_job(auth.uid(), job_id));

DROP POLICY IF EXISTS "job_moisture_readings_insert" ON public.job_moisture_readings;
CREATE POLICY "job_moisture_readings_insert" ON public.job_moisture_readings
  FOR INSERT TO authenticated
  WITH CHECK (public.can_view_job(auth.uid(), job_id) AND created_by = auth.uid());

DROP POLICY IF EXISTS "job_moisture_readings_update" ON public.job_moisture_readings;
CREATE POLICY "job_moisture_readings_update" ON public.job_moisture_readings
  FOR UPDATE TO authenticated
  USING (created_by = auth.uid() OR public.can_manage_job(auth.uid(), job_id))
  WITH CHECK (created_by = auth.uid() OR public.can_manage_job(auth.uid(), job_id));

DROP POLICY IF EXISTS "job_moisture_readings_delete" ON public.job_moisture_readings;
CREATE POLICY "job_moisture_readings_delete" ON public.job_moisture_readings
  FOR DELETE TO authenticated USING (public.is_privileged(auth.uid()));

-- ---------------------------------------------------------------------------
-- Customers: denied outright
-- ---------------------------------------------------------------------------
-- portal_customer has no table privileges at all (20260928130000), so this is
-- the second lock, not the first -- and the live audit
-- (supabase/tests/client-portal-live-audit.sql) fails any RLS table without
-- it. Guarded so the file still runs on a database the portal migrations have
-- not reached yet.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'portal_customer') THEN
    DROP POLICY IF EXISTS portal_customer_denied ON public.job_moisture_points;
    CREATE POLICY portal_customer_denied ON public.job_moisture_points
      AS RESTRICTIVE FOR ALL TO portal_customer USING (false) WITH CHECK (false);
    DROP POLICY IF EXISTS portal_customer_denied ON public.job_moisture_readings;
    CREATE POLICY portal_customer_denied ON public.job_moisture_readings
      AS RESTRICTIVE FOR ALL TO portal_customer USING (false) WITH CHECK (false);
  END IF;
END $$;
