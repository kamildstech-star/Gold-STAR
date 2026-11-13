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