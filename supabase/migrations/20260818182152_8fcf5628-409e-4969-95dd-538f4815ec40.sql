
alter table public.email_templates add column if not exists intake_form boolean not null default false;

create table if not exists public.intake_requests (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  token text not null unique default encode(gen_random_bytes(24), 'hex'),
  recipient_email text,
  recipient_name text,
  note text,
  email_message_id uuid,
  expires_at timestamptz not null default (now() + interval '30 days'),
  revoked_at timestamptz,
  submitted_at timestamptz,
  created_by uuid,
  is_demo boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists intake_requests_job_idx on public.intake_requests(job_id);

create table if not exists public.intake_submissions (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.intake_requests(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  submitted_by_name text,
  submitted_by_email text,
  answers jsonb not null default '{}'::jsonb,
  fields jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending','applied','dismissed')),
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists intake_submissions_job_idx on public.intake_submissions(job_id, status);

grant select, insert, update, delete on public.intake_requests to authenticated;
grant all on public.intake_requests to service_role;
grant select, insert, update, delete on public.intake_submissions to authenticated;
grant all on public.intake_submissions to service_role;

alter table public.intake_requests enable row level security;
alter table public.intake_submissions enable row level security;

drop policy if exists intake_requests_select on public.intake_requests;
create policy intake_requests_select on public.intake_requests for select to authenticated
  using (public.can_view_job((select auth.uid()), job_id));
drop policy if exists intake_requests_write on public.intake_requests;
create policy intake_requests_write on public.intake_requests for all to authenticated
  using (public.can_manage_job((select auth.uid()), job_id))
  with check (public.can_manage_job((select auth.uid()), job_id));

drop policy if exists intake_submissions_select on public.intake_submissions;
create policy intake_submissions_select on public.intake_submissions for select to authenticated
  using (public.can_view_job((select auth.uid()), job_id));
drop policy if exists intake_submissions_write on public.intake_submissions;
create policy intake_submissions_write on public.intake_submissions for all to authenticated
  using (public.can_manage_job((select auth.uid()), job_id))
  with check (public.can_manage_job((select auth.uid()), job_id));

alter table public.job_intake_answers add column if not exists source text not null default 'staff';
