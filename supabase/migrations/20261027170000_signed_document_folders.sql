-- Signed documents can be filed into folders (27 Oct).
--
-- documents_update refuses every write to a signed row (`status <> 'signed'`),
-- so moving a signed work authorization into a folder updated nothing and
-- reported nothing: the Move menu looked like it worked and the document
-- stayed at the top level. A folder is filing, not evidence — the immutability
-- trigger already leaves folder_id writable — so this function changes
-- folder_id and nothing else, for the same people documents_update lets edit
-- an unsigned document.
--
-- It also files the signed work authorizations already on jobs into each
-- job's "Work Authorizations" folder, the folder new ones now land in.
-- Re-runnable.

CREATE OR REPLACE FUNCTION public.move_document_to_folder(_document_id uuid, _folder_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  d public.documents%ROWTYPE;
  f public.document_folders%ROWTYPE;
BEGIN
  SELECT * INTO d FROM public.documents WHERE id = _document_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Document not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT (public.can_manage_location(auth.uid(), d.location_id) OR d.created_by = auth.uid()) THEN
    RAISE EXCEPTION 'You cannot file this document' USING ERRCODE = '42501';
  END IF;
  IF _folder_id IS NOT NULL THEN
    SELECT * INTO f FROM public.document_folders WHERE id = _folder_id;
    -- The folder must be in the same tree the document is shown in.
    IF NOT FOUND
       OR f.location_id <> d.location_id
       OR (d.job_id IS NOT NULL AND f.job_id IS DISTINCT FROM d.job_id)
       OR (d.job_id IS NULL AND d.project_id IS NOT NULL AND f.project_id IS DISTINCT FROM d.project_id)
    THEN
      RAISE EXCEPTION 'That folder is not on this document''s job' USING ERRCODE = '22023';
    END IF;
  END IF;
  UPDATE public.documents SET folder_id = _folder_id WHERE id = _document_id;
END $$;

REVOKE ALL ON FUNCTION public.move_document_to_folder(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.move_document_to_folder(uuid, uuid) TO authenticated;

-- Existing signed work authorizations at a job's top level: one
-- "Work Authorizations" folder per job (an existing one of that name is used),
-- and the documents filed into it.
INSERT INTO public.document_folders (location_id, job_id, name, created_by)
SELECT DISTINCT ON (d.job_id) d.location_id, d.job_id, 'Work Authorizations', d.created_by
FROM public.documents d
WHERE d.doc_type = 'work_authorization'
  AND d.job_id IS NOT NULL
  AND d.folder_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.document_folders f
    WHERE f.job_id = d.job_id AND f.parent_folder_id IS NULL
      AND lower(trim(f.name)) = 'work authorizations')
ORDER BY d.job_id, d.created_at;

UPDATE public.documents d
SET folder_id = f.id
FROM public.document_folders f
WHERE d.doc_type = 'work_authorization'
  AND d.job_id IS NOT NULL
  AND d.folder_id IS NULL
  AND f.job_id = d.job_id
  AND f.parent_folder_id IS NULL
  AND lower(trim(f.name)) = 'work authorizations';
