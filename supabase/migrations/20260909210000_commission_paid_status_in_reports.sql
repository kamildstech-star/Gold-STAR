-- Commission figures have read zero since 20 August.
--
-- Migration 20260820084608 renamed the payout status 'issued' to 'paid' and
-- narrowed the CHECK constraint to ('pending','approved','paid','void'), so
-- 'issued' is no longer a value any row can hold. It updated the data and the
-- constraint but not the two functions that read them, and both were written
-- to match on the old word. They have matched nothing since.
--
-- What that cost: the Rep's cost card compares salary against commission, and
-- its commission column has been $0 for every rep. A rep's own commission
-- summary has shown $0 paid and no last-paid date, while 5 payouts totalling
-- $5,664 sat in the table marked 'paid'.
--
-- Nothing here changes what the functions mean. Each one now names the status
-- the data actually uses.

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
      select sum(me.amount) from public.money_events me
      where me.rep_user_id = pe.id
        and me.event_type = 'payment_received'
        and me.created_at::date between _from and _to
    ), 0)::numeric
  from people pe
  where public.has_permission(auth.uid(), 'rep_cost.view')
$$;

REVOKE ALL ON FUNCTION public.director_rep_cost(date, date) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.director_rep_cost(date, date) TO authenticated;

CREATE OR REPLACE FUNCTION public.my_commission_summary(_from date, _to date)
RETURNS TABLE(
  salary_paid numeric, commission_paid numeric,
  pending_count integer, last_issued_on date
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  select
    coalesce(sum(amount) filter (where kind = 'salary' and status = 'paid'), 0)::numeric,
    coalesce(sum(amount) filter (where kind = 'commission' and status = 'paid'), 0)::numeric,
    coalesce(count(*) filter (where status = 'pending'), 0)::integer,
    max(issued_on) filter (where status = 'paid')
  from public.commission_payouts
  where user_id = auth.uid()
    and period_start >= _from
    and period_start <= _to;
$$;

REVOKE ALL ON FUNCTION public.my_commission_summary(date, date) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.my_commission_summary(date, date) TO authenticated;
