-- Reconcile the inspected Lovable crew-hours schema without modifying business rows.
-- Run this entire migration in one transaction, before replaying 20260902200500.
-- A changed return type requires replacing the RPC; RESTRICT preserves dependents.
-- Any invalid review rows abort instead of inventing decisions or timestamps.
LOCK TABLE public.field_ticket_crew_reviews IN ACCESS EXCLUSIVE MODE;

DO $reconcile$
DECLARE
  rpc_result text;
  expected_result constant text := 'TABLE(ticket_id uuid, work_date date, crew_class text, crew_chief_name text, ticket_headcount integer, ticket_minutes_each integer, headcount integer, minutes_each integer, total_minutes integer, problem text, review_state text, reviewed_at timestamp with time zone, note text, cost numeric, rate_missing boolean, office_minutes integer)';
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.field_ticket_crew_reviews
    WHERE reviewed_at IS NULL
      OR review_state NOT IN ('accepted', 'dismissed')
      OR headcount_override < 0 OR minutes_each_override < 0
  ) THEN
    RAISE EXCEPTION 'Crew review data changed: review invalid rows before reconciliation';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'field_ticket_crew_reviews'
      AND policyname NOT IN (
        'Members of the ticket''s office manage crew reviews',
        'field_ticket_crew_reviews_select', 'field_ticket_crew_reviews_insert',
        'field_ticket_crew_reviews_update', 'field_ticket_crew_reviews_delete'
      )
  ) THEN
    RAISE EXCEPTION 'Unreviewed crew review policy exists; reconcile it explicitly';
  END IF;

  SELECT pg_get_function_result(p.oid) INTO rpc_result
  FROM pg_proc p WHERE p.oid = to_regprocedure('public.job_ticket_crew_hours(uuid)');
  IF rpc_result = expected_result THEN
    DROP FUNCTION public.job_ticket_crew_hours(uuid) RESTRICT;
  ELSIF rpc_result IS DISTINCT FROM replace(expected_result, 'office_minutes integer)', 'office_minutes bigint)') THEN
    RAISE EXCEPTION 'Unexpected job_ticket_crew_hours signature: %', rpc_result;
  END IF;
END
$reconcile$;

ALTER TABLE public.field_ticket_crew_reviews
  ALTER COLUMN review_state DROP DEFAULT,
  ALTER COLUMN reviewed_at SET DEFAULT now(),
  ALTER COLUMN reviewed_at SET NOT NULL,
  DROP CONSTRAINT IF EXISTS field_ticket_crew_reviews_review_state_check,
  ADD CONSTRAINT field_ticket_crew_reviews_review_state_check
    CHECK (review_state IN ('accepted', 'dismissed')),
  DROP CONSTRAINT IF EXISTS field_ticket_crew_reviews_headcount_override_check,
  ADD CONSTRAINT field_ticket_crew_reviews_headcount_override_check
    CHECK (headcount_override IS NULL OR headcount_override >= 0),
  DROP CONSTRAINT IF EXISTS field_ticket_crew_reviews_minutes_each_override_check,
  ADD CONSTRAINT field_ticket_crew_reviews_minutes_each_override_check
    CHECK (minutes_each_override IS NULL OR minutes_each_override >= 0);

DROP POLICY IF EXISTS "Members of the ticket's office manage crew reviews"
  ON public.field_ticket_crew_reviews;
DROP TRIGGER IF EXISTS update_field_ticket_crew_reviews_updated_at
  ON public.field_ticket_crew_reviews;

-- Canonical statements from 20260902200500 follow, including RPC recreation.

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
  UNIQUE (ticket_id, crew_class)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.field_ticket_crew_reviews TO authenticated;
GRANT ALL ON public.field_ticket_crew_reviews TO service_role;
ALTER TABLE public.field_ticket_crew_reviews ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS field_ticket_crew_reviews_select ON public.field_ticket_crew_reviews;
CREATE POLICY field_ticket_crew_reviews_select ON public.field_ticket_crew_reviews
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.field_work_tickets t
    WHERE t.id = ticket_id AND public.can_view_job((SELECT auth.uid()), t.job_id)
  ));

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

-- The security-definer wrapper resolves rates as its owner.
-- Direct callers must not bypass its job visibility and cost permission checks.
REVOKE ALL ON FUNCTION public.crew_rate_for(text, uuid, date) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crew_rate_for(text, uuid, date) TO service_role;
REVOKE ALL ON FUNCTION public.field_ticket_crew_minutes(text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.field_ticket_crew_minutes(text, text) TO authenticated, service_role;
