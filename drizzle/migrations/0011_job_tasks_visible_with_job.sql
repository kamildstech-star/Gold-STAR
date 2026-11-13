DROP POLICY IF EXISTS "tasks visible in scope" ON public.tasks;
CREATE POLICY "tasks visible in scope" ON public.tasks FOR SELECT TO authenticated
  USING (
    assignee = (SELECT auth.uid())
    OR created_by = (SELECT auth.uid())
    OR (location_id IS NOT NULL AND public.can_view_location((SELECT auth.uid()), location_id))
    OR (job_id IS NOT NULL AND public.can_view_job((SELECT auth.uid()), job_id))
  );