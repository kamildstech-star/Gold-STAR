-- Folders for documents.
--
-- Scoped the way photo_folders is: a folder belongs to the same container the
-- panel is showing, so a tree built on a job never leaks onto another job.
-- Documents have three possible containers rather than one, plus a mandatory
-- location, so the shape mirrors public.documents itself — location_id is the
-- RLS anchor and at most one of job/account/project narrows it.
--
-- documents.folder_id is nullable and defaults to NULL on purpose: every
-- document that exists today stays exactly where it is, at the top level.

CREATE TABLE IF NOT EXISTS public.document_folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  job_id uuid REFERENCES public.jobs(id) ON DELETE CASCADE,
  account_id uuid REFERENCES public.accounts(id) ON DELETE CASCADE,
  project_id uuid REFERENCES public.projects(id) ON DELETE CASCADE,
  parent_folder_id uuid REFERENCES public.document_folders(id) ON DELETE CASCADE,
  name text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- A folder filed against two containers at once would appear in both trees
  -- and belong to neither.
  CONSTRAINT document_folders_one_scope CHECK (
    (job_id IS NOT NULL)::int + (account_id IS NOT NULL)::int + (project_id IS NOT NULL)::int <= 1
  )
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.document_folders TO authenticated;
GRANT ALL ON public.document_folders TO service_role;
ALTER TABLE public.document_folders ENABLE ROW LEVEL SECURITY;

-- Mirrors the documents policies. A folder is filing, not evidence, so it has
-- no equivalent of the `status <> 'signed'` freeze on documents_update.
-- DROP-then-CREATE (since 2026-09-03) so the file can be re-run by hand.
DROP POLICY IF EXISTS "document_folders_select" ON public.document_folders;
CREATE POLICY "document_folders_select" ON public.document_folders FOR SELECT TO authenticated
  USING (public.can_view_location(auth.uid(), location_id) OR created_by = auth.uid());
DROP POLICY IF EXISTS "document_folders_insert" ON public.document_folders;
CREATE POLICY "document_folders_insert" ON public.document_folders FOR INSERT TO authenticated
  WITH CHECK (public.can_view_location(auth.uid(), location_id) AND created_by = auth.uid());
DROP POLICY IF EXISTS "document_folders_update" ON public.document_folders;
CREATE POLICY "document_folders_update" ON public.document_folders FOR UPDATE TO authenticated
  USING (public.can_manage_location(auth.uid(), location_id) OR created_by = auth.uid());
DROP POLICY IF EXISTS "document_folders_delete" ON public.document_folders;
CREATE POLICY "document_folders_delete" ON public.document_folders FOR DELETE TO authenticated
  USING (public.can_manage_location(auth.uid(), location_id));

CREATE INDEX IF NOT EXISTS document_folders_job_idx
  ON public.document_folders (job_id, parent_folder_id, sort_order);
CREATE INDEX IF NOT EXISTS document_folders_account_idx
  ON public.document_folders (account_id, parent_folder_id, sort_order);
CREATE INDEX IF NOT EXISTS document_folders_project_idx
  ON public.document_folders (project_id, parent_folder_id, sort_order);
CREATE INDEX IF NOT EXISTS document_folders_location_idx
  ON public.document_folders (location_id, parent_folder_id, sort_order);

DROP TRIGGER IF EXISTS document_folders_set_updated_at ON public.document_folders;
CREATE TRIGGER document_folders_set_updated_at BEFORE UPDATE ON public.document_folders
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- A folder must sit in the same container as its parent, or the tree lies.
CREATE OR REPLACE FUNCTION public.check_document_folder_parent()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE parent public.document_folders%ROWTYPE;
BEGIN
  IF NEW.parent_folder_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.parent_folder_id = NEW.id THEN
    RAISE EXCEPTION 'A folder cannot be its own parent.';
  END IF;
  SELECT * INTO parent FROM public.document_folders WHERE id = NEW.parent_folder_id;
  IF parent.location_id IS DISTINCT FROM NEW.location_id
     OR parent.job_id IS DISTINCT FROM NEW.job_id
     OR parent.account_id IS DISTINCT FROM NEW.account_id
     OR parent.project_id IS DISTINCT FROM NEW.project_id THEN
    RAISE EXCEPTION 'Parent folder belongs to a different record.';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_document_folder_parent ON public.document_folders;
CREATE TRIGGER trg_document_folder_parent
BEFORE INSERT OR UPDATE ON public.document_folders
FOR EACH ROW EXECUTE FUNCTION public.check_document_folder_parent();

-- SET NULL, never CASCADE: deleting a folder must never delete claim evidence.
ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS folder_id uuid
  REFERENCES public.document_folders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS documents_folder_idx ON public.documents (folder_id);
