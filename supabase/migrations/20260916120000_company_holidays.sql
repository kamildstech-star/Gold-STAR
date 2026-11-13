-- Extra office closures for the working-day calendar.
--
-- APPLIED to production on 2026-09-16 and ledgered as 20260916120000; verified live afterwards.
-- The paragraph below was written before it ran and is kept as the record of what
-- was weighed.
--
-- Originally: WRITTEN, NOT APPLIED. One new table with RLS. Nothing else changes and
-- nothing is dropped. The app works without it: `fetchCompanyClosures` in
-- src/lib/working-days.ts treats a missing table as "no extra closures".
--
-- Mark asked for the leaderboard streak to "exclude weekends and jewsih
-- holidays" "as well as federal holidays". Weekends, federal holidays and yom
-- tov are computed in code. This table is for the closures no rule can know:
-- a snow day, a company retreat, an early-close the Sales Head decides to
-- count as a day off. An admin adds a row; no code change, no deploy.
--
-- One row per date. `holiday_date` is a plain date in the office calendar
-- (America/New_York) — it is compared against "2026-09-12"-style day keys in
-- code, so it must never become a timestamp.
--
-- There is no admin screen for this yet; rows are added from the Supabase
-- table editor. That is the seam for a later PR.

CREATE TABLE IF NOT EXISTS public.company_holidays (
  holiday_date date PRIMARY KEY,
  name text NOT NULL,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.company_holidays ENABLE ROW LEVEL SECURITY;

-- Every signed-in user needs the dates: the streak is computed in the browser
-- for everyone on the board. Writing is the same audience that maintains the
-- leaderboard's achievements and challenges.
CREATE POLICY "company_holidays_read" ON public.company_holidays
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "company_holidays_write" ON public.company_holidays
  FOR ALL TO authenticated
  USING (public.is_privileged(auth.uid()) OR public.has_role(auth.uid(), 'sales_head'))
  WITH CHECK (public.is_privileged(auth.uid()) OR public.has_role(auth.uid(), 'sales_head'));

GRANT SELECT ON public.company_holidays TO authenticated;
GRANT ALL ON public.company_holidays TO service_role;
