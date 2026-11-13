-- Distinct (rep, office-day) pairs for the leaderboard streak.
--
-- APPLIED to production on 2026-09-16 and ledgered as 20260916120100; verified live afterwards.
-- The paragraph below was written before it ran and is kept as the record of what
-- was weighed.
--
-- Originally: WRITTEN, NOT APPLIED. One new function, SECURITY INVOKER, so the caller's
-- own RLS on `touchpoints` decides what they see — exactly the rows the old
-- direct select returned. No table, column, policy or trigger change.
--
-- WHY. `fetchStreaks` used to pull sixty days of raw touchpoints, capped at
-- 5,000 rows across every rep, and reduce them in the browser to "which days
-- did this rep log anything". Once the company logs more than the cap in the
-- window, PostgREST silently drops the OLDEST rows and every streak gets
-- shorter for no visible reason. (The server's default max-rows is 1,000, so
-- the effective cap was likely lower still.)
--
-- The streak never needed the rows, only the distinct days. Reps × days in
-- the window is a few hundred pairs however busy the floor is, and grouping is
-- what a database is for. The client keeps the streak WALK — the working-day
-- calendar (weekends, federal holidays, yom tov, company closures) lives in
-- src/lib/working-days.ts and is unit-tested there — and this function keeps
-- the BUCKETING, done in the office time zone: a call logged at 9pm in
-- Brooklyn is Tuesday's call, not Wednesday's, which `occurred_at::date` in
-- UTC gets wrong.
--
-- Until this is applied the client falls back to paging the raw rows, so the
-- streak is correct either way; this makes it one round trip.

CREATE OR REPLACE FUNCTION public.touchpoint_activity_days(
  _since timestamptz,
  _time_zone text DEFAULT 'America/New_York'
)
RETURNS TABLE (created_by uuid, day date)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT t.created_by,
         (t.occurred_at AT TIME ZONE _time_zone)::date AS day
    FROM public.touchpoints t
   WHERE t.created_by IS NOT NULL
     AND t.occurred_at >= _since
   GROUP BY 1, 2
$$;

REVOKE ALL ON FUNCTION public.touchpoint_activity_days(timestamptz, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.touchpoint_activity_days(timestamptz, text) TO authenticated, service_role;
