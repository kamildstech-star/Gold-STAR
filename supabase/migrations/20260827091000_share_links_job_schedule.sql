-- Job schedule share links.
--
-- Renamed from 20260827090000_share_links_job_schedule.sql on 2026-09-03: it
-- shared its timestamp with 20260827090000_document_folders.sql, and the CLI
-- keys history on the timestamp alone. The version to record for this file is
-- 20260827091000. Contents unchanged.
--
-- Live state (2026-09-03): the enum value and all three policies already exist
-- in production, but Lovable wrote the SELECT and UPDATE policies with
-- can_manage_job. This file re-creates them with can_view_job as designed
-- below, so anyone who can see a job can find and revoke its links.
--
-- Depends on 20260825120000, which adds share_links.job_id, document_ids and
-- display_options and drops the NOT NULL on project_id. Apply that one first;
-- this migration is meaningless without it.
--
-- Nothing here is destructive: one enum value and three additional permissive
-- policies. No existing policy is altered and no row changes meaning.

-- ---------------------------------------------------------------------------
-- 1. A third kind of link.
--
-- 'project' and 'photo_set' both describe photographs. A schedule share is
-- neither, and reusing one of them would mean the public viewer had to guess
-- from the shape of the row what it was being asked to render.
--
-- ADD VALUE is safe inside this transaction because nothing below uses the new
-- value; a statement that did would have to wait for its own migration.
-- ---------------------------------------------------------------------------

ALTER TYPE public.share_link_kind ADD VALUE IF NOT EXISTS 'job_schedule';

-- ---------------------------------------------------------------------------
-- 2. RLS for job-scoped links.
--
-- The original policies are all can_manage_project(auth.uid(), project_id).
-- On a job-scoped row project_id is NULL, so that predicate evaluates to NULL
-- and every statement is denied -- a staff member could not create, list or
-- revoke their own link. These add the job-scoped half; because RLS policies
-- are OR'd, the existing project behaviour is untouched.
--
-- Read is can_view_job so anyone who can see the job can audit and revoke its
-- links. Making revocation harder than creation is how a live link outlives
-- the person who sent it.
--
-- Still NO anon policy, by the same reasoning as 20260825120000: the public
-- viewer resolves a token through a server function on the service role.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "share_links_select_job" ON public.share_links;
CREATE POLICY "share_links_select_job"
ON public.share_links FOR SELECT TO authenticated
USING (job_id IS NOT NULL AND public.can_view_job(auth.uid(), job_id));

DROP POLICY IF EXISTS "share_links_insert_job" ON public.share_links;
CREATE POLICY "share_links_insert_job"
ON public.share_links FOR INSERT TO authenticated
WITH CHECK (
  job_id IS NOT NULL
  AND public.can_manage_job(auth.uid(), job_id)
  AND created_by = auth.uid()
);

DROP POLICY IF EXISTS "share_links_update_job" ON public.share_links;
CREATE POLICY "share_links_update_job"
ON public.share_links FOR UPDATE TO authenticated
USING (job_id IS NOT NULL AND public.can_view_job(auth.uid(), job_id))
WITH CHECK (job_id IS NOT NULL AND public.can_view_job(auth.uid(), job_id));
