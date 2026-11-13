-- Saved job calculations are intake drafts: they may exist before a job, then
-- be attached after the job is created.  The calculated snapshots let saved
-- rows remain auditable even when pricing constants change in application code.
create table if not exists public.job_calculations (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id),
  job_id uuid references public.jobs(id) on delete set null,
  job_date date not null default current_date,
  customer_name text,
  contact_number text,
  email text,
  address text,
  address_line2 text,
  locality text,
  region text,
  postal_code text,
  job_type text not null check (job_type in ('water', 'mold', 'fire_smoke')),
  days integer not null default 1 check (days >= 0),
  workers integer not null default 1 check (workers >= 0),
  regular_hours numeric(12,2) not null default 0 check (regular_hours >= 0),
  after_hours numeric(12,2) not null default 0 check (after_hours >= 0),
  emergency boolean not null default false,
  garbage_fee numeric(14,2) not null default 0 check (garbage_fee >= 0),
  miscellaneous_fee numeric(14,2) not null default 0 check (miscellaneous_fee >= 0),
  equipment_quantities jsonb not null default '{}'::jsonb,
  customer_price numeric(14,2) not null default 0,
  internal_cost numeric(14,2) not null default 0,
  equipment_profit numeric(14,2) not null default 0,
  overall_profit numeric(14,2) not null default 0,
  created_by uuid not null references public.profiles(user_id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint job_calculations_equipment_object
    check (jsonb_typeof(equipment_quantities) = 'object')
);

create index if not exists job_calculations_location_idx
  on public.job_calculations(location_id, created_at desc);
create index if not exists job_calculations_job_idx
  on public.job_calculations(job_id) where job_id is not null;
create index if not exists job_calculations_creator_idx
  on public.job_calculations(created_by, created_at desc);

alter table public.job_calculations enable row level security;

-- New Supabase projects no longer expose public tables automatically.  Keep
-- grants explicit and do not expose any path to signed-out clients.
revoke all on table public.job_calculations from anon;
revoke all on table public.job_calculations from authenticated;
grant select, insert, update, delete on table public.job_calculations to authenticated;
grant all on table public.job_calculations to service_role;

drop policy if exists job_calculations_select on public.job_calculations;
create policy job_calculations_select
  on public.job_calculations
  for select
  to authenticated
  using (
    public.can_view_location((select auth.uid()), location_id)
    or created_by = (select auth.uid())
  );

drop policy if exists job_calculations_insert on public.job_calculations;
create policy job_calculations_insert
  on public.job_calculations
  for insert
  to authenticated
  with check (
    created_by = (select auth.uid())
    and public.can_view_location((select auth.uid()), location_id)
    and (
      job_id is null
      or exists (
        select 1
        from public.jobs j
        where j.id = job_calculations.job_id
          and j.location_id = job_calculations.location_id
          and public.can_view_location((select auth.uid()), j.location_id)
      )
    )
  );

drop policy if exists job_calculations_update on public.job_calculations;
create policy job_calculations_update
  on public.job_calculations
  for update
  to authenticated
  using (
    public.can_manage_location((select auth.uid()), location_id)
    or created_by = (select auth.uid())
  )
  with check (
    (public.can_manage_location((select auth.uid()), location_id)
      or created_by = (select auth.uid()))
    and (
      job_id is null
      or exists (
        select 1
        from public.jobs j
        where j.id = job_calculations.job_id
          and j.location_id = job_calculations.location_id
          and public.can_view_location((select auth.uid()), j.location_id)
      )
    )
  );

drop policy if exists job_calculations_delete on public.job_calculations;
create policy job_calculations_delete
  on public.job_calculations
  for delete
  to authenticated
  using (
    public.can_manage_location((select auth.uid()), location_id)
    or created_by = (select auth.uid())
  );

drop trigger if exists job_calculations_set_updated_at on public.job_calculations;
create trigger job_calculations_set_updated_at
  before update on public.job_calculations
  for each row execute function public.set_updated_at();
