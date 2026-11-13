alter table public.goals
  add column if not exists why text,
  add column if not exists parent_goal_id uuid references public.goals(id) on delete cascade;
create index if not exists goals_parent_goal_id_idx on public.goals(parent_goal_id);

create or replace function public.set_goal_why(_goal_id uuid, _why text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_subject uuid; v_loc uuid;
begin
  select subject_user_id, location_id into v_subject, v_loc from public.goals where id = _goal_id;
  if v_loc is null then
    raise exception 'Goal not found';
  end if;
  if not (v_subject = auth.uid() or public.can_manage_location(auth.uid(), v_loc)) then
    raise exception 'Not permitted to edit this goal';
  end if;
  update public.goals set why = nullif(btrim(_why), ''), updated_at = now()
   where id = _goal_id or parent_goal_id = _goal_id;
end;
$$;
revoke execute on function public.set_goal_why(uuid, text) from anon, public;
grant execute on function public.set_goal_why(uuid, text) to authenticated;

create table if not exists public.commission_payouts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  location_id uuid not null references public.locations(id) on delete restrict,
  kind text not null check (kind in ('salary','commission')),
  amount numeric not null default 0,
  status text not null default 'pending' check (status in ('pending','issued')),
  period_start date not null,
  period_end date not null,
  issued_on date,
  job_id uuid references public.jobs(id) on delete set null,
  note text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  is_demo boolean not null default false
);
create index if not exists commission_payouts_user_period_idx on public.commission_payouts(user_id, period_start);

grant select, insert, update, delete on public.commission_payouts to authenticated;
grant all on public.commission_payouts to service_role;
alter table public.commission_payouts enable row level security;

drop policy if exists commission_payouts_finance_all on public.commission_payouts;
create policy commission_payouts_finance_all on public.commission_payouts
  for all to authenticated
  using (public.can_view_finance(auth.uid()))
  with check (public.can_view_finance(auth.uid()));

create or replace function public.my_commission_summary(_from date, _to date)
returns table(salary_paid numeric, commission_paid numeric, pending_count integer, last_issued_on date)
language sql
stable
security definer
set search_path = public
as $$
  select
    coalesce(sum(amount) filter (where kind = 'salary' and status = 'issued'), 0)::numeric,
    coalesce(sum(amount) filter (where kind = 'commission' and status = 'issued'), 0)::numeric,
    coalesce(count(*) filter (where status = 'pending'), 0)::integer,
    max(issued_on) filter (where status = 'issued')
  from public.commission_payouts
  where user_id = auth.uid()
    and period_start >= _from
    and period_start <= _to;
$$;
revoke execute on function public.my_commission_summary(date, date) from anon, public;
grant execute on function public.my_commission_summary(date, date) to authenticated;