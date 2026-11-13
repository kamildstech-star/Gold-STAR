-- A job's tasks are visible to whoever can see the job.
--
-- David, 22 Sep, on the office side: "the tasks actually don't show up over
-- here. When you go to certain jobs, tasks aren't populating. This I did
-- manually today."
--
-- The tasks SELECT policy (20260804184212) scopes a task by its OWN
-- location_id, and a job by the job's — two columns that can disagree:
--   * the job's office was changed after its tasks were made (the Office badge
--     on the job is editable and nothing follows it onto tasks.location_id);
--   * a task made from the mail sidebar takes the creator's current office,
--     not the job's;
--   * someone sees the job as its crew chief or through a job assignment
--     without being a member of its office.
-- In each case the job opens and its Tasks tab says there are none, which is
-- the one answer that is certainly false.
--
-- The fix widens nothing beyond the job itself: the new clause is exactly
-- can_view_job, the predicate the job's other children (assignments, intake
-- forms) already use. A task with no job keeps the visibility it had.

DROP POLICY IF EXISTS "tasks visible in scope" ON public.tasks;
CREATE POLICY "tasks visible in scope" ON public.tasks FOR SELECT TO authenticated
  USING (
    assignee = (SELECT auth.uid())
    OR created_by = (SELECT auth.uid())
    OR (location_id IS NOT NULL AND public.can_view_location((SELECT auth.uid()), location_id))
    OR (job_id IS NOT NULL AND public.can_view_job((SELECT auth.uid()), job_id))
  );
