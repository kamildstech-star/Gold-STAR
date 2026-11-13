
alter table public.role_change_audit drop constraint if exists role_change_audit_action_check;
alter table public.role_change_audit add constraint role_change_audit_action_check
  check (action = any (array[
    'role_granted','role_revoked','location_added','location_removed','location_role_changed',
    'region_added','region_removed','activated','deactivated',
    'role_permission_added','role_permission_removed',
    'user_permission_added','user_permission_removed','user_permission_changed'
  ]));

insert into public.permissions (key,label,perm_group,description,sort_order) values
  ('director.view','View director dashboard','Reporting','Team-wide KPI, task and goal roll-up',115),
  ('rep_cost.view','View rep cost','Money','Salary and commission cost per rep against revenue',65),
  ('affiliates.manage','Manage affiliate reps','Sales','Track outside/affiliate salespeople and what they are owed',75)
on conflict (key) do nothing;

insert into public.role_permissions (role, permission_key)
select r.role, k.key
from (values ('owner'::app_role),('sales_head'::app_role),('admin'::app_role),('dev'::app_role)) r(role),
     (values ('director.view'),('rep_cost.view'),('affiliates.manage')) k(key)
on conflict do nothing;

create table if not exists public.affiliate_reps (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  company text,
  email text,
  phone text,
  location_id uuid references public.locations(id) on delete set null,
  payout_terms text,
  commission_rate numeric,
  status text not null default 'active',
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  is_demo boolean not null default false
);

create table if not exists public.affiliate_referrals (
  id uuid primary key default gen_random_uuid(),
  affiliate_id uuid not null references public.affiliate_reps(id) on delete cascade,
  account_id uuid references public.accounts(id) on delete set null,
  job_id uuid references public.jobs(id) on delete set null,
  description text,
  referred_on date not null default current_date,
  amount_owed numeric,
  paid_on date,
  status text not null default 'pending',
  note text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  is_demo boolean not null default false
);

create index if not exists affiliate_referrals_affiliate_idx on public.affiliate_referrals(affiliate_id);

grant select, insert, update, delete on public.affiliate_reps to authenticated;
grant all on public.affiliate_reps to service_role;
grant select, insert, update, delete on public.affiliate_referrals to authenticated;
grant all on public.affiliate_referrals to service_role;

alter table public.affiliate_reps enable row level security;
alter table public.affiliate_referrals enable row level security;

create policy affiliate_reps_select on public.affiliate_reps for select to authenticated
  using (public.has_permission(auth.uid(),'affiliates.manage'));
create policy affiliate_reps_write on public.affiliate_reps for all to authenticated
  using (public.has_permission(auth.uid(),'affiliates.manage'))
  with check (public.has_permission(auth.uid(),'affiliates.manage'));

create policy affiliate_referrals_select on public.affiliate_referrals for select to authenticated
  using (public.has_permission(auth.uid(),'affiliates.manage'));
create policy affiliate_referrals_write on public.affiliate_referrals for all to authenticated
  using (public.has_permission(auth.uid(),'affiliates.manage'))
  with check (public.has_permission(auth.uid(),'affiliates.manage'));

create trigger affiliate_reps_updated_at before update on public.affiliate_reps
  for each row execute function public.update_updated_at_column();
create trigger affiliate_referrals_updated_at before update on public.affiliate_referrals
  for each row execute function public.update_updated_at_column();

create or replace function public.director_rep_kpis(_from timestamptz, _to timestamptz)
returns table(
  user_id uuid, full_name text,
  jobs_signed_insurance bigint, jobs_signed_cash bigint,
  calls_made bigint, stage_advances bigint, meetings_held bigint,
  proposals_sent bigint, accounts_closed bigint, accounts_touched bigint
)
language sql
stable
security definer
set search_path to 'public'
as $$
  select m.user_id, m.full_name, m.jobs_signed_insurance, m.jobs_signed_cash,
         m.calls_made, m.stage_advances, m.meetings_held, m.proposals_sent,
         m.accounts_closed,
         (select count(distinct t.account_id) from public.touchpoints t
            where t.created_by = m.user_id and t.account_id is not null
              and t.occurred_at >= _from and t.occurred_at <= _to)
  from public.sales_rep_metrics(_from, _to) m
  where public.has_permission(auth.uid(), 'director.view')
$$;

create or replace function public.director_rep_cost(_from date, _to date)
returns table(
  user_id uuid, full_name text,
  salary_cost numeric, commission_paid numeric, revenue numeric
)
language sql
stable
security definer
set search_path to 'public'
as $$
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
      where cp.user_id = pe.id and cp.status = 'issued'
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

revoke all on function public.director_rep_kpis(timestamptz, timestamptz) from public, anon;
revoke all on function public.director_rep_cost(date, date) from public, anon;
grant execute on function public.director_rep_kpis(timestamptz, timestamptz) to authenticated;
grant execute on function public.director_rep_cost(date, date) to authenticated;
