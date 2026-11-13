-- Standalone intake links.
--
-- An intake link could only ever be sent to someone who was already a job,
-- because job_id was the thing that made a request exist. The office needs to
-- send the same form to a prospect who has not been entered yet and decide the
-- job afterwards, so the job becomes something a request GAINS at triage
-- rather than something it is born with.

alter table public.intake_requests alter column job_id drop not null;
alter table public.intake_submissions alter column job_id drop not null;

-- A job-less request still belongs to an office. It is what scopes the row for
-- RLS and what brands the public form, both of which used to come off the job.
alter table public.intake_requests
  add column if not exists location_id uuid references public.locations(id);
-- What the office called this link ("Website form", "Storm door-knock"), so an
-- inbox of unassigned leads can say where each one came from.
alter table public.intake_requests add column if not exists label text;

create index if not exists intake_requests_unassigned_idx
  on public.intake_requests(location_id) where job_id is null;
create index if not exists intake_submissions_unassigned_idx
  on public.intake_submissions(status) where job_id is null;

-- Job-linked rows keep exactly the visibility they had. A row with no job falls
-- back to the office it was minted for; a row with neither is privileged-only,
-- so an untriaged lead is never wider open than the job it becomes.
drop policy if exists intake_requests_select on public.intake_requests;
create policy intake_requests_select on public.intake_requests for select to authenticated
  using (
    case
      when job_id is not null then public.can_view_job((select auth.uid()), job_id)
      when location_id is not null then public.can_view_location((select auth.uid()), location_id)
      else public.is_privileged((select auth.uid()))
    end
  );

drop policy if exists intake_requests_write on public.intake_requests;
create policy intake_requests_write on public.intake_requests for all to authenticated
  using (
    case
      when job_id is not null then public.can_manage_job((select auth.uid()), job_id)
      when location_id is not null then public.can_manage_location((select auth.uid()), location_id)
      else public.is_privileged((select auth.uid()))
    end
  )
  with check (
    case
      when job_id is not null then public.can_manage_job((select auth.uid()), job_id)
      when location_id is not null then public.can_manage_location((select auth.uid()), location_id)
      else public.is_privileged((select auth.uid()))
    end
  );

-- A submission with no job inherits its scope from the request that produced
-- it, which is the only row that still knows which office is waiting on it.
drop policy if exists intake_submissions_select on public.intake_submissions;
create policy intake_submissions_select on public.intake_submissions for select to authenticated
  using (
    case
      when job_id is not null then public.can_view_job((select auth.uid()), job_id)
      else exists (
        select 1 from public.intake_requests r
        where r.id = request_id
          and case
            when r.location_id is not null
              then public.can_view_location((select auth.uid()), r.location_id)
            else public.is_privileged((select auth.uid()))
          end
      )
    end
  );

drop policy if exists intake_submissions_write on public.intake_submissions;
create policy intake_submissions_write on public.intake_submissions for all to authenticated
  using (
    case
      when job_id is not null then public.can_manage_job((select auth.uid()), job_id)
      else exists (
        select 1 from public.intake_requests r
        where r.id = request_id
          and case
            when r.location_id is not null
              then public.can_manage_location((select auth.uid()), r.location_id)
            else public.is_privileged((select auth.uid()))
          end
      )
    end
  )
  with check (
    case
      when job_id is not null then public.can_manage_job((select auth.uid()), job_id)
      else exists (
        select 1 from public.intake_requests r
        where r.id = request_id
          and case
            when r.location_id is not null
              then public.can_manage_location((select auth.uid()), r.location_id)
            else public.is_privileged((select auth.uid()))
          end
      )
    end
  );
