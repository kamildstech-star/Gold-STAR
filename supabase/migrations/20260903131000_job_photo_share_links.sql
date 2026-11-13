-- Photo share links.
--
-- Renamed from 20260903130000_job_photo_share_links.sql on 2026-09-03: it
-- shared its timestamp with 20260903130000_security_hardening_batch1.sql. The
-- version to record for this file is 20260903131000. Contents unchanged.
--
-- Depends on 20260825120000, which adds share_links.job_id, document_ids and
-- display_options and drops the NOT NULL on project_id, and on
-- 20260827091000_share_links_job_schedule, which adds the job-scoped RLS
-- policies every job link needs to be created, listed and revoked. Apply both
-- first; this migration is meaningless without them.
--
-- Everything here is re-runnable. Migrations in this project are applied by
-- hand and sometimes by Lovable, so a second pass has to be a no-op.

-- ---------------------------------------------------------------------------
-- 1. A fourth kind of link.
--
-- Not 'photo_set': that kind is project-scoped, and the check trigger written
-- with it REQUIRES a non-empty photo_ids. A job's Pictures tab merges album
-- photographs with image documents, and a link carrying only documents is a
-- perfectly ordinary thing for someone to send. 'job_photos' also tells the
-- public viewer what to render without having to guess from the row's shape.
--
-- ADD VALUE is safe inside this transaction because nothing below uses the new
-- value; a statement that did would have to wait for its own migration.
-- ---------------------------------------------------------------------------

ALTER TYPE public.share_link_kind ADD VALUE IF NOT EXISTS 'job_photos';

-- ---------------------------------------------------------------------------
-- 2. photo_ids on a report is text[], not uuid[].
--
-- 20260825120000 declares `job_reports.photo_ids uuid[]`. photos.id is `text`
-- and holds a client-generated ULID -- see 20260728175932 -- so every attach
-- would have failed on "invalid input syntax for type uuid". Corrected here
-- rather than by editing history, because that migration may already be
-- applied on some database somewhere.
--
-- share_links.photo_ids was text[] from the start and is already right.
-- share_links.document_ids stays uuid[]: documents.id really is a uuid.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'job_reports' AND column_name = 'photo_ids'
  ) THEN
    ALTER TABLE public.job_reports ADD COLUMN photo_ids text[];
  ELSIF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'job_reports'
      AND column_name = 'photo_ids' AND udt_name = '_uuid'
  ) THEN
    ALTER TABLE public.job_reports
      ALTER COLUMN photo_ids TYPE text[] USING photo_ids::text[];
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. The job-scoped policies, restated.
--
-- Identical to 20260827091000_share_links_job_schedule. Repeated because that
-- migration and this one can land in either order on a database that is
-- brought up to date by hand, and a photo link with no SELECT policy is a link
-- nobody can find again to revoke. DROP-then-CREATE, so a second pass replaces
-- rather than errors.
--
-- Read is can_view_job and write is can_manage_job on insert only: revocation
-- must never be harder than creation, or a live link outlives the person who
-- sent it.
--
-- Still NO anon policy. The public viewer resolves a token through a server
-- function on the service role, and the image bytes come back through a route
-- that re-checks revocation and expiry on every request. Opening `photos` to
-- anon and trusting a policy to hold the line is a far larger blast radius for
-- the same result.
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
