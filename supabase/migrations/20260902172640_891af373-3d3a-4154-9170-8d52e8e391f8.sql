ALTER TABLE public.job_drying_readings
  ALTER COLUMN dew_point_f DROP NOT NULL,
  ALTER COLUMN grains_per_pound DROP NOT NULL;