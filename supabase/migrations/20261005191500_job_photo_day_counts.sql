-- The job's photo counts, from the database: per folder, per day, in total.
--
-- The job Pictures tab read every photo in one go, capped at the newest 600
-- album photos and 200 image documents, and every number on the page was the
-- length of that read — the tab badge, "All photos", each room, each day,
-- "View all" on the General tab, and the "179 of 182 have reached the server"
-- notice. Past the cap the job showed a partial album and all of those numbers
-- agreed with the partial count. The 36 Journal Square job reached 179 photos
-- on its first day.
--
-- The tab now pages as it scrolls, so the loaded rows can no longer be the
-- count even in principle. This function is the count: one call, grouped by
-- source, folder and day, so the header and every day row are right before a
-- single tile has loaded.
--
-- SECURITY INVOKER on purpose. It counts through the caller's RLS on photos,
-- projects and documents, exactly as the page reads them, so it can never
-- report a photo the caller could not open — and needs no access check of its
-- own, because it has no privilege of its own.
--
-- `_tz` is the viewer's IANA zone. The grid groups photos by the day they were
-- taken where the viewer is; counting UTC days would move every evening photo
-- onto tomorrow's row and the counts would not match the tiles under them. An
-- unknown zone raises, and the page falls back to its head counts.
--
-- What counts as a picture is the page's own rule, restated here:
--   * album photos: in a project whose job_id is the job, not soft-deleted;
--     the day is the capture time, else the upload time (`takenAt` in
--     src/lib/job-photos.ts);
--   * image documents filed against the job that have a stored file, except
--     payment evidence. 'carrier_correspondence' is PAYMENT_ATTACHMENT_DOC_TYPE
--     in src/lib/documents.ts — a photographed cheque carries a routing and
--     account number and is kept out of the crew's gallery. A test holds the
--     two literals together.
--
-- The index serves the page reads: keyset pages ordered captured_at DESC NULLS
-- LAST, created_at DESC, id DESC within a job's albums, live rows only. The
-- existing photos_project_idx (project_id, captured_at DESC) sorts nulls first
-- and stops short of the tie-breakers, so every page re-sorted the job.
--
-- Not applied by the PR that adds it. Until it is, the page uses head counts
-- and per-folder embedded counts (exact totals and folder numbers), and marks
-- per-day numbers it has not finished loading with a "+".

BEGIN;

CREATE OR REPLACE FUNCTION public.job_photo_day_counts(_job_id uuid, _tz text DEFAULT 'UTC')
 RETURNS TABLE(source text, folder_id uuid, day date, n bigint)
 LANGUAGE sql
 STABLE SECURITY INVOKER
 SET search_path TO 'public'
AS $function$
  SELECT 'album'::text,
         p.folder_id,
         (coalesce(p.captured_at, p.created_at) AT TIME ZONE _tz)::date,
         count(*)
    FROM public.photos p
    JOIN public.projects pr ON pr.id = p.project_id
   WHERE pr.job_id = _job_id
     AND p.deleted_at IS NULL
   GROUP BY 2, 3
  UNION ALL
  SELECT 'document'::text,
         NULL::uuid,
         (d.created_at AT TIME ZONE _tz)::date,
         count(*)
    FROM public.documents d
   WHERE d.job_id = _job_id
     AND d.mime LIKE 'image/%'
     AND d.doc_type <> 'carrier_correspondence'
     AND d.storage_path IS NOT NULL
     AND d.storage_bucket IS NOT NULL
   GROUP BY 3
$function$;

REVOKE ALL ON FUNCTION public.job_photo_day_counts(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.job_photo_day_counts(uuid, text) TO authenticated, service_role;

CREATE INDEX IF NOT EXISTS photos_album_page_idx
  ON public.photos (project_id, captured_at DESC NULLS LAST, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;

COMMIT;
