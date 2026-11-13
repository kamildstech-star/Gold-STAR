-- Rep revenue on the Rep's cost card has always been zero. Not because
-- nothing was recorded, but because it was being read from the wrong table.
--
-- director_rep_cost sourced revenue like this:
--
--   select sum(me.amount) from public.money_events me
--    where me.rep_user_id = pe.id
--      and me.event_type = 'payment_received'
--
-- `money_events` is not a revenue ledger. It is a notification feed: inserting
-- a row fires tg_money_event_notify, which tells the rep "the office has
-- logged payment on your job, your commission is being processed". Its own
-- CHECK constraint says so outright, and the table it was declared in carries
-- the comment "the gap is deliberate: a payment_received event NEVER carries
-- an amount":
--
--   CONSTRAINT money_event_amount_rule CHECK (
--     (event_type = 'payment_received' AND amount IS NULL)
--     OR (event_type = 'commission_issued' AND amount IS NOT NULL))
--
-- So that sum was adding a column the database guarantees is null for exactly
-- the rows it selected. It could only ever return nothing. The table being
-- empty hid it; filling the table would not have fixed it.
--
-- Mark, 2026-09-09, asked that payments be recorded when an invoice is marked
-- paid. They already are, and more precisely than that: every payment is a row
-- in invoice_payments carrying its amount and the day it arrived, and it is
-- that rollup which marks the invoice paid in the first place. So revenue is
-- read from the payments themselves.
--
-- Two consequences worth being explicit about.
--
-- Money is counted on the day it arrived rather than the day an invoice
-- finished being paid, so it lands in the period it was actually received.
--
-- Part-payments count. Waiting for an invoice to be fully settled would leave
-- real collected money out of a cost-of-revenue ratio and understate every
-- rep; today that would discard $172,692 sitting against partly-paid
-- invoices. If revenue should only count on full settlement, the filter is one
-- added condition on the invoice's status.
--
-- Attribution follows the account's assigned rep, falling back to whoever
-- raised the invoice. A payment nobody can be credited for is left out rather
-- than assigned to someone arbitrary.

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
        and pay.received_at between _from and _to
    ), 0)::numeric
  from people pe
  where public.has_permission(auth.uid(), 'rep_cost.view')
$$;

REVOKE ALL ON FUNCTION public.director_rep_cost(date, date) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.director_rep_cost(date, date) TO authenticated;
