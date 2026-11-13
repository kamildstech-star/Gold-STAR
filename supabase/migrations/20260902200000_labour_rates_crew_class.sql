-- A rate for a crew class, not only for a person.
--
-- labour_rates today can only answer "what does THIS user_id cost" or "what
-- does anyone holding THIS app_role cost". Both resolve through a named
-- person: rate_for() takes a user_id and joins user_roles.
--
-- The field work ticket does not have people. It has two boxes — GSR Crew Size
-- and TEMP Crew Size — and those are two different costs. Gold Star's own crew
-- is payroll; a hired temp is an agency invoice at a different number. The
-- paper form has kept them in separate boxes for exactly that reason, and a
-- feed that added 4 and 2 into "6 crew" would destroy the only place that
-- distinction is recorded.
--
-- 'temp' is also not expressible as an app_role: a temp has no login, so no
-- user_roles row, so the role branch of rate_for() can never reach them.
--
-- Hence a third subject on the same effective-dated table rather than a second
-- rates table. Effective dating, supersede-don't-edit and the manager-only
-- SELECT policy all keep working unchanged.
--
-- UNAPPLIED as of writing. Apply before 20260902200500_field_ticket_crew_hours.sql.

ALTER TABLE public.labour_rates
  ADD COLUMN IF NOT EXISTS crew_class text;

DO $$ BEGIN
  ALTER TABLE public.labour_rates
    ADD CONSTRAINT labour_rates_crew_class_valid
    CHECK (crew_class IS NULL OR crew_class IN ('gsr', 'temp'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The existing constraint demanded a user_id or a role. A crew-class rate has
-- neither and is still a real subject, so it joins the list rather than
-- loosening the rule to "anything goes".
ALTER TABLE public.labour_rates DROP CONSTRAINT IF EXISTS labour_rate_subject;
ALTER TABLE public.labour_rates
  ADD CONSTRAINT labour_rate_subject
  CHECK (user_id IS NOT NULL OR role IS NOT NULL OR crew_class IS NOT NULL);

COMMENT ON COLUMN public.labour_rates.crew_class IS
  'Rate for unnamed crew counted on a field work ticket: gsr = Gold Star payroll crew, temp = hired temp. Never merged with the role/user rates — they are different money.';

CREATE INDEX IF NOT EXISTS labour_rates_crew_class_idx
  ON public.labour_rates (crew_class, location_id, effective_from DESC)
  WHERE crew_class IS NOT NULL;

-- The rate that applied on the day the work happened, for a crew class.
--
-- Returns NULL when nobody has set one, and the caller must show that as
-- "no rate configured" rather than as $0. A headcount costed at zero reads as
-- free labour and would quietly inflate every margin it touched.
--
-- A rate set for the location beats the org-wide default; that is the same
-- precedence rate_for() gives a per-person rate over a per-role one.
CREATE OR REPLACE FUNCTION public.crew_rate_for(
  _crew_class text,
  _location_id uuid,
  _on date
)
RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT rate FROM (
    SELECT lr.hourly_rate AS rate, 1 AS pref, lr.effective_from
    FROM public.labour_rates lr
    WHERE lr.crew_class = _crew_class
      AND lr.location_id = _location_id
      AND lr.effective_from <= _on
      AND (lr.effective_to IS NULL OR lr.effective_to >= _on)
    UNION ALL
    SELECT lr.hourly_rate, 2, lr.effective_from
    FROM public.labour_rates lr
    WHERE lr.crew_class = _crew_class
      AND lr.location_id IS NULL
      AND lr.effective_from <= _on
      AND (lr.effective_to IS NULL OR lr.effective_to >= _on)
  ) c
  ORDER BY pref, effective_from DESC
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION public.crew_rate_for(text, uuid, date) FROM public, anon;
-- Not granted to authenticated: this returns money and would hand a crew chief
-- a rate. Only job_ticket_crew_hours() calls it, and that checks
-- job.view_costs before letting a number out.
GRANT EXECUTE ON FUNCTION public.crew_rate_for(text, uuid, date) TO service_role;
