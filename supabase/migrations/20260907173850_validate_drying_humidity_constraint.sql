-- The earlier drying migration installed this check as NOT VALID.
-- Validate existing rows without changing values or weakening the constraint.
ALTER TABLE public.job_drying_readings
  VALIDATE CONSTRAINT job_drying_readings_relative_humidity_check;
