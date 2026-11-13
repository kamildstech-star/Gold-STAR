-- The 3-day drying clock's audit trail.
--
-- WRITTEN, NOT APPLIED. One new table with RLS and two indexes. Nothing else
-- changes and nothing is dropped. The app works without it: `listDryingResets`
-- in src/lib/drying-reset.ts treats a missing table as "no resets", so the
-- clock still runs from the first equipment placement, the Reset button says
-- it cannot be recorded yet, and every other part of the drying log is
-- untouched.
--
-- David's scope-of-work email, 2 Sep: "Reset 3 days of drying time (new button
-- linked to scanning and alerts)."
--
-- The 72 hours themselves are not stored anywhere — they are counted from the
-- first open placement on the job, which the equipment log already records.
-- What was missing is the RESTART. A crew that swaps in bigger dehumidifiers
-- on day three is starting a fresh 72 hours, and there was no way to say so.
--
-- A ROW HERE IS A STATEMENT SOMEBODY MADE, not a field that moved. That is why
-- it is an append-only log rather than a `drying_started_at` column on jobs: a
-- column would let the window slide with nobody's name on it, and the whole
-- reason David wants the button is that somebody has to own the extra three
-- days a carrier is being billed for. `previous_started_at` is carried on the
-- row so the trail reads without re-deriving what the clock said at the time.
--
-- RLS: readable by anyone who can see the job, insertable by that person as
-- themselves. NOT updatable by anyone, and deletable only by a privileged
-- user — an audit note a crew can edit afterwards is not an audit note. A
-- mistaken reset is corrected by resetting again with a reason, which leaves
-- both statements in the record.

CREATE TABLE IF NOT EXISTS public.job_drying_resets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  -- When the crew pressed it, not when this reached the server: the write goes
  -- through the offline queue and may arrive hours later, from a basement.
  reset_at timestamptz NOT NULL DEFAULT now(),
  reset_by uuid,
  -- What the clock had been running from, for the trail. Null when nothing was
  -- running yet, which is itself worth being able to see.
  previous_started_at timestamptz,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The clock only ever asks one question of this table: the newest reset on a
-- job. Both indexes serve that; the second is for the equipment alerts sweep,
-- which asks it of many jobs at once.
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

-- As yourself, on a job you can see. `reset_by = auth.uid()` is what makes the
-- audit trail mean anything; without it a row could name anybody.
CREATE POLICY "job_drying_resets_insert" ON public.job_drying_resets
  FOR INSERT TO authenticated
  WITH CHECK (reset_by = auth.uid() AND public.can_view_job(auth.uid(), job_id));

-- No UPDATE policy at all, deliberately: with RLS on and no policy, no
-- authenticated role can update a row. See the note above.

CREATE POLICY "job_drying_resets_delete" ON public.job_drying_resets
  FOR DELETE TO authenticated
  USING (public.is_privileged(auth.uid()));

COMMENT ON TABLE public.job_drying_resets IS
  'Append-only log of the 3-day drying window being restarted on a job. Who, when, and what the window had been running from. Never updated.';
