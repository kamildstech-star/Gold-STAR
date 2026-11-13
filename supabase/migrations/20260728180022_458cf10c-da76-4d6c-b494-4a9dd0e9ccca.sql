
CREATE TYPE public.share_link_kind AS ENUM ('project', 'photo_set');

-- =========================================================================
-- PROJECT DOCUMENTS
-- =========================================================================
CREATE TABLE public.project_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  uploader_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  storage_bucket text NOT NULL DEFAULT 'project-documents',
  storage_path text NOT NULL,
  name text NOT NULL,
  mime text,
  size_bytes bigint,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX project_documents_project_idx ON public.project_documents(project_id, created_at DESC);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.project_documents TO authenticated;
GRANT ALL ON public.project_documents TO service_role;
ALTER TABLE public.project_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "project_documents_select_visible"
ON public.project_documents FOR SELECT TO authenticated
USING (public.can_view_project(auth.uid(), project_id));
CREATE POLICY "project_documents_write_manage"
ON public.project_documents FOR ALL TO authenticated
USING (public.can_manage_project(auth.uid(), project_id))
WITH CHECK (public.can_manage_project(auth.uid(), project_id));

-- =========================================================================
-- CHECKLISTS
-- =========================================================================
CREATE TABLE public.project_checklists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  title text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX project_checklists_project_idx ON public.project_checklists(project_id, position);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.project_checklists TO authenticated;
GRANT ALL ON public.project_checklists TO service_role;
ALTER TABLE public.project_checklists ENABLE ROW LEVEL SECURITY;

CREATE POLICY "project_checklists_select_visible"
ON public.project_checklists FOR SELECT TO authenticated
USING (public.can_view_project(auth.uid(), project_id));
CREATE POLICY "project_checklists_write_manage"
ON public.project_checklists FOR ALL TO authenticated
USING (public.can_manage_project(auth.uid(), project_id))
WITH CHECK (public.can_manage_project(auth.uid(), project_id));

CREATE TRIGGER trg_project_checklists_updated
BEFORE UPDATE ON public.project_checklists
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.project_checklist_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  checklist_id uuid NOT NULL REFERENCES public.project_checklists(id) ON DELETE CASCADE,
  body text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  done_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  done_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX project_checklist_items_list_idx ON public.project_checklist_items(checklist_id, position);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.project_checklist_items TO authenticated;
GRANT ALL ON public.project_checklist_items TO service_role;
ALTER TABLE public.project_checklist_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "project_checklist_items_select_visible"
ON public.project_checklist_items FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.project_checklists c
  WHERE c.id = checklist_id AND public.can_view_project(auth.uid(), c.project_id)
));
CREATE POLICY "project_checklist_items_write_manage"
ON public.project_checklist_items FOR ALL TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.project_checklists c
  WHERE c.id = checklist_id AND public.can_manage_project(auth.uid(), c.project_id)
))
WITH CHECK (EXISTS (
  SELECT 1 FROM public.project_checklists c
  WHERE c.id = checklist_id AND public.can_manage_project(auth.uid(), c.project_id)
));

CREATE TRIGGER trg_project_checklist_items_updated
BEFORE UPDATE ON public.project_checklist_items
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =========================================================================
-- SHARE LINKS
-- =========================================================================
CREATE TABLE public.share_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  kind public.share_link_kind NOT NULL,
  photo_ids text[],                  -- populated when kind = 'photo_set'
  token text NOT NULL UNIQUE,        -- 32-byte urlsafe random
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  allow_download_original boolean NOT NULL DEFAULT false,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX share_links_project_idx ON public.share_links(project_id, created_at DESC);
CREATE INDEX share_links_token_idx ON public.share_links(token) WHERE revoked_at IS NULL;
GRANT SELECT, INSERT, UPDATE ON public.share_links TO authenticated;
GRANT ALL ON public.share_links TO service_role;
ALTER TABLE public.share_links ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.trg_share_links_check_kind()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.kind = 'project' AND NEW.photo_ids IS NOT NULL AND array_length(NEW.photo_ids, 1) > 0 THEN
    RAISE EXCEPTION 'Project-kind share link must not carry photo_ids';
  END IF;
  IF NEW.kind = 'photo_set' AND (NEW.photo_ids IS NULL OR array_length(NEW.photo_ids, 1) = 0) THEN
    RAISE EXCEPTION 'Photo-set share link requires at least one photo id';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_share_links_check_kind
BEFORE INSERT OR UPDATE ON public.share_links
FOR EACH ROW EXECUTE FUNCTION public.trg_share_links_check_kind();

CREATE POLICY "share_links_select_manage"
ON public.share_links FOR SELECT TO authenticated
USING (public.can_manage_project(auth.uid(), project_id));
CREATE POLICY "share_links_insert_manage"
ON public.share_links FOR INSERT TO authenticated
WITH CHECK (public.can_manage_project(auth.uid(), project_id) AND created_by = auth.uid());
CREATE POLICY "share_links_update_revoke_manage"
ON public.share_links FOR UPDATE TO authenticated
USING (public.can_manage_project(auth.uid(), project_id))
WITH CHECK (public.can_manage_project(auth.uid(), project_id));

-- Add FK from photo_access_log.share_link_id (was left loose so migration A could land first)
ALTER TABLE public.photo_access_log
  ADD CONSTRAINT photo_access_log_share_link_fk
  FOREIGN KEY (share_link_id) REFERENCES public.share_links(id) ON DELETE SET NULL;
