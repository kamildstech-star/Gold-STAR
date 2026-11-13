CREATE TABLE IF NOT EXISTS public.job_moisture_points (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  room_id uuid REFERENCES public.job_rooms(id) ON DELETE SET NULL,
  material text NOT NULL
    CHECK (material IN ('drywall', 'baseboard', 'subfloor', 'framing', 'other')),
  location text,
  dry_standard numeric CHECK (dry_standard IS NULL OR dry_standard >= 0),
  removed_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, job_id)
);

CREATE TABLE IF NOT EXISTS public.job_moisture_readings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  point_id uuid NOT NULL,
  job_id uuid NOT NULL,
  reading_date date NOT NULL DEFAULT current_date,
  moisture_pct numeric NOT NULL CHECK (moisture_pct >= 0),
  notes text,
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

DROP POLICY IF EXISTS "job_moisture_points_select" ON public.job_moisture_points;
CREATE POLICY "job_moisture_points_select" ON public.job_moisture_points
  FOR SELECT TO authenticated USING (public.can_view_job(auth.uid(), job_id));

DROP POLICY IF EXISTS "job_moisture_points_insert" ON public.job_moisture_points;
CREATE POLICY "job_moisture_points_insert" ON public.job_moisture_points
  FOR INSERT TO authenticated
  WITH CHECK (public.can_view_job(auth.uid(), job_id) AND created_by = auth.uid());

DROP POLICY IF EXISTS "job_moisture_points_update" ON public.job_moisture_points;
CREATE POLICY "job_moisture_points_update" ON public.job_moisture_points
  FOR UPDATE TO authenticated
  USING (created_by = auth.uid() OR public.can_manage_job(auth.uid(), job_id))
  WITH CHECK (created_by = auth.uid() OR public.can_manage_job(auth.uid(), job_id));

DROP POLICY IF EXISTS "job_moisture_points_delete" ON public.job_moisture_points;
CREATE POLICY "job_moisture_points_delete" ON public.job_moisture_points
  FOR DELETE TO authenticated USING (public.is_privileged(auth.uid()));

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