ALTER TABLE public.intake_requests
  ALTER COLUMN job_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS location_id uuid REFERENCES public.locations(id),
  ADD COLUMN IF NOT EXISTS label text;

ALTER TABLE public.intake_submissions
  ALTER COLUMN job_id DROP NOT NULL;

DROP POLICY IF EXISTS intake_requests_select ON public.intake_requests;
DROP POLICY IF EXISTS intake_requests_write ON public.intake_requests;
DROP POLICY IF EXISTS intake_submissions_select ON public.intake_submissions;
DROP POLICY IF EXISTS intake_submissions_write ON public.intake_submissions;

CREATE POLICY intake_requests_select ON public.intake_requests
  FOR SELECT TO authenticated
  USING (
    (job_id IS NOT NULL AND public.can_view_job((SELECT auth.uid()), job_id))
    OR (job_id IS NULL AND location_id IS NOT NULL AND public.can_view_location((SELECT auth.uid()), location_id))
  );

CREATE POLICY intake_requests_write ON public.intake_requests
  FOR ALL TO authenticated
  USING (
    (job_id IS NOT NULL AND public.can_manage_job((SELECT auth.uid()), job_id))
    OR (job_id IS NULL AND location_id IS NOT NULL AND public.can_view_location((SELECT auth.uid()), location_id))
  )
  WITH CHECK (
    (job_id IS NOT NULL AND public.can_manage_job((SELECT auth.uid()), job_id))
    OR (job_id IS NULL AND location_id IS NOT NULL AND public.can_view_location((SELECT auth.uid()), location_id))
  );

CREATE POLICY intake_submissions_select ON public.intake_submissions
  FOR SELECT TO authenticated
  USING (
    (job_id IS NOT NULL AND public.can_view_job((SELECT auth.uid()), job_id))
    OR (job_id IS NULL AND EXISTS (
      SELECT 1 FROM public.intake_requests r
      WHERE r.id = intake_submissions.request_id
        AND r.location_id IS NOT NULL
        AND public.can_view_location((SELECT auth.uid()), r.location_id)
    ))
  );

CREATE POLICY intake_submissions_write ON public.intake_submissions
  FOR ALL TO authenticated
  USING (
    (job_id IS NOT NULL AND public.can_manage_job((SELECT auth.uid()), job_id))
    OR (job_id IS NULL AND EXISTS (
      SELECT 1 FROM public.intake_requests r
      WHERE r.id = intake_submissions.request_id
        AND r.location_id IS NOT NULL
        AND public.can_view_location((SELECT auth.uid()), r.location_id)
    ))
  )
  WITH CHECK (
    (job_id IS NOT NULL AND public.can_manage_job((SELECT auth.uid()), job_id))
    OR (job_id IS NULL AND EXISTS (
      SELECT 1 FROM public.intake_requests r
      WHERE r.id = intake_submissions.request_id
        AND r.location_id IS NOT NULL
        AND public.can_view_location((SELECT auth.uid()), r.location_id)
    ))
  );