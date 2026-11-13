-- Repair the already-applied job_calculations migration. Unqualified
-- `location_id` inside the jobs subquery bound to `jobs.location_id`, turning
-- the intended cross-table tenant check into a tautology. Replacing each
-- policy is safe to repeat and leaves the rest of the access model unchanged.

revoke all on table public.job_calculations from authenticated;
grant select, insert, update, delete on table public.job_calculations to authenticated;

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
