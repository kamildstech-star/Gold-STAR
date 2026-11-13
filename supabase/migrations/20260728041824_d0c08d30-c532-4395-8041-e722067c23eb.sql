-- ============================================================
-- PART 1: ROLE MODEL EXPANSION
-- ============================================================

ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'owner';
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'location_manager';
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'sales_manager';
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'sales_rep';
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'field_chaser';
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'crew';

-- Text-based role helpers avoid casting to newly-added enum values in the same tx.
CREATE OR REPLACE FUNCTION public.has_role_text(_user_id uuid, _role text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role::text = _role);
$$;

CREATE OR REPLACE FUNCTION public.has_any_role_text(_user_id uuid, _roles text[])
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role::text = ANY(_roles));
$$;

CREATE OR REPLACE FUNCTION public.is_privileged(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.has_any_role_text(_user_id, ARRAY['owner','admin']);
$$;

CREATE OR REPLACE FUNCTION public.can_view_location(_user_id uuid, _location_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT _location_id IS NOT NULL AND (
    public.is_privileged(_user_id)
    OR public.is_member_of(_user_id, _location_id)
    OR public.is_regional_for(_user_id, _location_id)
  );
$$;

CREATE OR REPLACE FUNCTION public.can_manage_location(_user_id uuid, _location_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT _location_id IS NOT NULL AND (
    public.is_privileged(_user_id)
    OR (public.is_member_of(_user_id, _location_id)
        AND public.has_any_role_text(_user_id, ARRAY['office','location_manager','sales_manager']))
    OR public.is_regional_for(_user_id, _location_id)
  );
$$;

GRANT EXECUTE ON FUNCTION public.has_role_text(uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_any_role_text(uuid,text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_privileged(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_view_location(uuid,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_manage_location(uuid,uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.update_updated_at_column() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

-- ============================================================
-- PART 2: REWORK EXISTING RLS TO USE THE NEW HELPERS
-- ============================================================

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT tablename, policyname FROM pg_policies WHERE schemaname='public'
    AND tablename IN ('accounts','contacts','touchpoints','fire_leads','contact_attempts',
                      'lead_notes','lead_tags','lead_stage_history','lead_events','tags')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.policyname, r.tablename);
  END LOOP;
END$$;

-- accounts
CREATE POLICY "accounts_select" ON public.accounts FOR SELECT TO authenticated
  USING (public.can_view_location(auth.uid(), location_id) OR assigned_rep = auth.uid());
CREATE POLICY "accounts_insert" ON public.accounts FOR INSERT TO authenticated
  WITH CHECK (public.can_manage_location(auth.uid(), location_id));
CREATE POLICY "accounts_update" ON public.accounts FOR UPDATE TO authenticated
  USING (public.can_manage_location(auth.uid(), location_id) OR assigned_rep = auth.uid())
  WITH CHECK (public.can_manage_location(auth.uid(), location_id) OR assigned_rep = auth.uid());
CREATE POLICY "accounts_delete" ON public.accounts FOR DELETE TO authenticated
  USING (public.is_privileged(auth.uid()));

-- contacts (inherit account)
CREATE POLICY "contacts_select" ON public.contacts FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = contacts.account_id
    AND (public.can_view_location(auth.uid(), a.location_id) OR a.assigned_rep = auth.uid()))
);
CREATE POLICY "contacts_write" ON public.contacts FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = contacts.account_id
    AND (public.can_manage_location(auth.uid(), a.location_id) OR a.assigned_rep = auth.uid())))
  WITH CHECK (EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = contacts.account_id
    AND (public.can_manage_location(auth.uid(), a.location_id) OR a.assigned_rep = auth.uid())));

-- touchpoints (inherit account)
CREATE POLICY "touchpoints_select" ON public.touchpoints FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = touchpoints.account_id
    AND (public.can_view_location(auth.uid(), a.location_id) OR a.assigned_rep = auth.uid()))
);
CREATE POLICY "touchpoints_insert" ON public.touchpoints FOR INSERT TO authenticated WITH CHECK (
  created_by = auth.uid() AND
  EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = touchpoints.account_id
    AND (public.can_view_location(auth.uid(), a.location_id) OR a.assigned_rep = auth.uid()))
);
CREATE POLICY "touchpoints_update" ON public.touchpoints FOR UPDATE TO authenticated
  USING (created_by = auth.uid() OR public.is_privileged(auth.uid()))
  WITH CHECK (created_by = auth.uid() OR public.is_privileged(auth.uid()));
CREATE POLICY "touchpoints_delete" ON public.touchpoints FOR DELETE TO authenticated
  USING (created_by = auth.uid() OR public.is_privileged(auth.uid()));

-- fire_leads
CREATE POLICY "fire_leads_admin_all" ON public.fire_leads FOR ALL TO authenticated
  USING (public.is_privileged(auth.uid())) WITH CHECK (public.is_privileged(auth.uid()));
CREATE POLICY "fire_leads_select" ON public.fire_leads FOR SELECT TO authenticated USING (
  public.can_view_location(auth.uid(), location_id)
  OR assigned_rep = auth.uid()
  OR (public.has_role_text(auth.uid(),'field_chaser') AND public.is_lead_visible_to_field(auth.uid(), id))
);
CREATE POLICY "fire_leads_update" ON public.fire_leads FOR UPDATE TO authenticated
  USING (public.can_manage_location(auth.uid(), location_id) OR assigned_rep = auth.uid())
  WITH CHECK (public.can_manage_location(auth.uid(), location_id) OR assigned_rep = auth.uid());

CREATE OR REPLACE FUNCTION public.can_view_lead(_user_id uuid, _lead_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS(SELECT 1 FROM public.fire_leads l WHERE l.id = _lead_id AND (
    public.is_privileged(_user_id)
    OR public.can_view_location(_user_id, l.location_id)
    OR l.assigned_rep = _user_id
    OR (public.has_role_text(_user_id,'field_chaser') AND public.is_lead_visible_to_field(_user_id, l.id))
  ));
$$;
GRANT EXECUTE ON FUNCTION public.can_view_lead(uuid,uuid) TO authenticated;

-- lead siblings
CREATE POLICY "contact_attempts_select" ON public.contact_attempts FOR SELECT TO authenticated
  USING (public.can_view_lead(auth.uid(), lead_id));
CREATE POLICY "contact_attempts_insert" ON public.contact_attempts FOR INSERT TO authenticated
  WITH CHECK (author_id = auth.uid() AND public.can_view_lead(auth.uid(), lead_id));
CREATE POLICY "contact_attempts_update" ON public.contact_attempts FOR UPDATE TO authenticated
  USING (author_id = auth.uid() OR public.is_privileged(auth.uid()))
  WITH CHECK (author_id = auth.uid() OR public.is_privileged(auth.uid()));
CREATE POLICY "contact_attempts_delete" ON public.contact_attempts FOR DELETE TO authenticated
  USING (author_id = auth.uid() OR public.is_privileged(auth.uid()));

CREATE POLICY "lead_notes_select" ON public.lead_notes FOR SELECT TO authenticated
  USING (public.can_view_lead(auth.uid(), lead_id));
CREATE POLICY "lead_notes_insert" ON public.lead_notes FOR INSERT TO authenticated
  WITH CHECK (author_id = auth.uid() AND public.can_view_lead(auth.uid(), lead_id));
CREATE POLICY "lead_notes_update" ON public.lead_notes FOR UPDATE TO authenticated
  USING (author_id = auth.uid() OR public.is_privileged(auth.uid()))
  WITH CHECK (author_id = auth.uid() OR public.is_privileged(auth.uid()));
CREATE POLICY "lead_notes_delete" ON public.lead_notes FOR DELETE TO authenticated
  USING (author_id = auth.uid() OR public.is_privileged(auth.uid()));

CREATE POLICY "lead_tags_select" ON public.lead_tags FOR SELECT TO authenticated
  USING (public.can_view_lead(auth.uid(), lead_id));
CREATE POLICY "lead_tags_write" ON public.lead_tags FOR ALL TO authenticated
  USING (public.can_view_lead(auth.uid(), lead_id))
  WITH CHECK (public.can_view_lead(auth.uid(), lead_id));

CREATE POLICY "lead_stage_history_select" ON public.lead_stage_history FOR SELECT TO authenticated
  USING (public.can_view_lead(auth.uid(), lead_id));
CREATE POLICY "lead_events_select" ON public.lead_events FOR SELECT TO authenticated
  USING (public.can_view_lead(auth.uid(), lead_id));

-- tags
CREATE POLICY "tags_select_all" ON public.tags FOR SELECT TO authenticated USING (true);
CREATE POLICY "tags_write_admin" ON public.tags FOR ALL TO authenticated
  USING (public.is_privileged(auth.uid())) WITH CHECK (public.is_privileged(auth.uid()));

-- ============================================================
-- PART 3: JOBS SPINE
-- ============================================================

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='job_loss_type') THEN
    CREATE TYPE public.job_loss_type AS ENUM ('water','fire','smoke','mold','biohazard','storm','cleaning');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='job_status') THEN
    CREATE TYPE public.job_status AS ENUM ('new','scheduled','in_progress','drying','complete','invoiced','paid','cancelled');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='job_assignment_role') THEN
    CREATE TYPE public.job_assignment_role AS ENUM ('crew_chief','technician');
  END IF;
END $$;

CREATE SEQUENCE IF NOT EXISTS public.jobs_number_seq;

CREATE TABLE public.jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_number text NOT NULL UNIQUE,
  account_id uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  fire_lead_id uuid REFERENCES public.fire_leads(id) ON DELETE SET NULL,
  location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE RESTRICT,
  address text NOT NULL,
  locality text,
  region text,
  postal_code text,
  lat double precision,
  lon double precision,
  geom geography(Point,4326),
  loss_type public.job_loss_type NOT NULL,
  status public.job_status NOT NULL DEFAULT 'new',
  loss_date date,
  first_response_at timestamptz,
  start_date date,
  completion_date date,
  crew_chief uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  insurance_carrier text,
  claim_number text,
  adjuster_name text,
  adjuster_email text,
  adjuster_phone text,
  estimated_amount numeric(12,2),
  billed_amount numeric(12,2),
  collected_amount numeric(12,2),
  scope text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_location_idx ON public.jobs(location_id);
CREATE INDEX jobs_status_idx ON public.jobs(status);
CREATE INDEX jobs_loss_type_idx ON public.jobs(loss_type);
CREATE INDEX jobs_account_idx ON public.jobs(account_id);
CREATE INDEX jobs_fire_lead_idx ON public.jobs(fire_lead_id);
CREATE INDEX jobs_crew_chief_idx ON public.jobs(crew_chief);
CREATE INDEX jobs_geom_gist ON public.jobs USING GIST(geom);
CREATE INDEX jobs_created_at_idx ON public.jobs(created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.jobs TO authenticated;
GRANT ALL ON public.jobs TO service_role;
GRANT USAGE ON SEQUENCE public.jobs_number_seq TO authenticated, service_role;

ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.jobs_before_write() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' AND (NEW.job_number IS NULL OR NEW.job_number = '') THEN
    NEW.job_number := 'GS-' || to_char(now(),'YYYY') || '-' || lpad(nextval('public.jobs_number_seq')::text, 5, '0');
  END IF;
  IF NEW.lat IS NOT NULL AND NEW.lon IS NOT NULL THEN
    NEW.geom := ST_SetSRID(ST_MakePoint(NEW.lon, NEW.lat), 4326)::geography;
  ELSE
    NEW.geom := NULL;
  END IF;
  IF TG_OP = 'UPDATE' THEN NEW.updated_at := now(); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_jobs_before_write BEFORE INSERT OR UPDATE ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.jobs_before_write();

-- job_assignments
CREATE TABLE public.job_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.job_assignment_role NOT NULL,
  start_date date,
  end_date date,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(job_id, user_id, role)
);
CREATE INDEX job_assignments_user_idx ON public.job_assignments(user_id);
CREATE INDEX job_assignments_job_idx ON public.job_assignments(job_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.job_assignments TO authenticated;
GRANT ALL ON public.job_assignments TO service_role;
ALTER TABLE public.job_assignments ENABLE ROW LEVEL SECURITY;

-- job_notes
CREATE TABLE public.job_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  author_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_notes_job_idx ON public.job_notes(job_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.job_notes TO authenticated;
GRANT ALL ON public.job_notes TO service_role;
ALTER TABLE public.job_notes ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER trg_job_notes_updated BEFORE UPDATE ON public.job_notes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- job_status_history
CREATE TABLE public.job_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  from_status public.job_status,
  to_status public.job_status NOT NULL,
  changed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_status_history_job_idx ON public.job_status_history(job_id);
GRANT SELECT, INSERT ON public.job_status_history TO authenticated;
GRANT ALL ON public.job_status_history TO service_role;
ALTER TABLE public.job_status_history ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.jobs_status_history_trg() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.job_status_history(job_id, from_status, to_status, changed_by)
      VALUES (NEW.id, NULL, NEW.status, auth.uid());
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO public.job_status_history(job_id, from_status, to_status, changed_by)
      VALUES (NEW.id, OLD.status, NEW.status, auth.uid());
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_jobs_status_history AFTER INSERT OR UPDATE OF status ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.jobs_status_history_trg();

-- Helpers
CREATE OR REPLACE FUNCTION public.can_view_job(_user_id uuid, _job_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = _job_id AND (
    public.is_privileged(_user_id)
    OR public.can_view_location(_user_id, j.location_id)
    OR j.crew_chief = _user_id
    OR EXISTS (SELECT 1 FROM public.job_assignments ja WHERE ja.job_id = j.id AND ja.user_id = _user_id)
  ));
$$;

CREATE OR REPLACE FUNCTION public.can_manage_job(_user_id uuid, _job_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = _job_id AND (
    public.is_privileged(_user_id)
    OR public.can_manage_location(_user_id, j.location_id)
    OR j.crew_chief = _user_id
  ));
$$;
GRANT EXECUTE ON FUNCTION public.can_view_job(uuid,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_manage_job(uuid,uuid) TO authenticated;

-- jobs policies
CREATE POLICY "jobs_select" ON public.jobs FOR SELECT TO authenticated USING (
  public.is_privileged(auth.uid())
  OR public.can_view_location(auth.uid(), location_id)
  OR crew_chief = auth.uid()
  OR EXISTS (SELECT 1 FROM public.job_assignments ja WHERE ja.job_id = jobs.id AND ja.user_id = auth.uid())
);
CREATE POLICY "jobs_insert" ON public.jobs FOR INSERT TO authenticated
  WITH CHECK (public.can_manage_location(auth.uid(), location_id));
CREATE POLICY "jobs_update" ON public.jobs FOR UPDATE TO authenticated
  USING (public.can_manage_location(auth.uid(), location_id) OR crew_chief = auth.uid())
  WITH CHECK (public.can_manage_location(auth.uid(), location_id) OR crew_chief = auth.uid());
CREATE POLICY "jobs_delete" ON public.jobs FOR DELETE TO authenticated
  USING (public.is_privileged(auth.uid()));

-- job_assignments policies
CREATE POLICY "job_assignments_select" ON public.job_assignments FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.can_view_job(auth.uid(), job_id));
CREATE POLICY "job_assignments_write" ON public.job_assignments FOR ALL TO authenticated
  USING (public.can_manage_job(auth.uid(), job_id))
  WITH CHECK (public.can_manage_job(auth.uid(), job_id));

-- job_notes policies
CREATE POLICY "job_notes_select" ON public.job_notes FOR SELECT TO authenticated
  USING (public.can_view_job(auth.uid(), job_id));
CREATE POLICY "job_notes_insert" ON public.job_notes FOR INSERT TO authenticated
  WITH CHECK (author_id = auth.uid() AND public.can_view_job(auth.uid(), job_id));
CREATE POLICY "job_notes_update" ON public.job_notes FOR UPDATE TO authenticated
  USING (author_id = auth.uid() OR public.is_privileged(auth.uid()))
  WITH CHECK (author_id = auth.uid() OR public.is_privileged(auth.uid()));
CREATE POLICY "job_notes_delete" ON public.job_notes FOR DELETE TO authenticated
  USING (author_id = auth.uid() OR public.is_privileged(auth.uid()));

-- job_status_history policy
CREATE POLICY "job_status_history_select" ON public.job_status_history FOR SELECT TO authenticated
  USING (public.can_view_job(auth.uid(), job_id));
