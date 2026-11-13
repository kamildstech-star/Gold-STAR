-- 1. sewer loss type
ALTER TYPE public.job_loss_type ADD VALUE IF NOT EXISTS 'sewer';

-- 2. Managed option lists
CREATE TABLE public.option_lists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  label text NOT NULL,
  description text,
  backed_by_enum text,
  allow_location_scope boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.option_lists TO authenticated;
GRANT ALL ON public.option_lists TO service_role;
ALTER TABLE public.option_lists ENABLE ROW LEVEL SECURITY;
CREATE POLICY "option_lists_select" ON public.option_lists FOR SELECT TO authenticated USING (true);
CREATE POLICY "option_lists_admin_write" ON public.option_lists FOR ALL TO authenticated
  USING (has_role(auth.uid(),'admin') OR has_role(auth.uid(),'owner') OR has_role(auth.uid(),'dev'))
  WITH CHECK (has_role(auth.uid(),'admin') OR has_role(auth.uid(),'owner') OR has_role(auth.uid(),'dev'));

CREATE TABLE public.option_list_values (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id uuid NOT NULL REFERENCES public.option_lists(id) ON DELETE CASCADE,
  key text NOT NULL,
  label text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  is_default boolean NOT NULL DEFAULT false,
  location_id uuid REFERENCES public.locations(id) ON DELETE CASCADE,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX option_list_values_unique_global
  ON public.option_list_values (list_id, key) WHERE location_id IS NULL;
CREATE UNIQUE INDEX option_list_values_unique_scoped
  ON public.option_list_values (list_id, key, location_id) WHERE location_id IS NOT NULL;
CREATE INDEX option_list_values_list_idx ON public.option_list_values (list_id, sort_order);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.option_list_values TO authenticated;
GRANT ALL ON public.option_list_values TO service_role;
ALTER TABLE public.option_list_values ENABLE ROW LEVEL SECURITY;
CREATE POLICY "option_list_values_select" ON public.option_list_values FOR SELECT TO authenticated USING (true);
CREATE POLICY "option_list_values_admin_write" ON public.option_list_values FOR ALL TO authenticated
  USING (has_role(auth.uid(),'admin') OR has_role(auth.uid(),'owner') OR has_role(auth.uid(),'dev'))
  WITH CHECK (has_role(auth.uid(),'admin') OR has_role(auth.uid(),'owner') OR has_role(auth.uid(),'dev'));

CREATE TRIGGER trg_option_lists_updated_at BEFORE UPDATE ON public.option_lists
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_option_list_values_updated_at BEFORE UPDATE ON public.option_list_values
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Seed lists
INSERT INTO public.option_lists (key, label, description, backed_by_enum, allow_location_scope) VALUES
  ('job_type','Job type','Category of work performed on a job.',NULL,true),
  ('loss_description','Loss description','Short cause-of-loss phrases offered on the job form.',NULL,true),
  ('job_status','Job status','Stage labels and ordering for jobs.','job_status',false),
  ('referral_source_type','Referral source type','Kind of party that referred the job.',NULL,false),
  ('contact_decision_role','Contact role','Role a contact plays at an account.','contact_decision_role',false),
  ('equipment_type','Equipment type','Equipment categories.','equipment_type',false),
  ('reported_source','Reported source','How a job first arrived.',NULL,false),
  ('job_contact_role','Job contact role','Role a related contact plays on a job.',NULL,false);

INSERT INTO public.option_list_values (list_id, key, label, sort_order)
SELECT l.id, v.key, v.label, v.ord FROM public.option_lists l
JOIN (VALUES
  ('Emergency Services','Emergency Services',10),
  ('Water Mitigation','Water Mitigation',20),
  ('Fire & Smoke Cleaning','Fire & Smoke Cleaning',30),
  ('Sewer / Category 3','Sewer / Category 3',40),
  ('Mold Remediation','Mold Remediation',50),
  ('Biohazard / Trauma','Biohazard / Trauma',60),
  ('Contents / Pack-Out','Contents / Pack-Out',70),
  ('Board-Up / Tarp','Board-Up / Tarp',80),
  ('Reconstruction','Reconstruction',90),
  ('General Cleaning','General Cleaning',100),
  ('Asbestos / Lead','Asbestos / Lead',110)
) AS v(key,label,ord) ON true WHERE l.key = 'job_type';

INSERT INTO public.option_list_values (list_id, key, label, sort_order)
SELECT l.id, v.key, v.label, v.ord FROM public.option_lists l
JOIN (VALUES
  ('broken_pipe','Broken pipe',10),
  ('frozen_pipe','Frozen pipe',20),
  ('flooded_basement','Flooded basement',30),
  ('roof_leak','Roof leak',40),
  ('appliance_overflow','Appliance overflow',50),
  ('sewer_backup','Sewer backup',60),
  ('kitchen_fire','Kitchen fire',70),
  ('electrical_fire','Electrical fire',80),
  ('smoke_damage','Smoke damage',90),
  ('mold_growth','Mold growth',100),
  ('storm_damage','Storm damage',110)
) AS v(key,label,ord) ON true WHERE l.key = 'loss_description';

INSERT INTO public.option_list_values (list_id, key, label, sort_order)
SELECT l.id, v.key, v.label, v.ord FROM public.option_lists l
JOIN (VALUES
  ('new','New',10),('scheduled','Scheduled',20),('in_progress','In progress',30),
  ('drying','Drying',40),('complete','Complete',50),('invoiced','Invoiced',60),
  ('paid','Paid',70),('cancelled','Cancelled',80)
) AS v(key,label,ord) ON true WHERE l.key = 'job_status';

INSERT INTO public.option_list_values (list_id, key, label, sort_order)
SELECT l.id, v.key, v.label, v.ord FROM public.option_lists l
JOIN (VALUES
  ('public_adjuster','Public adjuster',10),('broker','Broker / agent',20),
  ('salesperson','Salesperson',30),('property_manager','Property manager',40),
  ('past_customer','Past customer',50),('plumber','Plumber / trade',60),('other','Other',70)
) AS v(key,label,ord) ON true WHERE l.key = 'referral_source_type';

INSERT INTO public.option_list_values (list_id, key, label, sort_order)
SELECT l.id, v.key, v.label, v.ord FROM public.option_lists l
JOIN (VALUES
  ('decision_maker','Decision maker',10),('regional_manager','Regional manager',20),
  ('influencer','Influencer',30),('gatekeeper','Gatekeeper',40)
) AS v(key,label,ord) ON true WHERE l.key = 'contact_decision_role';

INSERT INTO public.option_list_values (list_id, key, label, sort_order)
SELECT l.id, v.key, v.label, v.ord FROM public.option_lists l
JOIN (VALUES
  ('insured','Insured / owner',10),('desk_adjuster','Desk adjuster',20),
  ('field_adjuster','Field adjuster',30),('public_adjuster','Public adjuster',40),
  ('referrer','Referrer',50),('property_manager','Property manager',60),
  ('tenant','Tenant',70),('back_office','Carrier back office',80),
  ('attorney','Attorney',90),('other','Other',100)
) AS v(key,label,ord) ON true WHERE l.key = 'job_contact_role';

INSERT INTO public.option_list_values (list_id, key, label, sort_order)
SELECT l.id, e.enumlabel, initcap(replace(e.enumlabel,'_',' ')), (e.enumsortorder*10)::int
FROM public.option_lists l
JOIN pg_type t ON t.typname = 'equipment_type'
JOIN pg_enum e ON e.enumtypid = t.oid
WHERE l.key = 'equipment_type';

INSERT INTO public.option_list_values (list_id, key, label, sort_order, active)
SELECT l.id, s.code, s.label, s.sort_order, s.active
FROM public.option_lists l, public.reported_sources s
WHERE l.key = 'reported_source';

-- 3. Configurable job numbering
CREATE TABLE public.job_number_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  prefix text NOT NULL DEFAULT '',
  pattern text NOT NULL DEFAULT '{YY}{MM}{DD}{SEQ}',
  seq_padding integer NOT NULL DEFAULT 1 CHECK (seq_padding BETWEEN 1 AND 8),
  seq_scope text NOT NULL DEFAULT 'daily' CHECK (seq_scope IN ('daily','monthly','yearly','global')),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.job_number_settings TO authenticated;
GRANT ALL ON public.job_number_settings TO service_role;
ALTER TABLE public.job_number_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "job_number_settings_select" ON public.job_number_settings FOR SELECT TO authenticated USING (true);
CREATE POLICY "job_number_settings_admin_write" ON public.job_number_settings FOR ALL TO authenticated
  USING (has_role(auth.uid(),'admin') OR has_role(auth.uid(),'owner') OR has_role(auth.uid(),'dev'))
  WITH CHECK (has_role(auth.uid(),'admin') OR has_role(auth.uid(),'owner') OR has_role(auth.uid(),'dev'));
INSERT INTO public.job_number_settings (id) VALUES (true);

CREATE TABLE public.job_number_counters (
  scope_key text PRIMARY KEY,
  last_value integer NOT NULL DEFAULT 0
);
GRANT SELECT ON public.job_number_counters TO authenticated;
GRANT ALL ON public.job_number_counters TO service_role;
ALTER TABLE public.job_number_counters ENABLE ROW LEVEL SECURITY;
CREATE POLICY "job_number_counters_select" ON public.job_number_counters FOR SELECT TO authenticated USING (true);

CREATE OR REPLACE FUNCTION public.next_job_number()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s public.job_number_settings%ROWTYPE;
  scope_key text;
  n integer;
  out_text text;
BEGIN
  SELECT * INTO s FROM public.job_number_settings WHERE id;
  IF NOT FOUND THEN
    RETURN 'GS-' || to_char(now(),'YYYY') || '-' || lpad(nextval('public.jobs_number_seq')::text, 5, '0');
  END IF;

  scope_key := CASE s.seq_scope
    WHEN 'daily' THEN to_char(now(),'YYYYMMDD')
    WHEN 'monthly' THEN to_char(now(),'YYYYMM')
    WHEN 'yearly' THEN to_char(now(),'YYYY')
    ELSE 'global' END;

  INSERT INTO public.job_number_counters (scope_key, last_value)
  VALUES (scope_key, 1)
  ON CONFLICT (scope_key) DO UPDATE SET last_value = public.job_number_counters.last_value + 1
  RETURNING last_value INTO n;

  out_text := s.pattern;
  out_text := replace(out_text, '{YYYY}', to_char(now(),'YYYY'));
  out_text := replace(out_text, '{YY}', to_char(now(),'YY'));
  out_text := replace(out_text, '{MM}', to_char(now(),'MM'));
  out_text := replace(out_text, '{DD}', to_char(now(),'DD'));
  out_text := replace(out_text, '{SEQ}', lpad(n::text, s.seq_padding, '0'));
  RETURN s.prefix || out_text;
END $$;

CREATE OR REPLACE FUNCTION public.jobs_before_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND (NEW.job_number IS NULL OR NEW.job_number = '') THEN
    NEW.job_number := public.next_job_number();
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.job_number IS DISTINCT FROM OLD.job_number THEN
    RAISE EXCEPTION 'job_number is immutable once assigned';
  END IF;
  IF NEW.lat IS NOT NULL AND NEW.lon IS NOT NULL THEN
    NEW.geom := ST_SetSRID(ST_MakePoint(NEW.lon, NEW.lat), 4326)::geography;
  ELSE
    NEW.geom := NULL;
  END IF;
  IF TG_OP = 'UPDATE' THEN NEW.updated_at := now(); END IF;
  RETURN NEW;
END $$;

-- 4. New job fields
ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS loss_description text,
  ADD COLUMN IF NOT EXISTS policy_number text,
  ADD COLUMN IF NOT EXISTS insurance_carrier_account_id uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS desk_adjuster_name text,
  ADD COLUMN IF NOT EXISTS desk_adjuster_email text,
  ADD COLUMN IF NOT EXISTS desk_adjuster_phone text,
  ADD COLUMN IF NOT EXISTS field_adjuster_name text,
  ADD COLUMN IF NOT EXISTS field_adjuster_email text,
  ADD COLUMN IF NOT EXISTS field_adjuster_phone text,
  ADD COLUMN IF NOT EXISTS public_adjuster_account_id uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS public_adjuster_contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS referral_source_type text,
  ADD COLUMN IF NOT EXISTS primary_contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS jobs_community_idx ON public.jobs (community);
CREATE INDEX IF NOT EXISTS jobs_job_number_search_idx ON public.jobs (lower(job_number));

-- 5. Related contacts on a job
CREATE TABLE public.job_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  account_id uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  role text NOT NULL DEFAULT 'other',
  full_name text,
  email text,
  phone text,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_contacts_job_idx ON public.job_contacts (job_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.job_contacts TO authenticated;
GRANT ALL ON public.job_contacts TO service_role;
ALTER TABLE public.job_contacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "job_contacts_select" ON public.job_contacts FOR SELECT TO authenticated
  USING (can_view_job(auth.uid(), job_id));
CREATE POLICY "job_contacts_write" ON public.job_contacts FOR ALL TO authenticated
  USING (can_manage_job(auth.uid(), job_id))
  WITH CHECK (can_manage_job(auth.uid(), job_id));
CREATE TRIGGER trg_job_contacts_updated_at BEFORE UPDATE ON public.job_contacts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();