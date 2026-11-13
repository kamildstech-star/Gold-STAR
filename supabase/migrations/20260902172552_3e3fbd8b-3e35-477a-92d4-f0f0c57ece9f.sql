CREATE TABLE IF NOT EXISTS public.job_drying_readings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  room_id uuid REFERENCES public.job_rooms(id) ON DELETE SET NULL,
  equipment_id uuid REFERENCES public.equipment(id) ON DELETE SET NULL,
  point text NOT NULL CHECK (point IN ('exterior','unaffected','affected','dehu_outlet')),
  label text,
  reading_date date NOT NULL,
  temperature_f numeric NOT NULL,
  relative_humidity numeric NOT NULL,
  dew_point_f numeric NOT NULL,
  grains_per_pound numeric NOT NULL,
  notes text,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','weather')),
  source_detail text,
  captured_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);

CREATE INDEX IF NOT EXISTS job_drying_readings_job_date_idx
  ON public.job_drying_readings (job_id, reading_date DESC, captured_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.job_drying_readings TO authenticated;
GRANT ALL ON public.job_drying_readings TO service_role;

ALTER TABLE public.job_drying_readings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "drying readings viewable with job"
  ON public.job_drying_readings FOR SELECT TO authenticated
  USING (public.can_view_job(auth.uid(), job_id));

CREATE POLICY "drying readings insert with job"
  ON public.job_drying_readings FOR INSERT TO authenticated
  WITH CHECK (public.can_view_job(auth.uid(), job_id));

CREATE POLICY "drying readings update with job"
  ON public.job_drying_readings FOR UPDATE TO authenticated
  USING (public.can_view_job(auth.uid(), job_id))
  WITH CHECK (public.can_view_job(auth.uid(), job_id));

CREATE POLICY "drying readings delete with job"
  ON public.job_drying_readings FOR DELETE TO authenticated
  USING (public.can_manage_job(auth.uid(), job_id));

ALTER TABLE public.field_work_tickets
  ADD COLUMN IF NOT EXISTS equipment_left_tags text[] NOT NULL DEFAULT '{}';