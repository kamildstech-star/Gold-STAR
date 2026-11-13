-- The drying log against Heshy Landau's checklist (IICRC S500), part 1 of 2:
-- the water CLASS, the dehumidifier INLET reading, and equipment HOUR METERS.
--
-- WRITTEN, NOT APPLIED. Additive only: two columns on jobs/placements, one
-- widened check. Nothing is dropped, no type changes, no data is rewritten.
-- Re-runnable.
--
-- Heshy's 1 Sep email (via David) is the measuring stick an insurance audit is
-- held to. What the log already had: exterior baseline, room readings, temp /
-- RH, dew point, GPP, meter photos, water category. What it did not:
--
--   1. jobs.water_class          S500's evaporation-load class, 1-4, beside
--                                 the existing water_category (1-3). The two
--                                 are different questions: category is how
--                                 dirty the water was, class is how much of it
--                                 there is to evaporate and from what.
--   2. point 'dehu_inlet'        The air going INTO a dehumidifier, the pair
--                                 to the existing 'dehu_outlet'. Inlet GPP
--                                 minus outlet GPP is the grain depression --
--                                 the only number that proves a machine a
--                                 carrier is paying for is pulling water.
--   3. equipment_placements      The machine's hour meter at placement and at
--        .hour_meter_start/_end  pickup. End minus start is operating hours,
--                                 the billing evidence for the rental line.
--
-- The fixed material test points are part 2 (20260928161000), their own
-- tables.
--
-- The app probes for these and holds the new inputs back until they exist,
-- so nothing a tech types today is refused while this file is pending.

-- ---------------------------------------------------------------------------
-- 1. Water class on the job
-- ---------------------------------------------------------------------------
-- Nullable, never defaulted, for the same reason water_category is: a class
-- nobody assessed must read as unassessed. Class 1 is the answer that sizes
-- the fewest dehumidifiers, so a default of 1 would under-equip every job
-- whose class was simply never entered.

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS water_class smallint;

DO $$ BEGIN
  ALTER TABLE public.jobs
    ADD CONSTRAINT jobs_water_class_check
    CHECK (water_class IS NULL OR water_class IN (1, 2, 3, 4)) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.jobs VALIDATE CONSTRAINT jobs_water_class_check;

COMMENT ON COLUMN public.jobs.water_class IS
  'IICRC S500 class of water intrusion (evaporation load): 1 least water / slow evaporation, 2 significant, 3 greatest, 4 specialty drying of bound water in low-evaporation materials. NULL means not assessed -- never assume 1.';

-- ---------------------------------------------------------------------------
-- 2. The dehumidifier inlet point
-- ---------------------------------------------------------------------------
-- Same convergent drop-and-reinstall as 20260904090000, which is the file
-- that last widened this check: every check on the table mentioning point and
-- exterior is dropped, one is installed. equipment_id already exists and
-- already names the machine an outlet reading came off; an inlet reading uses
-- it the same way.

DO $$
DECLARE con text;
BEGIN
  FOR con IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.job_drying_readings'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%point%'
       AND pg_get_constraintdef(oid) ILIKE '%exterior%'
  LOOP
    EXECUTE format('ALTER TABLE public.job_drying_readings DROP CONSTRAINT %I', con);
  END LOOP;
END $$;

DO $$ BEGIN
  ALTER TABLE public.job_drying_readings
    ADD CONSTRAINT job_drying_readings_point_check
    CHECK (point IN ('exterior', 'interior', 'unaffected', 'affected', 'dehu_inlet', 'dehu_outlet'))
    NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.job_drying_readings VALIDATE CONSTRAINT job_drying_readings_point_check;

-- ---------------------------------------------------------------------------
-- 3. Hour meters on a placement
-- ---------------------------------------------------------------------------
-- On the placement rather than the unit: a meter reading is a statement about
-- THIS job's stay -- what the dial said when the machine went in and when it
-- came out. The unit's lifetime hours are the latest end reading; nothing
-- needs a second copy of it.
--
-- numeric, not integer: most meters show tenths. Both nullable -- an air
-- mover has no meter, and a placement made before this migration has neither
-- reading. End >= start is enforced only when both are present; a meter that
-- genuinely rolled over or was replaced is a note on the placement, not a
-- negative number of billed hours.

ALTER TABLE public.equipment_placements
  ADD COLUMN IF NOT EXISTS hour_meter_start numeric,
  ADD COLUMN IF NOT EXISTS hour_meter_end numeric;

DO $$ BEGIN
  ALTER TABLE public.equipment_placements
    ADD CONSTRAINT equipment_placements_hour_meter_check
    CHECK (
      (hour_meter_start IS NULL OR hour_meter_start >= 0)
      AND (hour_meter_end IS NULL OR hour_meter_end >= 0)
      AND (hour_meter_start IS NULL OR hour_meter_end IS NULL OR hour_meter_end >= hour_meter_start)
    ) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.equipment_placements VALIDATE CONSTRAINT equipment_placements_hour_meter_check;

COMMENT ON COLUMN public.equipment_placements.hour_meter_start IS
  'Hour meter reading when the unit was placed on the job. NULL when the unit has no meter or it was not read.';
COMMENT ON COLUMN public.equipment_placements.hour_meter_end IS
  'Hour meter reading at pickup. hour_meter_end - hour_meter_start is the operating hours billed to the carrier.';

-- No policy changes. equipment_placements_update already lets the crew who
-- retrieve a unit write its row, which is the write that carries the end
-- reading; job_drying_readings keeps its four policies unchanged.
