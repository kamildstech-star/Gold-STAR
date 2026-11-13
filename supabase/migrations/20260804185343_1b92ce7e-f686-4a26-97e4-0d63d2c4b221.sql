-- ============ enums ============
ALTER TYPE public.document_status ADD VALUE IF NOT EXISTS 'sent';
ALTER TYPE public.document_status ADD VALUE IF NOT EXISTS 'viewed';
ALTER TYPE public.document_status ADD VALUE IF NOT EXISTS 'declined';

ALTER TYPE public.document_type ADD VALUE IF NOT EXISTS 'service_agreement';
ALTER TYPE public.document_type ADD VALUE IF NOT EXISTS 'certificate_of_completion';
ALTER TYPE public.document_type ADD VALUE IF NOT EXISTS 'vendor_agreement';
ALTER TYPE public.document_type ADD VALUE IF NOT EXISTS 'direction_to_pay';
ALTER TYPE public.document_type ADD VALUE IF NOT EXISTS 'non_waiver';

DO $$ BEGIN
  CREATE TYPE public.time_entry_type AS ENUM ('labour','travel','standby');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.time_entry_status AS ENUM ('draft','submitted','approved','rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.document_event_type AS ENUM
    ('generated','sent','viewed','signed','declined','voided','reminded','downloaded','hash_mismatch');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============ document templates ============
CREATE TABLE public.document_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid REFERENCES public.locations(id) ON DELETE CASCADE,
  doc_type public.document_type NOT NULL,
  name text NOT NULL,
  description text,
  is_active boolean NOT NULL DEFAULT true,
  current_version integer NOT NULL DEFAULT 0,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.document_templates TO authenticated;
GRANT ALL ON public.document_templates TO service_role;
ALTER TABLE public.document_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "templates readable in scope" ON public.document_templates
FOR SELECT TO authenticated
USING (location_id IS NULL OR public.can_view_location(auth.uid(), location_id));

CREATE POLICY "managers create templates" ON public.document_templates
FOR INSERT TO authenticated
WITH CHECK (
  created_by = auth.uid() AND (
    public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'owner')
    OR public.has_role(auth.uid(),'dev')
    OR (location_id IS NOT NULL AND public.can_manage_location(auth.uid(), location_id))
  )
);

CREATE POLICY "managers update templates" ON public.document_templates
FOR UPDATE TO authenticated
USING (
  public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'owner')
  OR public.has_role(auth.uid(),'dev')
  OR (location_id IS NOT NULL AND public.can_manage_location(auth.uid(), location_id))
);

CREATE POLICY "admins delete templates" ON public.document_templates
FOR DELETE TO authenticated
USING (
  public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'owner')
  OR public.has_role(auth.uid(),'dev')
);

-- Versions are append-only: a contract must always resolve to the exact
-- wording it was generated from, so an UPDATE or DELETE here is a bug.
CREATE TABLE public.document_template_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES public.document_templates(id) ON DELETE CASCADE,
  version integer NOT NULL,
  body text NOT NULL,
  merge_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  change_note text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, version)
);
GRANT SELECT, INSERT ON public.document_template_versions TO authenticated;
GRANT ALL ON public.document_template_versions TO service_role;
ALTER TABLE public.document_template_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "template versions readable in scope" ON public.document_template_versions
FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.document_templates t
  WHERE t.id = template_id
    AND (t.location_id IS NULL OR public.can_view_location(auth.uid(), t.location_id))
));

CREATE POLICY "managers add template versions" ON public.document_template_versions
FOR INSERT TO authenticated
WITH CHECK (EXISTS (
  SELECT 1 FROM public.document_templates t
  WHERE t.id = template_id AND (
    public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'owner')
    OR public.has_role(auth.uid(),'dev')
    OR (t.location_id IS NOT NULL AND public.can_manage_location(auth.uid(), t.location_id))
  )
));

CREATE OR REPLACE FUNCTION public.forbid_template_version_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'Template versions are immutable. Publish a new version instead.';
END $$;

CREATE TRIGGER trg_template_versions_immutable
BEFORE UPDATE OR DELETE ON public.document_template_versions
FOR EACH ROW EXECUTE FUNCTION public.forbid_template_version_mutation();

-- Assign the next version number and keep the template pointer in step.
CREATE OR REPLACE FUNCTION public.assign_template_version()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE next_v integer;
BEGIN
  SELECT COALESCE(MAX(version),0) + 1 INTO next_v
  FROM public.document_template_versions WHERE template_id = NEW.template_id;
  NEW.version := next_v;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_template_version_number
BEFORE INSERT ON public.document_template_versions
FOR EACH ROW EXECUTE FUNCTION public.assign_template_version();

CREATE OR REPLACE FUNCTION public.bump_template_current_version()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  UPDATE public.document_templates
  SET current_version = NEW.version, updated_at = now()
  WHERE id = NEW.template_id;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_template_bump_version
AFTER INSERT ON public.document_template_versions
FOR EACH ROW EXECUTE FUNCTION public.bump_template_current_version();

CREATE TRIGGER update_document_templates_updated_at
BEFORE UPDATE ON public.document_templates
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============ documents: provenance, lifecycle, immutability ============
ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS template_id uuid REFERENCES public.document_templates(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS template_version_id uuid REFERENCES public.document_template_versions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rendered_body text,
  ADD COLUMN IF NOT EXISTS merge_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS content_hash text,
  ADD COLUMN IF NOT EXISTS locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS sent_to text,
  ADD COLUMN IF NOT EXISTS first_viewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS signed_at timestamptz,
  ADD COLUMN IF NOT EXISTS declined_at timestamptz,
  ADD COLUMN IF NOT EXISTS declined_reason text,
  ADD COLUMN IF NOT EXISTS voided_at timestamptz,
  ADD COLUMN IF NOT EXISTS voided_by uuid,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_reminder_at timestamptz,
  ADD COLUMN IF NOT EXISTS reminder_count integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS documents_job_idx ON public.documents(job_id);
CREATE INDEX IF NOT EXISTS documents_account_idx ON public.documents(account_id);
CREATE INDEX IF NOT EXISTS documents_status_idx ON public.documents(status);

-- Once signed, the evidence is frozen: content, provenance and file location
-- can never change. Only reminder/audit bookkeeping stays writable.
CREATE OR REPLACE FUNCTION public.enforce_document_immutability()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF OLD.locked_at IS NULL THEN RETURN NEW; END IF;
  IF NEW.rendered_body IS DISTINCT FROM OLD.rendered_body
     OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
     OR NEW.storage_path IS DISTINCT FROM OLD.storage_path
     OR NEW.storage_bucket IS DISTINCT FROM OLD.storage_bucket
     OR NEW.template_id IS DISTINCT FROM OLD.template_id
     OR NEW.template_version_id IS DISTINCT FROM OLD.template_version_id
     OR NEW.merge_data IS DISTINCT FROM OLD.merge_data
     OR NEW.signed_at IS DISTINCT FROM OLD.signed_at
     OR NEW.locked_at IS DISTINCT FROM OLD.locked_at THEN
    RAISE EXCEPTION 'This document is signed and locked. Void it and issue a new one.';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_documents_immutable
BEFORE UPDATE ON public.documents
FOR EACH ROW EXECUTE FUNCTION public.enforce_document_immutability();

CREATE TABLE public.document_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  event_type public.document_event_type NOT NULL,
  actor_id uuid,
  actor_label text,
  ip inet,
  user_agent text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.document_events TO authenticated;
GRANT ALL ON public.document_events TO service_role;
ALTER TABLE public.document_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "document events follow the document" ON public.document_events
FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.documents d
  WHERE d.id = document_id AND public.can_view_location(auth.uid(), d.location_id)
));

CREATE POLICY "log document events in scope" ON public.document_events
FOR INSERT TO authenticated
WITH CHECK (EXISTS (
  SELECT 1 FROM public.documents d
  WHERE d.id = document_id AND public.can_view_location(auth.uid(), d.location_id)
));

CREATE INDEX document_events_doc_idx ON public.document_events(document_id, created_at DESC);

-- ============ signatures ============
ALTER TABLE public.document_signatures
  ADD COLUMN IF NOT EXISTS ip inet,
  ADD COLUMN IF NOT EXISTS signature_data_url text,
  ADD COLUMN IF NOT EXISTS page_position jsonb;

-- ============ photo folders ============
CREATE TABLE public.photo_folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  parent_folder_id uuid REFERENCES public.photo_folders(id) ON DELETE CASCADE,
  name text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.photo_folders TO authenticated;
GRANT ALL ON public.photo_folders TO service_role;
ALTER TABLE public.photo_folders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "folders visible with project" ON public.photo_folders
FOR SELECT TO authenticated USING (public.can_view_project(auth.uid(), project_id));

CREATE POLICY "create folders in visible project" ON public.photo_folders
FOR INSERT TO authenticated
WITH CHECK (public.can_view_project(auth.uid(), project_id) AND created_by = auth.uid());

CREATE POLICY "update folders in visible project" ON public.photo_folders
FOR UPDATE TO authenticated USING (public.can_view_project(auth.uid(), project_id));

CREATE POLICY "managers delete folders" ON public.photo_folders
FOR DELETE TO authenticated USING (public.can_manage_project(auth.uid(), project_id));

CREATE INDEX photo_folders_project_idx ON public.photo_folders(project_id, parent_folder_id, sort_order);

CREATE TRIGGER update_photo_folders_updated_at
BEFORE UPDATE ON public.photo_folders
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.photos
  ADD COLUMN IF NOT EXISTS folder_id uuid REFERENCES public.photo_folders(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS photos_folder_idx ON public.photos(folder_id);

ALTER TABLE public.share_links
  ADD COLUMN IF NOT EXISTS folder_id uuid REFERENCES public.photo_folders(id) ON DELETE CASCADE;

-- A folder must belong to the same project as its parent, or the tree lies.
CREATE OR REPLACE FUNCTION public.check_photo_folder_parent()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE parent_project uuid;
BEGIN
  IF NEW.parent_folder_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.parent_folder_id = NEW.id THEN
    RAISE EXCEPTION 'A folder cannot be its own parent.';
  END IF;
  SELECT project_id INTO parent_project FROM public.photo_folders WHERE id = NEW.parent_folder_id;
  IF parent_project IS DISTINCT FROM NEW.project_id THEN
    RAISE EXCEPTION 'Parent folder belongs to a different project.';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_photo_folder_parent
BEFORE INSERT OR UPDATE ON public.photo_folders
FOR EACH ROW EXECUTE FUNCTION public.check_photo_folder_parent();

-- ============ labour: time entries ============
ALTER TABLE public.time_entries
  ADD COLUMN IF NOT EXISTS work_date date,
  ADD COLUMN IF NOT EXISTS entry_type public.time_entry_type NOT NULL DEFAULT 'labour',
  ADD COLUMN IF NOT EXISTS status public.time_entry_status NOT NULL DEFAULT 'submitted',
  ADD COLUMN IF NOT EXISTS entered_by uuid,
  ADD COLUMN IF NOT EXISTS approved_by uuid,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS rejected_reason text;

UPDATE public.time_entries SET work_date = (started_at AT TIME ZONE 'UTC')::date WHERE work_date IS NULL;

-- Derive work_date and minutes so every entry is countable, however entered.
CREATE OR REPLACE FUNCTION public.normalize_time_entry()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.work_date IS NULL THEN
    NEW.work_date := (NEW.started_at AT TIME ZONE 'UTC')::date;
  END IF;
  IF NEW.minutes IS NULL AND NEW.ended_at IS NOT NULL THEN
    NEW.minutes := GREATEST(0, ROUND(EXTRACT(EPOCH FROM (NEW.ended_at - NEW.started_at)) / 60)::int);
  END IF;
  IF NEW.entered_by IS NULL THEN NEW.entered_by := auth.uid(); END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_time_entries_normalize
BEFORE INSERT OR UPDATE ON public.time_entries
FOR EACH ROW EXECUTE FUNCTION public.normalize_time_entry();

CREATE INDEX IF NOT EXISTS time_entries_job_date_idx ON public.time_entries(job_id, work_date);
CREATE INDEX IF NOT EXISTS time_entries_user_date_idx ON public.time_entries(user_id, work_date);

CREATE TABLE public.time_entry_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  time_entry_id uuid NOT NULL REFERENCES public.time_entries(id) ON DELETE CASCADE,
  changed_by uuid,
  before_data jsonb NOT NULL,
  after_data jsonb NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.time_entry_corrections TO authenticated;
GRANT ALL ON public.time_entry_corrections TO service_role;
ALTER TABLE public.time_entry_corrections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "corrections visible to managers" ON public.time_entry_corrections
FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'owner')
  OR public.has_role(auth.uid(),'dev') OR public.has_role(auth.uid(),'regional')
  OR public.has_role(auth.uid(),'location_manager')
  OR EXISTS (SELECT 1 FROM public.time_entries te WHERE te.id = time_entry_id AND te.user_id = auth.uid())
);

CREATE POLICY "system records corrections" ON public.time_entry_corrections
FOR INSERT TO authenticated WITH CHECK (true);

-- Approved time is payroll evidence: record the change rather than lose it.
CREATE OR REPLACE FUNCTION public.audit_time_entry_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF OLD.status = 'approved' AND (
       NEW.minutes IS DISTINCT FROM OLD.minutes
    OR NEW.started_at IS DISTINCT FROM OLD.started_at
    OR NEW.ended_at IS DISTINCT FROM OLD.ended_at
    OR NEW.work_date IS DISTINCT FROM OLD.work_date
    OR NEW.job_id IS DISTINCT FROM OLD.job_id
    OR NEW.entry_type IS DISTINCT FROM OLD.entry_type
    OR NEW.status IS DISTINCT FROM OLD.status) THEN
    INSERT INTO public.time_entry_corrections (time_entry_id, changed_by, before_data, after_data)
    VALUES (OLD.id, auth.uid(), to_jsonb(OLD), to_jsonb(NEW));
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_time_entries_audit
BEFORE UPDATE ON public.time_entries
FOR EACH ROW EXECUTE FUNCTION public.audit_time_entry_change();

-- ============ labour rates ============
CREATE TABLE public.labour_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid REFERENCES public.locations(id) ON DELETE CASCADE,
  user_id uuid,
  role public.app_role,
  hourly_rate numeric(10,2) NOT NULL CHECK (hourly_rate >= 0),
  effective_from date NOT NULL,
  effective_to date,
  note text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT labour_rate_subject CHECK (user_id IS NOT NULL OR role IS NOT NULL)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.labour_rates TO authenticated;
GRANT ALL ON public.labour_rates TO service_role;
ALTER TABLE public.labour_rates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "rates visible to managers only" ON public.labour_rates
FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'owner')
  OR public.has_role(auth.uid(),'dev') OR public.has_role(auth.uid(),'regional')
  OR (location_id IS NOT NULL AND public.can_manage_location(auth.uid(), location_id))
);

CREATE POLICY "managers write rates" ON public.labour_rates
FOR ALL TO authenticated
USING (
  public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'owner')
  OR public.has_role(auth.uid(),'dev')
  OR (location_id IS NOT NULL AND public.can_manage_location(auth.uid(), location_id))
)
WITH CHECK (
  public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'owner')
  OR public.has_role(auth.uid(),'dev')
  OR (location_id IS NOT NULL AND public.can_manage_location(auth.uid(), location_id))
);

CREATE INDEX labour_rates_lookup_idx ON public.labour_rates(user_id, role, effective_from DESC);

CREATE TRIGGER update_labour_rates_updated_at
BEFORE UPDATE ON public.labour_rates
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- The rate that applied on the day the work happened — never today's rate.
CREATE OR REPLACE FUNCTION public.rate_for(_user_id uuid, _on date)
RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT rate FROM (
    SELECT lr.hourly_rate AS rate, 1 AS pref, lr.effective_from
    FROM public.labour_rates lr
    WHERE lr.user_id = _user_id
      AND lr.effective_from <= _on
      AND (lr.effective_to IS NULL OR lr.effective_to >= _on)
    UNION ALL
    SELECT lr.hourly_rate, 2, lr.effective_from
    FROM public.labour_rates lr
    JOIN public.user_roles ur ON ur.role = lr.role AND ur.user_id = _user_id
    WHERE lr.user_id IS NULL
      AND lr.effective_from <= _on
      AND (lr.effective_to IS NULL OR lr.effective_to >= _on)
  ) c
  ORDER BY pref, effective_from DESC
  LIMIT 1
$$;

-- ============ job labour + profitability roll-ups ============
CREATE OR REPLACE FUNCTION public.job_labour_summary(_job_id uuid)
RETURNS TABLE (
  total_minutes bigint,
  approved_minutes bigint,
  days_on_site integer,
  headcount integer,
  crew_days integer,
  labour_cost numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    COALESCE(SUM(te.minutes),0)::bigint,
    COALESCE(SUM(te.minutes) FILTER (WHERE te.status = 'approved'),0)::bigint,
    COUNT(DISTINCT te.work_date)::int,
    COUNT(DISTINCT te.user_id)::int,
    COALESCE(COUNT(DISTINCT (te.user_id::text || te.work_date::text)),0)::int,
    COALESCE(SUM((te.minutes::numeric / 60) * COALESCE(public.rate_for(te.user_id, te.work_date), 0)), 0)
  FROM public.time_entries te
  WHERE te.job_id = _job_id
    AND public.can_view_job(auth.uid(), _job_id)
$$;

CREATE OR REPLACE FUNCTION public.job_person_hours(_job_id uuid)
RETURNS TABLE (user_id uuid, full_name text, minutes bigint, days integer, cost numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT te.user_id,
         p.full_name,
         SUM(te.minutes)::bigint,
         COUNT(DISTINCT te.work_date)::int,
         SUM((te.minutes::numeric / 60) * COALESCE(public.rate_for(te.user_id, te.work_date), 0))
  FROM public.time_entries te
  LEFT JOIN public.profiles p ON p.user_id = te.user_id
  WHERE te.job_id = _job_id
    AND public.can_view_job(auth.uid(), _job_id)
  GROUP BY te.user_id, p.full_name
  ORDER BY 3 DESC
$$;


CREATE OR REPLACE FUNCTION public.job_profitability(_job_id uuid)
RETURNS TABLE (
  billed numeric,
  collected numeric,
  labour_cost numeric,
  equipment_days integer,
  total_minutes bigint,
  margin numeric,
  margin_pct numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH lab AS (SELECT * FROM public.job_labour_summary(_job_id)),
  inv AS (
    SELECT COALESCE(SUM(i.billed_amount),0) AS billed,
           COALESCE(SUM(i.collected_amount),0) AS collected
    FROM public.invoices i WHERE i.job_id = _job_id
  ),
  eq AS (
    SELECT COALESCE(SUM(
      GREATEST(1, CEIL(EXTRACT(EPOCH FROM (COALESCE(ep.retrieved_at, now()) - ep.placed_at)) / 86400))
    ),0)::int AS equipment_days
    FROM public.equipment_placements ep WHERE ep.job_id = _job_id
  )
  SELECT inv.billed, inv.collected, lab.labour_cost, eq.equipment_days, lab.total_minutes,
         inv.billed - lab.labour_cost,
         CASE WHEN inv.billed > 0
              THEN ROUND(((inv.billed - lab.labour_cost) / inv.billed) * 100, 1)
              ELSE NULL END
  FROM lab, inv, eq
  WHERE public.can_view_job(auth.uid(), _job_id)
$$;

-- Payroll and costing roll-ups
CREATE OR REPLACE FUNCTION public.hours_by_person_week(_from date, _to date)
RETURNS TABLE (user_id uuid, full_name text, week_start date, minutes bigint, approved_minutes bigint)
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT te.user_id, p.full_name,
         date_trunc('week', te.work_date)::date,
         SUM(te.minutes)::bigint,
         COALESCE(SUM(te.minutes) FILTER (WHERE te.status = 'approved'),0)::bigint
  FROM public.time_entries te
  LEFT JOIN public.profiles p ON p.user_id = te.user_id
  WHERE te.work_date BETWEEN _from AND _to
  GROUP BY 1,2,3
  ORDER BY 3 DESC, 4 DESC
$$;

CREATE OR REPLACE FUNCTION public.avg_hours_by_loss_type(_from date, _to date)
RETURNS TABLE (loss_type text, jobs integer, avg_minutes numeric, avg_days numeric)
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH per_job AS (
    SELECT j.id, j.loss_type::text AS loss_type,
           SUM(te.minutes) AS mins,
           COUNT(DISTINCT te.work_date) AS days
    FROM public.jobs j
    JOIN public.time_entries te ON te.job_id = j.id
    WHERE te.work_date BETWEEN _from AND _to
    GROUP BY j.id, j.loss_type
  )
  SELECT loss_type, COUNT(*)::int, ROUND(AVG(mins),0), ROUND(AVG(days),1)
  FROM per_job GROUP BY loss_type ORDER BY 2 DESC
$$;