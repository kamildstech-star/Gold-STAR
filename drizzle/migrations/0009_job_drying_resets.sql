CREATE TABLE IF NOT EXISTS public.job_drying_resets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  reset_at timestamptz NOT NULL DEFAULT now(),
  reset_by uuid,
  previous_started_at timestamptz,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS job_drying_resets_by_job
  ON public.job_drying_resets (job_id, reset_at DESC);
CREATE INDEX IF NOT EXISTS job_drying_resets_by_actor
  ON public.job_drying_resets (reset_by, reset_at DESC);

GRANT SELECT, INSERT ON public.job_drying_resets TO authenticated;
GRANT ALL ON public.job_drying_resets TO service_role;

ALTER TABLE public.job_drying_resets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "job_drying_resets_select" ON public.job_drying_resets
  FOR SELECT TO authenticated
  USING (public.can_view_job(auth.uid(), job_id));

CREATE POLICY "job_drying_resets_insert" ON public.job_drying_resets
  FOR INSERT TO authenticated
  WITH CHECK (reset_by = auth.uid() AND public.can_view_job(auth.uid(), job_id));

CREATE POLICY "job_drying_resets_delete" ON public.job_drying_resets
  FOR DELETE TO authenticated
  USING (public.is_privileged(auth.uid()));

COMMENT ON TABLE public.job_drying_resets IS
  'Append-only log of the 3-day drying window being restarted on a job. Who, when, and what the window had been running from. Never updated.';