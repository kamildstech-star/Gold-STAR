-- 1. assignment roles
ALTER TYPE public.job_assignment_role ADD VALUE IF NOT EXISTS 'lead_technician';
ALTER TYPE public.job_assignment_role ADD VALUE IF NOT EXISTS 'account_rep';
ALTER TYPE public.job_assignment_role ADD VALUE IF NOT EXISTS 'project_manager';
ALTER TYPE public.job_assignment_role ADD VALUE IF NOT EXISTS 'estimator';
ALTER TYPE public.job_assignment_role ADD VALUE IF NOT EXISTS 'collector';

-- 2. reported source managed list
CREATE TABLE IF NOT EXISTS public.reported_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  label text NOT NULL,
  is_referral boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.reported_sources TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.reported_sources TO authenticated;
GRANT ALL ON public.reported_sources TO service_role;
ALTER TABLE public.reported_sources ENABLE ROW LEVEL SECURITY;
CREATE POLICY "reported_sources_read" ON public.reported_sources
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "reported_sources_admin_write" ON public.reported_sources
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'owner') OR public.has_role(auth.uid(),'dev'))
  WITH CHECK (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'owner') OR public.has_role(auth.uid(),'dev'));
CREATE TRIGGER trg_reported_sources_updated_at BEFORE UPDATE ON public.reported_sources
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

INSERT INTO public.reported_sources (code, label, is_referral, sort_order) VALUES
  ('broker','Broker',true,10),
  ('adjuster','Adjuster',true,20),
  ('public_adjuster','Public adjuster',true,30),
  ('past_customer','Past customer',true,40),
  ('property_manager','Property manager',true,50),
  ('chase','Fire chase',false,60),
  ('web','Web',false,70),
  ('phone','Phone',false,80),
  ('walk_in','Walk-in',false,90),
  ('other','Other',false,100)
ON CONFLICT (code) DO NOTHING;

-- 3. jobs columns (all additive + nullable)
ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS job_name text,
  ADD COLUMN IF NOT EXISTS job_type text,
  ADD COLUMN IF NOT EXISTS customer_kind text CHECK (customer_kind IN ('person','company')),
  ADD COLUMN IF NOT EXISTS customer_name text,
  ADD COLUMN IF NOT EXISTS address_line2 text,
  ADD COLUMN IF NOT EXISTS county text,
  ADD COLUMN IF NOT EXISTS community text,
  ADD COLUMN IF NOT EXISTS reported_source_id uuid REFERENCES public.reported_sources(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS call_date date,
  ADD COLUMN IF NOT EXISTS call_time time,
  ADD COLUMN IF NOT EXISTS initial_loss_description text,
  ADD COLUMN IF NOT EXISTS deductible numeric,
  ADD COLUMN IF NOT EXISTS public_adjuster_name text,
  ADD COLUMN IF NOT EXISTS public_adjuster_email text,
  ADD COLUMN IF NOT EXISTS public_adjuster_phone text,
  ADD COLUMN IF NOT EXISTS insurance_agency text,
  ADD COLUMN IF NOT EXISTS insurance_agent_name text,
  ADD COLUMN IF NOT EXISTS insurance_agent_email text,
  ADD COLUMN IF NOT EXISTS insurance_agent_phone text,
  ADD COLUMN IF NOT EXISTS referred_by_account_id uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS referred_by_contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS referred_by_name text,
  ADD COLUMN IF NOT EXISTS third_party_company text,
  ADD COLUMN IF NOT EXISTS additional_work_pending boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS rehabbed_after_1978 boolean;

CREATE INDEX IF NOT EXISTS idx_jobs_reported_source ON public.jobs(reported_source_id);
CREATE INDEX IF NOT EXISTS idx_jobs_referred_by_account ON public.jobs(referred_by_account_id);

-- 4. multiple phones / emails per job
CREATE TABLE IF NOT EXISTS public.job_contact_methods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('phone','email')),
  label text,
  value text NOT NULL,
  extension text,
  is_preferred boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_job_contact_methods_job ON public.job_contact_methods(job_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.job_contact_methods TO authenticated;
GRANT ALL ON public.job_contact_methods TO service_role;
ALTER TABLE public.job_contact_methods ENABLE ROW LEVEL SECURITY;
CREATE POLICY "job_contact_methods_select" ON public.job_contact_methods
  FOR SELECT TO authenticated USING (public.can_view_job(auth.uid(), job_id));
CREATE POLICY "job_contact_methods_write" ON public.job_contact_methods
  FOR ALL TO authenticated
  USING (public.can_manage_job(auth.uid(), job_id))
  WITH CHECK (public.can_manage_job(auth.uid(), job_id));
CREATE TRIGGER trg_job_contact_methods_updated_at BEFORE UPDATE ON public.job_contact_methods
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 5. saved filter sets for the job list
CREATE TABLE IF NOT EXISTS public.job_saved_filters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.job_saved_filters TO authenticated;
GRANT ALL ON public.job_saved_filters TO service_role;
ALTER TABLE public.job_saved_filters ENABLE ROW LEVEL SECURITY;
CREATE POLICY "job_saved_filters_own" ON public.job_saved_filters
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE TRIGGER trg_job_saved_filters_updated_at BEFORE UPDATE ON public.job_saved_filters
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();