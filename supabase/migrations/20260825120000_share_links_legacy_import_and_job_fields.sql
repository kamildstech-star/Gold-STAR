-- Four things that all needed columns, applied together rather than as four
-- separate round trips.
--
-- Nothing here is destructive: every statement adds a nullable column or an
-- index. No existing row changes meaning, and no policy is loosened.

-- ---------------------------------------------------------------------------
-- 1. Next steps on the job.
--
-- The office and the field chase different things on the same job -- the
-- office is waiting on an adjuster, the crew is waiting on a dry reading --
-- and collapsing both into one note means one of them is always stale.
-- ---------------------------------------------------------------------------

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS office_next_step text,
  ADD COLUMN IF NOT EXISTS field_next_step  text;

-- ---------------------------------------------------------------------------
-- 2. HOA.
--
-- Deliberately nullable with no default. "Nobody has checked yet" and "no,
-- there is no HOA" are different answers, and defaulting to false would
-- silently assert the second on every job that exists today.
-- ---------------------------------------------------------------------------

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS hoa boolean;

-- ---------------------------------------------------------------------------
-- 3. Legacy import provenance (JobNimbus).
--
-- Two jobs at once:
--
--   * The "this is old data" flag. `external_source IS NOT NULL` marks a record
--     as imported history, so it can be filtered out of live boards, counts and
--     pipelines and never mixes into new work. is_demo was NOT reused for this
--     -- demo data gets purged, and this is real history that must survive.
--
--   * Idempotent re-import. The unique index is what makes running the import a
--     second time UPDATE rather than duplicate. The first pass always gets some
--     mapping wrong, so there will be a second pass.
--
-- Partial indexes: rows created in the app leave both columns null, and those
-- must not collide with each other.
-- ---------------------------------------------------------------------------

ALTER TABLE public.jobs      ADD COLUMN IF NOT EXISTS external_source text,
                             ADD COLUMN IF NOT EXISTS external_id     text;
ALTER TABLE public.accounts  ADD COLUMN IF NOT EXISTS external_source text,
                             ADD COLUMN IF NOT EXISTS external_id     text;
ALTER TABLE public.contacts  ADD COLUMN IF NOT EXISTS external_source text,
                             ADD COLUMN IF NOT EXISTS external_id     text;
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS external_source text,
                             ADD COLUMN IF NOT EXISTS external_id     text;

CREATE UNIQUE INDEX IF NOT EXISTS jobs_external_ref_key
  ON public.jobs (external_source, external_id)
  WHERE external_source IS NOT NULL AND external_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS accounts_external_ref_key
  ON public.accounts (external_source, external_id)
  WHERE external_source IS NOT NULL AND external_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS contacts_external_ref_key
  ON public.contacts (external_source, external_id)
  WHERE external_source IS NOT NULL AND external_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS documents_external_ref_key
  ON public.documents (external_source, external_id)
  WHERE external_source IS NOT NULL AND external_id IS NOT NULL;

-- Boards and counts filter on this constantly; keep it cheap.
CREATE INDEX IF NOT EXISTS jobs_external_source_idx
  ON public.jobs (external_source) WHERE external_source IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. Photo share links.
--
-- share_links already carries token, photo_ids, expiry, revoke and
-- allow_download_original. Three gaps stopped it being usable from a job:
--
--   * It is keyed to a single project_id, but a job's Pictures tab merges
--     photos from SEVERAL albums plus image documents. job_id scopes a link to
--     the job a person actually opened.
--   * Image documents live in `documents`, not `photos`, so they could never be
--     included. document_ids fixes that.
--   * Nothing recorded what the recipient may see. display_options holds that
--     per link -- capture time, location, uploader, caption, tags, folder name,
--     markup -- so an adjuster and a landlord can get different views of the
--     same photograph.
--
-- No anonymous RLS policy is added here ON PURPOSE. The public viewer resolves
-- a token through a server function using the service role and returns signed
-- URLs. Opening `photos` to anon and relying on a policy to hold the line is a
-- far larger blast radius for the same result.
-- ---------------------------------------------------------------------------

ALTER TABLE public.share_links
  ADD COLUMN IF NOT EXISTS job_id          uuid REFERENCES public.jobs(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS document_ids    uuid[],
  ADD COLUMN IF NOT EXISTS display_options jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.share_links
  ALTER COLUMN project_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS share_links_job_id_idx
  ON public.share_links (job_id) WHERE job_id IS NOT NULL;

-- A link must belong to something.
ALTER TABLE public.share_links
  DROP CONSTRAINT IF EXISTS share_links_scope_present;
ALTER TABLE public.share_links
  ADD CONSTRAINT share_links_scope_present
  CHECK (project_id IS NOT NULL OR job_id IS NOT NULL);

-- ---------------------------------------------------------------------------
-- 5. Photos embedded in a job report.
--
-- job_reports currently stores only a COUNT of photos in its snapshot, so a
-- report can say "14 photos" but cannot carry one. Ordered array rather than a
-- join table: the order the photos appear in the report is the whole point, and
-- a join table would need its own position column to say the same thing.
-- ---------------------------------------------------------------------------

-- text[], not uuid[]: photos.id is a client-generated ULID stored as text
-- (20260728175932), so a uuid[] column could never hold one. Corrected here
-- because this file is unapplied in production (verified 2026-09-03);
-- 20260903131000_job_photo_share_links still converts any uuid[] copy left by
-- an earlier version of this file on another database.
ALTER TABLE public.job_reports
  ADD COLUMN IF NOT EXISTS photo_ids text[];
