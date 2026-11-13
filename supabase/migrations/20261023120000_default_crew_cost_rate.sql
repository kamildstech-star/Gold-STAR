-- A default crew COST rate of $45/hr (David, 23 Oct: "I'd put $45 as the
-- default cost for now").
--
-- Until now an hour with no cost rate was "uncosted" and counted as $0 in the
-- job's Labor. This adds company-wide rates (every office, no person) at $45
-- for the crew a job's labour is counted from:
--   gsr / temp  — the field work ticket's Gold Star and temp crew boxes
--                 (crew_rate_for)
--   crew, field — a crew member's own time-clock hours (rate_for, by role)
--
-- Data only; no function changes. An office's own rate, or a person's, still
-- wins, and Settings › Cost rates › Labor publishes a new one (effective-
-- dated) whenever they want to change it.
--
-- Idempotent: a subject that already has a company-wide rate is left alone.
-- Effective from 2020-01-01 so jobs already on the books are costed too.

INSERT INTO public.labour_rates (crew_class, location_id, hourly_rate, effective_from, note)
SELECT c, NULL, 45, DATE '2020-01-01', 'Default cost (23 Oct)'
FROM unnest(ARRAY['gsr', 'temp']) AS c
WHERE NOT EXISTS (
  SELECT 1 FROM public.labour_rates lr
  WHERE lr.crew_class = c AND lr.location_id IS NULL AND lr.user_id IS NULL
);

INSERT INTO public.labour_rates (role, location_id, hourly_rate, effective_from, note)
SELECT r::public.app_role, NULL, 45, DATE '2020-01-01', 'Default cost (23 Oct)'
FROM unnest(ARRAY['crew', 'field']) AS r
WHERE NOT EXISTS (
  SELECT 1 FROM public.labour_rates lr
  WHERE lr.role = r::public.app_role AND lr.location_id IS NULL AND lr.user_id IS NULL
    AND lr.crew_class IS NULL
);
