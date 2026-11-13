
-- Enums
CREATE TYPE public.project_status AS ENUM ('active', 'archived');
CREATE TYPE public.project_member_role AS ENUM ('owner', 'collaborator');
CREATE TYPE public.photo_variant_kind AS ENUM ('display', 'thumb');
CREATE TYPE public.photo_access_actor_kind AS ENUM ('user', 'share_link');
CREATE TYPE public.photo_access_action AS ENUM ('view', 'download', 'download_original');
CREATE TYPE public.photo_storage_tier AS ENUM ('hot', 'cold');

-- =========================================================================
-- PROJECTS
-- =========================================================================
CREATE TABLE public.projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  address text NOT NULL,
  locality text,
  region text,
  postal_code text,
  lat double precision,
  lon double precision,
  geom geography(Point, 4326),
  loss_type public.job_loss_type NOT NULL,
  description text,
  location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE RESTRICT,
  account_id uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  job_id uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
  customer_name text,
  customer_phone text,
  customer_email text,
  overlay_settings jsonb NOT NULL DEFAULT '{"address":false,"uploader":false,"time":false,"gps":false}'::jsonb,
  status public.project_status NOT NULL DEFAULT 'active',
  archived_at timestamptz,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX projects_location_idx ON public.projects(location_id);
CREATE INDEX projects_account_idx ON public.projects(account_id);
CREATE INDEX projects_job_idx ON public.projects(job_id);
CREATE INDEX projects_status_idx ON public.projects(status);
CREATE INDEX projects_geom_idx ON public.projects USING GIST(geom);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.projects TO authenticated;
GRANT ALL ON public.projects TO service_role;
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;

-- PROJECT MEMBERS
CREATE TABLE public.project_members (
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  member_role public.project_member_role NOT NULL DEFAULT 'collaborator',
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX project_members_user_idx ON public.project_members(user_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.project_members TO authenticated;
GRANT ALL ON public.project_members TO service_role;
ALTER TABLE public.project_members ENABLE ROW LEVEL SECURITY;

-- PROJECT STARS
CREATE TABLE public.project_stars (
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  starred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);
GRANT SELECT, INSERT, DELETE ON public.project_stars TO authenticated;
GRANT ALL ON public.project_stars TO service_role;
ALTER TABLE public.project_stars ENABLE ROW LEVEL SECURITY;

-- PROJECT LABELS
CREATE TABLE public.project_labels (
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, label)
);
GRANT SELECT, INSERT, DELETE ON public.project_labels TO authenticated;
GRANT ALL ON public.project_labels TO service_role;
ALTER TABLE public.project_labels ENABLE ROW LEVEL SECURITY;

-- =========================================================================
-- PHOTOS
-- =========================================================================
CREATE TABLE public.photos (
  id text PRIMARY KEY,   -- client-generated ULID for idempotent finalize
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  uploader_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  storage_bucket text NOT NULL DEFAULT 'project-photos',
  storage_path_original text NOT NULL,
  mime text,
  size_bytes bigint,
  width integer,
  height integer,
  captured_at timestamptz,               -- true EXIF capture time
  upload_started_at timestamptz,
  upload_completed_at timestamptz,
  exif_lat double precision,
  exif_lon double precision,
  exif_geom geography(Point, 4326),
  exif_raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  storage_tier public.photo_storage_tier NOT NULL DEFAULT 'hot',
  deleted_at timestamptz,
  deleted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX photos_project_idx ON public.photos(project_id, captured_at DESC);
CREATE INDEX photos_uploader_idx ON public.photos(uploader_id);
CREATE INDEX photos_geom_idx ON public.photos USING GIST(exif_geom);
CREATE INDEX photos_active_idx ON public.photos(project_id) WHERE deleted_at IS NULL;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.photos TO authenticated;
GRANT ALL ON public.photos TO service_role;
ALTER TABLE public.photos ENABLE ROW LEVEL SECURITY;

-- PHOTO VARIANTS
CREATE TABLE public.photo_variants (
  photo_id text NOT NULL REFERENCES public.photos(id) ON DELETE CASCADE,
  variant public.photo_variant_kind NOT NULL,
  storage_path text NOT NULL,
  width integer,
  height integer,
  size_bytes bigint,
  generated_at timestamptz,
  error text,
  PRIMARY KEY (photo_id, variant)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.photo_variants TO authenticated;
GRANT ALL ON public.photo_variants TO service_role;
ALTER TABLE public.photo_variants ENABLE ROW LEVEL SECURITY;

-- PHOTO TAGS (reuses public.tags)
CREATE TABLE public.photo_tags (
  photo_id text NOT NULL REFERENCES public.photos(id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES public.tags(id) ON DELETE CASCADE,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (photo_id, tag_id)
);
GRANT SELECT, INSERT, DELETE ON public.photo_tags TO authenticated;
GRANT ALL ON public.photo_tags TO service_role;
ALTER TABLE public.photo_tags ENABLE ROW LEVEL SECURITY;

-- PHOTO ANNOTATIONS
CREATE TABLE public.photo_annotations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  photo_id text NOT NULL REFERENCES public.photos(id) ON DELETE CASCADE,
  author_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  annotation jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX photo_annotations_photo_idx ON public.photo_annotations(photo_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.photo_annotations TO authenticated;
GRANT ALL ON public.photo_annotations TO service_role;
ALTER TABLE public.photo_annotations ENABLE ROW LEVEL SECURITY;

-- PHOTO COMMENTS
CREATE TABLE public.photo_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  photo_id text NOT NULL REFERENCES public.photos(id) ON DELETE CASCADE,
  author_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  body text NOT NULL,
  reply_to_id uuid REFERENCES public.photo_comments(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX photo_comments_photo_idx ON public.photo_comments(photo_id, created_at);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.photo_comments TO authenticated;
GRANT ALL ON public.photo_comments TO service_role;
ALTER TABLE public.photo_comments ENABLE ROW LEVEL SECURITY;

-- PHOTO ACCESS LOG
CREATE TABLE public.photo_access_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  photo_id text REFERENCES public.photos(id) ON DELETE SET NULL,
  project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_kind public.photo_access_actor_kind NOT NULL,
  share_link_id uuid,
  action public.photo_access_action NOT NULL,
  ip inet,
  user_agent text,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX photo_access_log_photo_idx ON public.photo_access_log(photo_id, at DESC);
CREATE INDEX photo_access_log_project_idx ON public.photo_access_log(project_id, at DESC);
GRANT SELECT ON public.photo_access_log TO authenticated;
GRANT ALL ON public.photo_access_log TO service_role;
ALTER TABLE public.photo_access_log ENABLE ROW LEVEL SECURITY;

-- =========================================================================
-- Access helper: can_view_project
-- =========================================================================
CREATE OR REPLACE FUNCTION public.can_view_project(_user_id uuid, _project_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.projects p
    WHERE p.id = _project_id
      AND (
        -- admin / owner / dev: full access
        public.has_role(_user_id, 'admin')
        OR public.has_role(_user_id, 'owner')
        OR public.has_role(_user_id, 'dev')
        -- project members
        OR EXISTS (
          SELECT 1 FROM public.project_members pm
          WHERE pm.project_id = p.id AND pm.user_id = _user_id
        )
        -- office location managers
        OR EXISTS (
          SELECT 1 FROM public.location_members lm
          WHERE lm.location_id = p.location_id
            AND lm.user_id = _user_id
        )
        -- regional users whose region covers the office
        OR EXISTS (
          SELECT 1
          FROM public.region_members rm
          JOIN public.locations loc ON loc.region_id = rm.region_id
          WHERE loc.id = p.location_id AND rm.user_id = _user_id
        )
      )
  )
$$;

CREATE OR REPLACE FUNCTION public.can_manage_project(_user_id uuid, _project_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.projects p
    WHERE p.id = _project_id
      AND (
        public.has_role(_user_id, 'admin')
        OR public.has_role(_user_id, 'owner')
        OR public.has_role(_user_id, 'dev')
        OR EXISTS (
          SELECT 1 FROM public.project_members pm
          WHERE pm.project_id = p.id AND pm.user_id = _user_id
        )
        OR EXISTS (
          SELECT 1 FROM public.location_members lm
          WHERE lm.location_id = p.location_id AND lm.user_id = _user_id
            AND lm.role IN ('manager','office')
        )
      )
  )
$$;

-- =========================================================================
-- Triggers
-- =========================================================================
CREATE OR REPLACE FUNCTION public.trg_projects_set_geo()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.lat IS NOT NULL AND NEW.lon IS NOT NULL THEN
    NEW.geom := ST_SetSRID(ST_MakePoint(NEW.lon, NEW.lat), 4326)::geography;
  ELSE
    NEW.geom := NULL;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_projects_set_geo
BEFORE INSERT OR UPDATE ON public.projects
FOR EACH ROW EXECUTE FUNCTION public.trg_projects_set_geo();

CREATE OR REPLACE FUNCTION public.trg_photos_set_geo()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.exif_lat IS NOT NULL AND NEW.exif_lon IS NOT NULL THEN
    NEW.exif_geom := ST_SetSRID(ST_MakePoint(NEW.exif_lon, NEW.exif_lat), 4326)::geography;
  ELSE
    NEW.exif_geom := NULL;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_photos_set_geo
BEFORE INSERT OR UPDATE ON public.photos
FOR EACH ROW EXECUTE FUNCTION public.trg_photos_set_geo();

CREATE TRIGGER trg_photo_annotations_updated
BEFORE UPDATE ON public.photo_annotations
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER trg_photo_comments_updated
BEFORE UPDATE ON public.photo_comments
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =========================================================================
-- RLS POLICIES
-- =========================================================================

-- PROJECTS
CREATE POLICY "projects_select_visible"
ON public.projects FOR SELECT TO authenticated
USING (public.can_view_project(auth.uid(), id));

CREATE POLICY "projects_insert_member_of_location"
ON public.projects FOR INSERT TO authenticated
WITH CHECK (
  public.has_role(auth.uid(),'admin')
  OR public.has_role(auth.uid(),'owner')
  OR public.has_role(auth.uid(),'dev')
  OR EXISTS (
    SELECT 1 FROM public.location_members lm
    WHERE lm.location_id = projects.location_id AND lm.user_id = auth.uid()
  )
  OR EXISTS (
    SELECT 1 FROM public.region_members rm
    JOIN public.locations loc ON loc.region_id = rm.region_id
    WHERE loc.id = projects.location_id AND rm.user_id = auth.uid()
  )
);

CREATE POLICY "projects_update_manage"
ON public.projects FOR UPDATE TO authenticated
USING (public.can_manage_project(auth.uid(), id))
WITH CHECK (public.can_manage_project(auth.uid(), id));

CREATE POLICY "projects_delete_admin_owner"
ON public.projects FOR DELETE TO authenticated
USING (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'owner'));

-- PROJECT MEMBERS
CREATE POLICY "project_members_select_visible"
ON public.project_members FOR SELECT TO authenticated
USING (public.can_view_project(auth.uid(), project_id));

CREATE POLICY "project_members_write_manage"
ON public.project_members FOR ALL TO authenticated
USING (public.can_manage_project(auth.uid(), project_id))
WITH CHECK (public.can_manage_project(auth.uid(), project_id));

-- PROJECT STARS (self-only)
CREATE POLICY "project_stars_select_self"
ON public.project_stars FOR SELECT TO authenticated
USING (user_id = auth.uid());
CREATE POLICY "project_stars_insert_self_visible"
ON public.project_stars FOR INSERT TO authenticated
WITH CHECK (user_id = auth.uid() AND public.can_view_project(auth.uid(), project_id));
CREATE POLICY "project_stars_delete_self"
ON public.project_stars FOR DELETE TO authenticated
USING (user_id = auth.uid());

-- PROJECT LABELS
CREATE POLICY "project_labels_select_visible"
ON public.project_labels FOR SELECT TO authenticated
USING (public.can_view_project(auth.uid(), project_id));
CREATE POLICY "project_labels_write_manage"
ON public.project_labels FOR ALL TO authenticated
USING (public.can_manage_project(auth.uid(), project_id))
WITH CHECK (public.can_manage_project(auth.uid(), project_id));

-- PHOTOS
CREATE POLICY "photos_select_visible"
ON public.photos FOR SELECT TO authenticated
USING (public.can_view_project(auth.uid(), project_id));
CREATE POLICY "photos_insert_manage"
ON public.photos FOR INSERT TO authenticated
WITH CHECK (public.can_manage_project(auth.uid(), project_id));
CREATE POLICY "photos_update_manage"
ON public.photos FOR UPDATE TO authenticated
USING (public.can_manage_project(auth.uid(), project_id))
WITH CHECK (public.can_manage_project(auth.uid(), project_id));
-- No DELETE policy — deletion is soft (deleted_at) via UPDATE.

-- PHOTO VARIANTS
CREATE POLICY "photo_variants_select_visible"
ON public.photo_variants FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.photos p WHERE p.id = photo_id AND public.can_view_project(auth.uid(), p.project_id)));
CREATE POLICY "photo_variants_write_manage"
ON public.photo_variants FOR ALL TO authenticated
USING (EXISTS (SELECT 1 FROM public.photos p WHERE p.id = photo_id AND public.can_manage_project(auth.uid(), p.project_id)))
WITH CHECK (EXISTS (SELECT 1 FROM public.photos p WHERE p.id = photo_id AND public.can_manage_project(auth.uid(), p.project_id)));

-- PHOTO TAGS
CREATE POLICY "photo_tags_select_visible"
ON public.photo_tags FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.photos p WHERE p.id = photo_id AND public.can_view_project(auth.uid(), p.project_id)));
CREATE POLICY "photo_tags_write_manage"
ON public.photo_tags FOR ALL TO authenticated
USING (EXISTS (SELECT 1 FROM public.photos p WHERE p.id = photo_id AND public.can_manage_project(auth.uid(), p.project_id)))
WITH CHECK (EXISTS (SELECT 1 FROM public.photos p WHERE p.id = photo_id AND public.can_manage_project(auth.uid(), p.project_id)));

-- PHOTO ANNOTATIONS
CREATE POLICY "photo_annotations_select_visible"
ON public.photo_annotations FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.photos p WHERE p.id = photo_id AND public.can_view_project(auth.uid(), p.project_id)));
CREATE POLICY "photo_annotations_insert_manage"
ON public.photo_annotations FOR INSERT TO authenticated
WITH CHECK (
  author_id = auth.uid()
  AND EXISTS (SELECT 1 FROM public.photos p WHERE p.id = photo_id AND public.can_manage_project(auth.uid(), p.project_id))
);
CREATE POLICY "photo_annotations_update_author_or_admin"
ON public.photo_annotations FOR UPDATE TO authenticated
USING (author_id = auth.uid() OR public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'owner'))
WITH CHECK (author_id = auth.uid() OR public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'owner'));
CREATE POLICY "photo_annotations_delete_author_or_admin"
ON public.photo_annotations FOR DELETE TO authenticated
USING (author_id = auth.uid() OR public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'owner'));

-- PHOTO COMMENTS
CREATE POLICY "photo_comments_select_visible"
ON public.photo_comments FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.photos p WHERE p.id = photo_id AND public.can_view_project(auth.uid(), p.project_id)));
CREATE POLICY "photo_comments_insert_visible"
ON public.photo_comments FOR INSERT TO authenticated
WITH CHECK (
  author_id = auth.uid()
  AND EXISTS (SELECT 1 FROM public.photos p WHERE p.id = photo_id AND public.can_view_project(auth.uid(), p.project_id))
);
CREATE POLICY "photo_comments_update_author"
ON public.photo_comments FOR UPDATE TO authenticated
USING (author_id = auth.uid())
WITH CHECK (author_id = auth.uid());
-- No hard delete; deleted_at via update.

-- PHOTO ACCESS LOG
CREATE POLICY "photo_access_log_select_manager"
ON public.photo_access_log FOR SELECT TO authenticated
USING (
  project_id IS NULL
  OR public.can_manage_project(auth.uid(), project_id)
);
-- No INSERT/UPDATE/DELETE policies: only service_role writes access log rows.

-- =========================================================================
-- STORAGE OBJECT POLICIES (private buckets, project-scoped)
-- =========================================================================

-- project-photos
CREATE POLICY "project_photos_select_visible"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'project-photos'
  AND public.can_view_project(auth.uid(), ((storage.foldername(name))[1])::uuid)
);
CREATE POLICY "project_photos_insert_manage"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'project-photos'
  AND public.can_manage_project(auth.uid(), ((storage.foldername(name))[1])::uuid)
);
CREATE POLICY "project_photos_update_manage"
ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'project-photos'
  AND public.can_manage_project(auth.uid(), ((storage.foldername(name))[1])::uuid)
)
WITH CHECK (
  bucket_id = 'project-photos'
  AND public.can_manage_project(auth.uid(), ((storage.foldername(name))[1])::uuid)
);
CREATE POLICY "project_photos_delete_admin_owner"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'project-photos'
  AND (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'owner'))
);

-- project-documents
CREATE POLICY "project_documents_select_visible"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'project-documents'
  AND public.can_view_project(auth.uid(), ((storage.foldername(name))[1])::uuid)
);
CREATE POLICY "project_documents_insert_manage"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'project-documents'
  AND public.can_manage_project(auth.uid(), ((storage.foldername(name))[1])::uuid)
);
CREATE POLICY "project_documents_update_manage"
ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'project-documents'
  AND public.can_manage_project(auth.uid(), ((storage.foldername(name))[1])::uuid)
)
WITH CHECK (
  bucket_id = 'project-documents'
  AND public.can_manage_project(auth.uid(), ((storage.foldername(name))[1])::uuid)
);
CREATE POLICY "project_documents_delete_admin_owner"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'project-documents'
  AND (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'owner'))
);
