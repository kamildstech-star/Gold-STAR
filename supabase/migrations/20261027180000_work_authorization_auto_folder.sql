-- Work authorizations file themselves, in the database (27 Oct).
--
-- 20261027170000 + the app file a new signed work authorization into its
-- job's "Work Authorizations" folder as it is written. But the app is an
-- installed PWA that keeps running the version it loaded until the user takes
-- the update (registerType "prompt"): an iPad in the field can sign with the
-- old code for days, and its signings land at the top level — where, once
-- signed, nothing but move_document_to_folder can move them. Seen on staging
-- the same day: three signed after the fix shipped stayed at the top level.
--
-- So the database does it: a work authorization inserted on a job with no
-- folder goes into that job's "Work Authorizations" folder, made if missing.
-- A folder the app chose is kept. Also re-files any that slipped through.
-- Re-runnable.

CREATE OR REPLACE FUNCTION public.file_work_authorization()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _folder uuid;
BEGIN
  IF NEW.doc_type::text <> 'work_authorization' OR NEW.job_id IS NULL OR NEW.folder_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT f.id INTO _folder
  FROM public.document_folders f
  WHERE f.job_id = NEW.job_id AND f.parent_folder_id IS NULL
    AND lower(trim(f.name)) = 'work authorizations'
  ORDER BY f.created_at
  LIMIT 1;
  IF _folder IS NULL THEN
    INSERT INTO public.document_folders (location_id, job_id, name, created_by)
    VALUES (NEW.location_id, NEW.job_id, 'Work Authorizations', NEW.created_by)
    RETURNING id INTO _folder;
  END IF;
  NEW.folder_id := _folder;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.file_work_authorization() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_documents_file_work_authorization ON public.documents;
CREATE TRIGGER trg_documents_file_work_authorization
BEFORE INSERT ON public.documents
FOR EACH ROW EXECUTE FUNCTION public.file_work_authorization();

-- The ones that slipped through since 20261027170000's own backfill.
INSERT INTO public.document_folders (location_id, job_id, name, created_by)
SELECT DISTINCT ON (d.job_id) d.location_id, d.job_id, 'Work Authorizations', d.created_by
FROM public.documents d
WHERE d.doc_type::text = 'work_authorization'
  AND d.job_id IS NOT NULL
  AND d.folder_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.document_folders f
    WHERE f.job_id = d.job_id AND f.parent_folder_id IS NULL
      AND lower(trim(f.name)) = 'work authorizations')
ORDER BY d.job_id, d.created_at;

UPDATE public.documents d
SET folder_id = (
  SELECT f.id FROM public.document_folders f
  WHERE f.job_id = d.job_id AND f.parent_folder_id IS NULL
    AND lower(trim(f.name)) = 'work authorizations'
  ORDER BY f.created_at LIMIT 1)
WHERE d.doc_type::text = 'work_authorization'
  AND d.job_id IS NOT NULL
  AND d.folder_id IS NULL;
