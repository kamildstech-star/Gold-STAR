-- =====================================================================
-- NOT APPLIED. Written from the reports sweep and left for the main session
-- to apply, per the standing rule that agents do not run migrations.
--
-- The last three per-person credits the house-account rule has not reached.
--
-- Mark, 10 Sep 2026, verbatim:
--
--   "House accounts belong to the company rather than a rep."
--
-- 20260912103000 took house accounts out of `scorecard_metrics`,
-- `scorecard_metrics_raw`, `leaderboard_standings`, `person_accounts` and
-- `person_jobs`. It did not reach the two director screens, which credit a rep
-- the same way and were simply not in front of anyone that day:
--
--   * sales_director_reps  — a rep's revenue and jobs won, summed over jobs on
--     accounts where `assigned_rep = pe.id`. A house account with a rep's name
--     on it is money against their goal on the Sales Director dashboard, where
--     it is compared to a target that never contemplated it.
--   * sales_director_rep_deals — the list under that number: the rep's stalled
--     and lost deals. It has to move with the number or the dashboard says one
--     thing and the panel underneath says another, which is the mistake the
--     leaderboard drill-through made.
--   * director_rep_cost — salary and commission against revenue, per rep. Its
--     revenue is `invoice_payments` attributed by
--     `coalesce(acc.assigned_rep, inv.created_by)`, so a house account's
--     collections land on the rep whose name is on it and make their
--     cost-of-revenue look better than the work they did.
--
-- Each function below is its live definition verbatim — sales_director_reps
-- and sales_director_rep_deals from 20260820091756, director_rep_cost from
-- 20260909220000 — plus one `account_is_house_account` condition per
-- rep-attributed scan. Keep them beside those migrations when either changes.
--
-- WHAT IS DELIBERATELY NOT DONE HERE
-- ----------------------------------
-- Nothing office-wide moves. `calls` and `appointments` on the director
-- dashboard count touchpoints by `created_by` — the rep really made those
-- calls, whoever owns the account — and they are untouched. `assigned_rep` is
-- untouched too: somebody still has to be the person who picks up the phone.
-- Only the label decides, never an empty column; about a quarter of the book
-- is unclaimed rather than the company's, and it must keep behaving as it did.
-- =====================================================================

-- ---------------------------------------------------------------------------
-- 1. The Sales Director dashboard's per-rep revenue and jobs won.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sales_director_reps(_from date, _to date)
RETURNS TABLE (
  user_id uuid,
  full_name text,
  location_id uuid,
  revenue numeric,
  calls integer,
  appointments integer,
  jobs_won integer,
  revenue_target numeric,
  calls_target numeric,
  appointments_target numeric,
  jobs_target numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH people AS (
    SELECT DISTINCT ON (p.user_id) p.user_id AS id, p.full_name, lm.location_id
    FROM public.profiles p
    JOIN public.user_roles ur ON ur.user_id = p.user_id
    JOIN public.location_members lm ON lm.user_id = p.user_id
    WHERE ur.role IN ('sales_person','sales_rep','outside_sales_rep','cold_caller','sales_manager','sales_head')
      AND public.can_view_location(auth.uid(), lm.location_id)
      AND coalesce(p.is_active, true)
    ORDER BY p.user_id, lm.location_id
  ),
  goal AS (
    SELECT g.subject_user_id AS uid, g.metric, sum(g.target_value) AS target
    FROM public.goals g
    WHERE g.is_active
      AND g.subject_user_id IS NOT NULL
      AND g.starts_on <= _to
      AND g.ends_on >= _from
    GROUP BY 1, 2
  )
  SELECT pe.id,
         pe.full_name,
         pe.location_id,
         coalesce((
           SELECT sum(coalesce(j.collected_amount, j.billed_amount, j.approved_amount, 0))
           FROM public.jobs j
           JOIN public.accounts a ON a.id = j.account_id
           WHERE a.assigned_rep = pe.id
             AND NOT public.account_is_house_account(a.id)
             AND j.created_at::date BETWEEN _from AND _to
         ), 0)::numeric,
         (SELECT count(*) FROM public.touchpoints t
            WHERE t.created_by = pe.id AND t.type = 'call'
              AND t.occurred_at::date BETWEEN _from AND _to)::integer,
         (SELECT count(*) FROM public.touchpoints t
            WHERE t.created_by = pe.id
              AND t.type IN ('meeting_in_person','meeting_virtual')
              AND coalesce(t.meeting_held, true)
              AND t.occurred_at::date BETWEEN _from AND _to)::integer,
         (SELECT count(*) FROM public.jobs j
            JOIN public.accounts a ON a.id = j.account_id
            WHERE a.assigned_rep = pe.id
              AND NOT public.account_is_house_account(a.id)
              AND j.created_at::date BETWEEN _from AND _to)::integer,
         (SELECT max(target) FROM goal WHERE uid = pe.id AND metric IN ('billed_value','collected_value')),
         (SELECT max(target) FROM goal WHERE uid = pe.id AND metric = 'touchpoints'),
         (SELECT max(target) FROM goal WHERE uid = pe.id AND metric = 'meetings_held'),
         (SELECT max(target) FROM goal WHERE uid = pe.id AND metric IN ('jobs_won','contracts_signed'))
  FROM people pe
  WHERE public.has_permission(auth.uid(), 'sales_director.view');
$$;

GRANT EXECUTE ON FUNCTION public.sales_director_reps(date, date) TO authenticated;


-- ---------------------------------------------------------------------------
-- 2. The list underneath it, so the two cannot disagree.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sales_director_rep_deals(_user_id uuid, _stale_days integer DEFAULT 14)
RETURNS TABLE (
  account_id uuid,
  name text,
  stage text,
  stage_changed_at timestamptz,
  lost_reason text,
  status text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT a.id, a.name, a.stage, a.stage_changed_at, a.lost_reason, a.status::text
  FROM public.accounts a
  WHERE a.assigned_rep = _user_id
    AND NOT public.account_is_house_account(a.id)
    AND a.archived_at IS NULL
    AND public.can_view_location(auth.uid(), a.location_id)
    AND public.has_permission(auth.uid(), 'sales_director.view')
    AND (
      a.lost_reason IS NOT NULL
      OR coalesce(a.stage_changed_at, a.created_at) < now() - make_interval(days => _stale_days)
    )
  ORDER BY coalesce(a.stage_changed_at, a.created_at) ASC
  LIMIT 25;
$$;

GRANT EXECUTE ON FUNCTION public.sales_director_rep_deals(uuid, integer) TO authenticated;


-- ---------------------------------------------------------------------------
-- 3. The Rep cost card's revenue.
--
-- The house condition sits on the account rather than on the coalesce, so it
-- holds for both sides of it: a house account with no rep falls back to
-- `inv.created_by` today, and crediting the person who raised the invoice is
-- the same mistake wearing a different name.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.director_rep_cost(_from date, _to date)
RETURNS TABLE(
  user_id uuid, full_name text,
  salary_cost numeric, commission_paid numeric, revenue numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  with people as (
    select distinct p.user_id as id, p.full_name
    from public.profiles p
    join public.user_roles ur on ur.user_id = p.user_id
    join public.location_members lm on lm.user_id = p.user_id
    where ur.role in ('sales_person','sales_rep','outside_sales_rep','cold_caller','sales_manager','sales_head')
      and public.can_view_location(auth.uid(), lm.location_id)
      and coalesce(p.is_active, true)
  )
  select pe.id, pe.full_name,
    coalesce((
      select sum(
        coalesce(ps.base_salary_annual,0) / 365.0
        * greatest(0, (least(coalesce(ps.effective_to, _to), _to)
                      - greatest(ps.effective_from, _from)) + 1)
      )
      from public.pay_structures ps
      where ps.user_id = pe.id
        and ps.effective_from <= _to
        and coalesce(ps.effective_to, _to) >= _from
    ), 0)::numeric,
    coalesce((
      select sum(cp.amount) from public.commission_payouts cp
      where cp.user_id = pe.id and cp.status = 'paid'
        and cp.issued_on between _from and _to
    ), 0)::numeric,
    coalesce((
      select sum(pay.amount)
      from public.invoice_payments pay
      join public.invoices inv on inv.id = pay.invoice_id
      left join public.accounts acc on acc.id = inv.account_id
      where coalesce(acc.assigned_rep, inv.created_by) = pe.id
        and (acc.id is null or not public.account_is_house_account(acc.id))
        and pay.received_at between _from and _to
    ), 0)::numeric
  from people pe
  where public.has_permission(auth.uid(), 'rep_cost.view')
$$;

REVOKE ALL ON FUNCTION public.director_rep_cost(date, date) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.director_rep_cost(date, date) TO authenticated;
