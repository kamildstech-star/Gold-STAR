-- The field work ticket feeding the timecard, without overwriting anything.
--
-- WHY THIS IS NOT time_entries
-- ----------------------------
-- time_entries.user_id is NOT NULL and cost resolves through rate_for(user_id,
-- date). Every hour it holds belongs to a named person, and that is correct:
-- it is payroll evidence and an approval trail.
--
-- The ticket records "GSR Crew Size 4", not four names. Deliberately — a crew
-- chief on a wet floor will not enter four people, and a temp has no login to
-- be named by. There is no honest way to put that into time_entries: inventing
-- four person rows fabricates payroll evidence for people who do not exist,
-- and writing one row for one person drops three of the four crew.
--
-- So the ticket's contribution is DERIVED, never stored as hours. There is no
-- hours table here at all. job_ticket_crew_hours() reads the ticket columns
-- live, which gives three properties for free:
--
--   * It cannot overwrite office-entered hours. Those live in time_entries and
--     are never written by this path. The two are shown side by side and the
--     office decides.
--   * Re-saving or editing a ticket cannot duplicate a day. The ticket row is
--     upserted on its own id (the offline queue item id), and one ticket row
--     yields at most one GSR line and one TEMP line, always.
--   * A ticket that lands hours later from the offline queue feeds through the
--     moment its row exists. Nothing has to run at save time.
--
-- The only new state is the office's DECISION about a ticket line, which is
-- what field_ticket_crew_reviews below holds.
--
-- UNAPPLIED as of writing. Requires 20260831190000_field_work_tickets.sql and
-- 20260902200000_labour_rates_crew_class.sql to be applied first.

-- ---------------------------------------------------------------------------
-- Hours from the two time boxes on the paper.
-- ---------------------------------------------------------------------------
--
-- NULL means "this ticket contributes nothing", which is not the same as zero
-- hours and must never be rendered as a zero:
--
--   * either box blank — the crew did not write the times. Unknown, not none.
--   * end at or before start — a typo, or a shift written across midnight. The
--     paper form has ONE date box and no next-day marker, so there is no way to
--     tell which. Assuming midnight-crossing would turn a transposed 17:00-07:00
--     into fourteen billable hours; assuming a typo and silently swapping would
--     invent hours just as freely. Neither is guessed. The line is surfaced to
--     a human as needing correction and contributes nothing until it is fixed.
--
-- Mirrored in TypeScript by ticketCrewMinutes() in src/lib/ticket-crew-hours.ts,
-- which is what runs before this migration lands. The unit tests there lock
-- both to the same rule; change the two together.
--
-- The arguments are TEXT, not time. field_work_tickets.job_start_time and
-- job_end_time are text columns in production ("HH:MM" from the phone's time
-- input; see 20260831190000), and a LANGUAGE sql body is type-checked at
-- CREATE time, so a `time` signature would have made this whole file fail to
-- apply. A value that is not a clock reading parses to NULL — "unknown", the
-- same answer as a blank box — rather than raising and taking the job's whole
-- costing view down with it.
DROP FUNCTION IF EXISTS public.field_ticket_crew_minutes(time, time);
CREATE OR REPLACE FUNCTION public.field_ticket_crew_minutes(_start text, _end text)
RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE
    WHEN _start IS NULL OR _end IS NULL THEN NULL
    WHEN _start !~ '^([01]?\d|2[0-3]):[0-5]\d(:[0-5]\d)?$'
      OR _end   !~ '^([01]?\d|2[0-3]):[0-5]\d(:[0-5]\d)?$' THEN NULL
    WHEN _end::time <= _start::time THEN NULL
    ELSE (EXTRACT(EPOCH FROM (_end::time - _start::time)) / 60)::int
  END
$$;

GRANT EXECUTE ON FUNCTION public.field_ticket_crew_minutes(text, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The office's decision on one ticket line.
-- ---------------------------------------------------------------------------
--
-- A row exists only once somebody has decided. Absence is "proposed" — the
-- ticket is showing what it says and waiting. That keeps the table small and
-- means a ticket landing from the queue needs no row written for it.
--
-- The overrides are how "adjust" works: the ticket's own numbers are never
-- edited, because the ticket is the crew's signed statement of the day and the
-- office correcting a costing figure must not rewrite it. The override sits
-- beside it and both stay readable.
CREATE TABLE IF NOT EXISTS public.field_ticket_crew_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES public.field_work_tickets(id) ON DELETE CASCADE,
  crew_class text NOT NULL CHECK (crew_class IN ('gsr', 'temp')),
  review_state text NOT NULL CHECK (review_state IN ('accepted', 'dismissed')),
  headcount_override integer CHECK (headcount_override IS NULL OR headcount_override >= 0),
  minutes_each_override integer CHECK (minutes_each_override IS NULL OR minutes_each_override >= 0),
  note text,
  reviewed_by uuid,
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- One decision per ticket line. This is what makes accept idempotent: a
  -- second accept updates the same row rather than stacking a second day.
  UNIQUE (ticket_id, crew_class)
  -- No is_demo column, unlike the other recent tables: a review has no
  -- existence apart from its ticket and field_work_tickets has no is_demo
  -- either, so a demo sweep that removes the ticket takes the review with it.
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.field_ticket_crew_reviews TO authenticated;
GRANT ALL ON public.field_ticket_crew_reviews TO service_role;
ALTER TABLE public.field_ticket_crew_reviews ENABLE ROW LEVEL SECURITY;

-- Policies dropped first so this file can be re-run. Lovable has applied
-- schema by hand here before to clear a typecheck failure, and a bare
-- CREATE POLICY would abort the file on "already exists".
--
-- SELECT follows the ticket: the row holds a headcount and a duration and no
-- money, so anyone who can read the ticket can read the decision on it.
DROP POLICY IF EXISTS field_ticket_crew_reviews_select ON public.field_ticket_crew_reviews;
CREATE POLICY field_ticket_crew_reviews_select ON public.field_ticket_crew_reviews
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.field_work_tickets t
    WHERE t.id = ticket_id AND public.can_view_job((SELECT auth.uid()), t.job_id)
  ));

-- Writing is a costing decision, so it takes the job.view_costs audience --
-- deliberately NOT can_manage_job, which includes the job's own crew_chief.
-- The chief files the ticket; the office decides what it costs.
DROP POLICY IF EXISTS field_ticket_crew_reviews_insert ON public.field_ticket_crew_reviews;
CREATE POLICY field_ticket_crew_reviews_insert ON public.field_ticket_crew_reviews
  FOR INSERT TO authenticated
  WITH CHECK (
    reviewed_by = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1 FROM public.field_work_tickets t
      WHERE t.id = ticket_id
        AND public.can_view_job((SELECT auth.uid()), t.job_id)
        AND public.has_permission((SELECT auth.uid()), 'job.view_costs', t.location_id)
    )
  );

DROP POLICY IF EXISTS field_ticket_crew_reviews_update ON public.field_ticket_crew_reviews;
CREATE POLICY field_ticket_crew_reviews_update ON public.field_ticket_crew_reviews
  FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.field_work_tickets t
    WHERE t.id = ticket_id
      AND public.can_view_job((SELECT auth.uid()), t.job_id)
      AND public.has_permission((SELECT auth.uid()), 'job.view_costs', t.location_id)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.field_work_tickets t
    WHERE t.id = ticket_id
      AND public.can_view_job((SELECT auth.uid()), t.job_id)
      AND public.has_permission((SELECT auth.uid()), 'job.view_costs', t.location_id)
  ));

-- Undoing a decision is the same act as making one, so it takes the same
-- audience. Deleting the row returns the line to showing what the ticket says.
DROP POLICY IF EXISTS field_ticket_crew_reviews_delete ON public.field_ticket_crew_reviews;
CREATE POLICY field_ticket_crew_reviews_delete ON public.field_ticket_crew_reviews
  FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.field_work_tickets t
    WHERE t.id = ticket_id
      AND public.can_view_job((SELECT auth.uid()), t.job_id)
      AND public.has_permission((SELECT auth.uid()), 'job.view_costs', t.location_id)
  ));

CREATE INDEX IF NOT EXISTS field_ticket_crew_reviews_ticket_idx
  ON public.field_ticket_crew_reviews (ticket_id);

DROP TRIGGER IF EXISTS field_ticket_crew_reviews_set_updated_at ON public.field_ticket_crew_reviews;
CREATE TRIGGER field_ticket_crew_reviews_set_updated_at
  BEFORE UPDATE ON public.field_ticket_crew_reviews
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- What the tickets on this job say about crew hours, and what it costs.
-- ---------------------------------------------------------------------------
--
-- One row per (ticket, crew class) where that class has a crew size written.
-- GSR and TEMP never merge: they are separate rows carrying separate rates,
-- because they are separate money.
--
-- `problem` is how a ticket contributes nothing without contributing a zero.
-- A problem line still comes back, with total_minutes 0 and no cost, so the
-- office sees "this ticket needs its times fixed" rather than seeing nothing
-- at all and assuming a quiet day.
--
-- `cost` is NULL for anyone without job.view_costs on the job's location. That
-- is the same predicate invoices_select and estimates_select use, so a crew
-- chief calling this RPC directly gets headcounts and hours and no money.
--
-- `office_minutes` is what time_entries already holds for the same job and
-- day. It is returned so the panel can warn before somebody accepts a ticket
-- on top of hours the office already typed. Nothing here writes time_entries.
CREATE OR REPLACE FUNCTION public.job_ticket_crew_hours(_job_id uuid)
RETURNS TABLE (
  ticket_id uuid,
  work_date date,
  crew_class text,
  crew_chief_name text,
  ticket_headcount integer,
  ticket_minutes_each integer,
  headcount integer,
  minutes_each integer,
  total_minutes integer,
  problem text,
  review_state text,
  reviewed_at timestamptz,
  note text,
  cost numeric,
  rate_missing boolean,
  office_minutes bigint
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH lines AS (
    SELECT
      t.id,
      t.job_id,
      t.location_id,
      t.work_date,
      t.crew_chief_name,
      c.crew_class,
      c.crew_size AS ticket_headcount,
      public.field_ticket_crew_minutes(t.job_start_time, t.job_end_time) AS ticket_minutes,
      -- The columns are text, so the comparison goes through the same parser
      -- as the minutes. A value that does not parse as a clock reading is
      -- reported as end_not_after_start: either way a human has to fix the
      -- times before the line can contribute.
      CASE
        WHEN t.job_start_time IS NULL OR t.job_end_time IS NULL THEN 'no_times'
        WHEN public.field_ticket_crew_minutes(t.job_start_time, t.job_end_time) IS NULL
          THEN 'end_not_after_start'
      END AS problem
    FROM public.field_work_tickets t
    CROSS JOIN LATERAL (
      VALUES ('gsr'::text, t.gsr_crew_size), ('temp'::text, t.temp_crew_size)
    ) AS c(crew_class, crew_size)
    WHERE t.job_id = _job_id
      AND c.crew_size IS NOT NULL
      AND c.crew_size > 0
  ),
  decided AS (
    SELECT
      l.*,
      r.review_state,
      r.reviewed_at,
      r.note,
      COALESCE(r.headcount_override, l.ticket_headcount) AS eff_head,
      COALESCE(r.minutes_each_override, l.ticket_minutes) AS eff_min,
      -- COALESCE, not the bare call: a NULL here would make `NOT money` NULL
      -- and let a cost past the gate.
      COALESCE(
        public.has_permission((SELECT auth.uid()), 'job.view_costs', l.location_id),
        false
      ) AS money
    FROM lines l
    LEFT JOIN public.field_ticket_crew_reviews r
      ON r.ticket_id = l.id AND r.crew_class = l.crew_class
  )
  SELECT
    d.id,
    d.work_date,
    d.crew_class,
    d.crew_chief_name,
    d.ticket_headcount,
    d.ticket_minutes,
    d.eff_head,
    d.eff_min,
    COALESCE(d.eff_head * d.eff_min, 0),
    -- An override supplies the missing number, so the line stops being a
    -- problem the moment somebody corrects it.
    CASE WHEN d.eff_min IS NULL THEN d.problem END,
    COALESCE(d.review_state, 'proposed'),
    d.reviewed_at,
    d.note,
    CASE
      WHEN NOT d.money THEN NULL
      WHEN d.eff_min IS NULL THEN NULL
      ELSE ROUND(
        ((d.eff_head * d.eff_min)::numeric / 60)
        * public.crew_rate_for(d.crew_class, d.location_id, d.work_date), 2)
    END,
    d.money
      AND d.eff_min IS NOT NULL
      AND public.crew_rate_for(d.crew_class, d.location_id, d.work_date) IS NULL,
    COALESCE((
      SELECT SUM(te.minutes) FROM public.time_entries te
      WHERE te.job_id = d.job_id
        AND te.work_date = d.work_date
        AND te.status <> 'rejected'
    ), 0)::bigint
  FROM decided d
  WHERE public.can_view_job((SELECT auth.uid()), _job_id)
  ORDER BY d.work_date DESC, d.crew_class
$$;

REVOKE ALL ON FUNCTION public.job_ticket_crew_hours(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.job_ticket_crew_hours(uuid) TO authenticated, service_role;
