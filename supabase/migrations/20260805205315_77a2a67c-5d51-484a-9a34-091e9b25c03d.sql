-- Enums
CREATE TYPE public.feature_request_status AS ENUM ('new','reviewed','planned','in_progress','completed','dismissed');
CREATE TYPE public.feature_request_priority AS ENUM ('low','normal','high','urgent');
ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'feature_request_status';

-- Main table
CREATE TABLE public.feature_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  category text NOT NULL DEFAULT 'other',
  status public.feature_request_status NOT NULL DEFAULT 'new',
  priority public.feature_request_priority,
  submitted_by uuid REFERENCES public.profiles(user_id) ON DELETE SET NULL,
  -- point-in-time snapshot: roles and offices change, the request's context must not
  submitter_name text,
  submitter_role text,
  submitter_job_title text,
  submitter_location_id uuid REFERENCES public.locations(id) ON DELETE SET NULL,
  submitter_location_name text,
  dismissed_reason text,
  dismissed_at timestamptz,
  duplicate_of uuid REFERENCES public.feature_requests(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT feature_requests_not_self_duplicate CHECK (duplicate_of IS NULL OR duplicate_of <> id)
);
CREATE INDEX feature_requests_status_idx ON public.feature_requests (status, created_at DESC);
CREATE INDEX feature_requests_submitter_idx ON public.feature_requests (submitted_by);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.feature_requests TO authenticated;
GRANT ALL ON public.feature_requests TO service_role;
ALTER TABLE public.feature_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "feature_requests_select" ON public.feature_requests
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "feature_requests_insert" ON public.feature_requests
  FOR INSERT TO authenticated WITH CHECK (submitted_by = auth.uid());
CREATE POLICY "feature_requests_update_own_text" ON public.feature_requests
  FOR UPDATE TO authenticated USING (submitted_by = auth.uid()) WITH CHECK (submitted_by = auth.uid());
CREATE POLICY "feature_requests_admin_write" ON public.feature_requests
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'owner') OR public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'dev'))
  WITH CHECK (public.has_role(auth.uid(),'owner') OR public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'dev'));

CREATE TRIGGER trg_feature_requests_updated_at BEFORE UPDATE ON public.feature_requests
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Attachments
CREATE TABLE public.feature_request_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.feature_requests(id) ON DELETE CASCADE,
  storage_path text NOT NULL,
  display_path text,
  file_name text,
  mime_type text NOT NULL,
  byte_size integer,
  width integer,
  height integer,
  uploaded_by uuid REFERENCES public.profiles(user_id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX feature_request_attachments_request_idx ON public.feature_request_attachments (request_id, created_at);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.feature_request_attachments TO authenticated;
GRANT ALL ON public.feature_request_attachments TO service_role;
ALTER TABLE public.feature_request_attachments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "fr_attachments_select" ON public.feature_request_attachments
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "fr_attachments_insert" ON public.feature_request_attachments
  FOR INSERT TO authenticated WITH CHECK (uploaded_by = auth.uid());
CREATE POLICY "fr_attachments_delete" ON public.feature_request_attachments
  FOR DELETE TO authenticated USING (
    uploaded_by = auth.uid()
    OR public.has_role(auth.uid(),'owner') OR public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'dev'));

-- Votes
CREATE TABLE public.feature_request_votes (
  request_id uuid NOT NULL REFERENCES public.feature_requests(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(user_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, user_id)
);
GRANT SELECT, INSERT, DELETE ON public.feature_request_votes TO authenticated;
GRANT ALL ON public.feature_request_votes TO service_role;
ALTER TABLE public.feature_request_votes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "fr_votes_select" ON public.feature_request_votes
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "fr_votes_insert" ON public.feature_request_votes
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "fr_votes_delete" ON public.feature_request_votes
  FOR DELETE TO authenticated USING (user_id = auth.uid());

-- Comments
CREATE TABLE public.feature_request_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.feature_requests(id) ON DELETE CASCADE,
  author uuid REFERENCES public.profiles(user_id) ON DELETE SET NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX feature_request_comments_request_idx ON public.feature_request_comments (request_id, created_at);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.feature_request_comments TO authenticated;
GRANT ALL ON public.feature_request_comments TO service_role;
ALTER TABLE public.feature_request_comments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "fr_comments_select" ON public.feature_request_comments
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "fr_comments_insert" ON public.feature_request_comments
  FOR INSERT TO authenticated WITH CHECK (author = auth.uid());
CREATE POLICY "fr_comments_update" ON public.feature_request_comments
  FOR UPDATE TO authenticated USING (author = auth.uid()) WITH CHECK (author = auth.uid());
CREATE POLICY "fr_comments_delete" ON public.feature_request_comments
  FOR DELETE TO authenticated USING (
    author = auth.uid()
    OR public.has_role(auth.uid(),'owner') OR public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'dev'));

-- Status history
CREATE TABLE public.feature_request_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.feature_requests(id) ON DELETE CASCADE,
  from_status public.feature_request_status,
  to_status public.feature_request_status NOT NULL,
  note text,
  changed_by uuid REFERENCES public.profiles(user_id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fr_status_history_request_idx ON public.feature_request_status_history (request_id, created_at);
GRANT SELECT ON public.feature_request_status_history TO authenticated;
GRANT ALL ON public.feature_request_status_history TO service_role;
ALTER TABLE public.feature_request_status_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "fr_status_history_select" ON public.feature_request_status_history
  FOR SELECT TO authenticated USING (true);

-- Submitter snapshot at insert time
CREATE OR REPLACE FUNCTION public.feature_request_snapshot_submitter()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _loc uuid;
BEGIN
  IF NEW.submitted_by IS NULL THEN NEW.submitted_by := auth.uid(); END IF;

  IF NEW.submitter_name IS NULL THEN
    SELECT p.full_name INTO NEW.submitter_name FROM public.profiles p WHERE p.user_id = NEW.submitted_by;
  END IF;

  IF NEW.submitter_role IS NULL THEN
    SELECT ur.role::text INTO NEW.submitter_role
    FROM public.user_roles ur WHERE ur.user_id = NEW.submitted_by
    ORDER BY CASE ur.role::text
      WHEN 'owner' THEN 1 WHEN 'dev' THEN 2 WHEN 'admin' THEN 3 WHEN 'regional' THEN 4
      WHEN 'location_manager' THEN 5 WHEN 'sales_manager' THEN 6 WHEN 'sales_rep' THEN 7
      WHEN 'field_chaser' THEN 8 ELSE 9 END
    LIMIT 1;
  END IF;

  IF NEW.submitter_location_id IS NULL THEN
    SELECT lm.location_id INTO _loc
    FROM public.location_members lm WHERE lm.user_id = NEW.submitted_by
    ORDER BY lm.created_at NULLS LAST LIMIT 1;
    NEW.submitter_location_id := _loc;
  END IF;

  IF NEW.submitter_location_name IS NULL AND NEW.submitter_location_id IS NOT NULL THEN
    SELECT l.name INTO NEW.submitter_location_name FROM public.locations l WHERE l.id = NEW.submitter_location_id;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_feature_requests_snapshot BEFORE INSERT ON public.feature_requests
  FOR EACH ROW EXECUTE FUNCTION public.feature_request_snapshot_submitter();

-- Status change: history + notify submitter
CREATE OR REPLACE FUNCTION public.feature_request_on_status_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _label text;
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'dismissed' AND coalesce(btrim(NEW.dismissed_reason),'') = '' THEN
      RAISE EXCEPTION 'A dismissal reason is required';
    END IF;

    INSERT INTO public.feature_request_status_history (request_id, from_status, to_status, note, changed_by)
    VALUES (NEW.id, OLD.status, NEW.status, NEW.dismissed_reason, auth.uid());

    _label := replace(NEW.status::text, '_', ' ');

    IF NEW.submitted_by IS NOT NULL AND NEW.submitted_by <> coalesce(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid) THEN
      INSERT INTO public.notifications (user_id, type, title, body, entity_type, entity_id, href)
      VALUES (
        NEW.submitted_by,
        'feature_request_status',
        'Your request is now ' || _label,
        NEW.title || CASE WHEN NEW.status = 'dismissed' THEN ' — ' || coalesce(NEW.dismissed_reason,'') ELSE '' END,
        'feature_request',
        NEW.id,
        '/feature-requests?request=' || NEW.id::text
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_feature_requests_status AFTER UPDATE ON public.feature_requests
  FOR EACH ROW EXECUTE FUNCTION public.feature_request_on_status_change();

-- Managed category list
INSERT INTO public.option_lists (key, label, description)
VALUES ('feature_request_category', 'Feature request category', 'Categories on the internal feature request board')
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.option_list_values (list_id, key, label, sort_order)
SELECT ol.id, v.key, v.label, v.sort_order
FROM public.option_lists ol,
  (VALUES
    ('jobs','Jobs',10),('photos','Photos',20),('chat','Chat',30),('mobile_field','Mobile / Field',40),
    ('reporting','Reporting',50),('billing','Billing',60),('scheduling','Scheduling',70),
    ('equipment','Equipment',80),('integrations','Integrations',90),('bug','Bug',100),('other','Other',110)
  ) AS v(key,label,sort_order)
WHERE ol.key = 'feature_request_category'
ON CONFLICT DO NOTHING;

-- Storage policies (private bucket)
CREATE POLICY "feature_requests_objects_select" ON storage.objects
  FOR SELECT TO authenticated USING (bucket_id = 'feature-requests');
CREATE POLICY "feature_requests_objects_insert" ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (bucket_id = 'feature-requests' AND owner = auth.uid());
CREATE POLICY "feature_requests_objects_delete" ON storage.objects
  FOR DELETE TO authenticated USING (
    bucket_id = 'feature-requests' AND (
      owner = auth.uid()
      OR public.has_role(auth.uid(),'owner') OR public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'dev')));