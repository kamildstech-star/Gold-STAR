-- The daily drying log: temperature, relative humidity, dew point and grains
-- per pound at the points IICRC S500 requires a water loss to be documented at.
--
-- A carrier can refuse to pay for equipment days that are not documented, so
-- this table IS the evidence. Four measurement points make the argument:
--
--   exterior     the baseline the whole job is judged against
--   unaffected   the control, proving the affected area is genuinely wetter
--   affected     the drying chamber itself, one row per room
--   dehu_outlet  the dehumidifier's discharge, proving the machine works
--
-- Dew point and GPP are stored, not computed on read. They are derived in
-- src/lib/psychrometrics.ts from the two numbers the crew reads off the meter,
-- but the derivation has to be frozen into the row: a log printed for a claim
-- in 2027 must show the figure that was argued in 2026, and a report written
-- in SQL cannot reach the TypeScript.
--
-- `source` is the discriminator that lets one table hold both halves of a real
-- drying log. 'manual' is a crew reading, which is the evidence. 'weather' is
-- the exterior baseline fetched from Open-Meteo by
-- src/routes/api/public/hooks/drying-weather.ts, which nobody has to remember
-- to take. They are never mixed by accident because every read can filter on it.
--
-- Fahrenheit is the canonical unit. Gold Star is a US company and the paper
-- form is in Fahrenheit; there is no second unit column to disagree with.
--
-- RECONCILIATION NOTE (2026-09-03)
-- --------------------------------
-- Never recorded, but the table EXISTS in production in the shape Lovable
-- wrote in 20260902172552: no updated_at, no is_demo, no relative_humidity
-- range check, no daily-weather unique index, no updated_at trigger, and four
-- policies under different names ("drying readings viewable with job" and
-- friends) whose UPDATE branch is can_view_job rather than author-or-manager.
-- The original file would have skipped the CREATE TABLE, then installed an
-- updated_at trigger on a table with no updated_at column — every UPDATE
-- would have failed with 42703.
--
-- So the file now converges: columns are ADD COLUMN IF NOT EXISTS, the RH
-- check is added guarded, the Lovable-named policies are dropped in favour of
-- the four designed here, and the trigger only lands once its column exists.
-- No column is dropped and no type is changed.

CREATE TABLE IF NOT EXISTS public.job_drying_readings (
  -- Client-generated on the phone so the offline queue can upsert on it: a
  -- drain that starts twice updates one row rather than logging one reading
  -- as two.
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  -- SET NULL, never CASCADE: deleting a room must not erase the drying history
  -- that proves the room was dried.
  room_id uuid REFERENCES public.job_rooms(id) ON DELETE SET NULL,

  reading_date date NOT NULL DEFAULT current_date,
  point text NOT NULL CHECK (point IN ('exterior', 'unaffected', 'affected', 'dehu_outlet')),
  -- Free label for a chamber or a machine when the room list does not name it:
  -- "Chamber A", "Dehu #3". Never a substitute for room_id, only a supplement.
  label text,

  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'weather')),
  -- Which service produced a 'weather' row, e.g. 'open-meteo'. NULL on manual
  -- rows, where the crew and their meter are the provenance.
  source_detail text,

  temperature_f numeric NOT NULL,
  -- A meter reads 0 < RH <= 100. Zero has no finite dew point and no meter
  -- reports it, so it is refused here rather than stored and skipped later.
  relative_humidity numeric NOT NULL,
  dew_point_f numeric,
  grains_per_pound numeric,

  -- Which dehumidifier a 'dehu_outlet' reading came off. SET NULL so retiring
  -- a machine does not orphan the readings that evidenced its performance.
  equipment_id uuid REFERENCES public.equipment(id) ON DELETE SET NULL,
  notes text,

  -- When the crew pressed save in the basement, which is not when this reached
  -- the server hours later on the drive out.
  captured_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  is_demo boolean NOT NULL DEFAULT false
);

-- ---------------------------------------------------------------------------
-- Convergence: every column src/lib/drying-log.ts and outside-conditions.ts
-- read or write, added where missing. Production lacks updated_at and is_demo.
-- ---------------------------------------------------------------------------
ALTER TABLE public.job_drying_readings
  ADD COLUMN IF NOT EXISTS room_id uuid REFERENCES public.job_rooms(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reading_date date NOT NULL DEFAULT current_date,
  ADD COLUMN IF NOT EXISTS label text,
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS source_detail text,
  ADD COLUMN IF NOT EXISTS dew_point_f numeric,
  ADD COLUMN IF NOT EXISTS grains_per_pound numeric,
  ADD COLUMN IF NOT EXISTS equipment_id uuid REFERENCES public.equipment(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS captured_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS created_by uuid,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;

-- The RH range check, on whichever database is missing it. NOT VALID so a row
-- that already exists cannot fail the migration; the table is empty in
-- production today, so `VALIDATE CONSTRAINT` afterwards is instant.
DO $$ BEGIN
  ALTER TABLE public.job_drying_readings
    ADD CONSTRAINT job_drying_readings_relative_humidity_check
    CHECK (relative_humidity > 0 AND relative_humidity <= 100) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON TABLE public.job_drying_readings IS
  'Daily psychrometric drying log per IICRC S500. One row per point per day. Fahrenheit is canonical; dew_point_f and grains_per_pound are derived from temperature_f and relative_humidity and frozen at write time.';

GRANT SELECT, INSERT, UPDATE, DELETE ON public.job_drying_readings TO authenticated;
GRANT ALL ON public.job_drying_readings TO service_role;
ALTER TABLE public.job_drying_readings ENABLE ROW LEVEL SECURITY;

-- Lovable's policies for the same table, under its own names. Permissive
-- policies OR together, so leaving them beside the four below would keep the
-- looser UPDATE branch alive. They are replaced, not added to.
DROP POLICY IF EXISTS "drying readings viewable with job" ON public.job_drying_readings;
DROP POLICY IF EXISTS "drying readings insert with job" ON public.job_drying_readings;
DROP POLICY IF EXISTS "drying readings update with job" ON public.job_drying_readings;
DROP POLICY IF EXISTS "drying readings delete with job" ON public.job_drying_readings;

-- Exactly the jobs_select audience via can_view_job, the same helper
-- field_work_tickets uses: privileged users, anyone who can view the job's
-- location, the crew chief, and assigned crew. A reading is never visible to
-- someone who cannot see the job it documents.
--
-- Every policy is dropped first so this file can be re-run.
DROP POLICY IF EXISTS "job_drying_readings_select" ON public.job_drying_readings;
CREATE POLICY "job_drying_readings_select" ON public.job_drying_readings
  FOR SELECT TO authenticated USING (public.can_view_job(auth.uid(), job_id));

-- Anyone who can see the job may log a reading for it: the crew taking the
-- meter round the basement is assigned to the job, not managing it. created_by
-- is pinned to the author, as field_work_tickets_insert pins it. Automatic
-- weather rows carry no author; 20260902190000 adds the insert policy for
-- those.
DROP POLICY IF EXISTS "job_drying_readings_insert" ON public.job_drying_readings;
CREATE POLICY "job_drying_readings_insert" ON public.job_drying_readings
  FOR INSERT TO authenticated
  WITH CHECK (public.can_view_job(auth.uid(), job_id) AND created_by = auth.uid());

DROP POLICY IF EXISTS "job_drying_readings_update" ON public.job_drying_readings;
CREATE POLICY "job_drying_readings_update" ON public.job_drying_readings
  FOR UPDATE TO authenticated
  USING (created_by = auth.uid() OR public.can_manage_job(auth.uid(), job_id))
  WITH CHECK (created_by = auth.uid() OR public.can_manage_job(auth.uid(), job_id));

-- A drying log with rows quietly removed is worth nothing as evidence, so
-- deletion is privileged only — the same bar field_work_tickets sets.
DROP POLICY IF EXISTS "job_drying_readings_delete" ON public.job_drying_readings;
CREATE POLICY "job_drying_readings_delete" ON public.job_drying_readings
  FOR DELETE TO authenticated USING (public.is_privileged(auth.uid()));

-- The historical view's read: every reading on a job, newest day first.
-- Production already has job_drying_readings_job_date_idx on
-- (job_id, reading_date DESC, captured_at DESC), which serves the same read;
-- this one is created only where nothing equivalent exists.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'job_drying_readings'
      AND indexname IN ('job_drying_readings_job_idx', 'job_drying_readings_job_date_idx')
  ) THEN
    CREATE INDEX job_drying_readings_job_idx
      ON public.job_drying_readings (job_id, reading_date DESC);
  END IF;
END $$;

-- The automatic exterior baseline is fetched by a cron job that may run twice,
-- or re-run to backfill days it missed. One weather row per job per day, so a
-- second fetch updates rather than duplicating. Crew readings are deliberately
-- outside this: a crew may legitimately take two exterior readings in a day.
CREATE UNIQUE INDEX IF NOT EXISTS job_drying_readings_daily_weather_uniq
  ON public.job_drying_readings (job_id, reading_date)
  WHERE source = 'weather';

DROP TRIGGER IF EXISTS job_drying_readings_set_updated_at ON public.job_drying_readings;
CREATE TRIGGER job_drying_readings_set_updated_at
  BEFORE UPDATE ON public.job_drying_readings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
