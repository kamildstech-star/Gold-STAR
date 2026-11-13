-- =========================================================
-- Fix: creator-of-record must always be able to read the row.
-- Same-shape bug across several tables: SELECT policy depends
-- on a linked row (membership / assignment) that only exists
-- AFTER the initial insert. .insert().select() then returns
-- zero rows and the UI reads it as a silent failure.
-- The fix is to add `created_by = auth.uid()` as an OR to the
-- SELECT policy on tables that have a created_by column.
-- =========================================================

-- --- conversations (codify the hotfix already applied live) ---
drop policy if exists "Members read conversations" on public.conversations;
create policy "Members read conversations"
  on public.conversations for select
  using (created_by = auth.uid() or public.is_conversation_member(id, auth.uid()));

drop policy if exists "Members update conversation metadata" on public.conversations;
create policy "Members update conversation metadata"
  on public.conversations for update
  using (created_by = auth.uid() or public.is_conversation_member(id, auth.uid()))
  with check (created_by = auth.uid() or public.is_conversation_member(id, auth.uid()));

-- --- projects ---
-- SELECT resolves through can_view_project(), which checks
-- project_members / location_members / region. A creator who
-- is neither yet still needs to read their own new row.
drop policy if exists "projects_select_visible" on public.projects;
create policy "projects_select_visible"
  on public.projects for select
  using (created_by = auth.uid() or public.can_view_project(auth.uid(), id));

-- --- jobs ---
-- Same shape: can_view_job() requires location visibility,
-- crew_chief match, or a job_assignments row (inserted after).
drop policy if exists "jobs_select" on public.jobs;
create policy "jobs_select"
  on public.jobs for select
  using (
    created_by = auth.uid()
    or public.is_privileged(auth.uid())
    or public.can_view_location(auth.uid(), location_id)
    or crew_chief = auth.uid()
    or exists (
      select 1 from public.job_assignments ja
      where ja.job_id = jobs.id and ja.user_id = auth.uid()
    )
  );

-- --- accounts ---
-- SELECT is `can_view_location OR assigned_rep = auth.uid()`.
-- A rep creating an account they don't yet own or aren't
-- location-scoped to would insert but not read.
drop policy if exists "accounts_select" on public.accounts;
create policy "accounts_select"
  on public.accounts for select
  using (
    created_by = auth.uid()
    or public.can_view_location(auth.uid(), location_id)
    or assigned_rep = auth.uid()
  );

-- --- incidents ---
-- Manual dispatch inserts by an office user without a
-- location_members row would fail readback the same way.
drop policy if exists "incidents_select_by_creator" on public.incidents;
create policy "incidents_select_by_creator"
  on public.incidents for select
  using (created_by = auth.uid());
-- The three existing incidents_select_* policies remain in place;
-- this one adds the creator path without touching them.