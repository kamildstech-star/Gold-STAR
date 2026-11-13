-- ============================================================ helpers
CREATE OR REPLACE FUNCTION public.is_sales_leadership(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE user_id = _user_id
       AND role::text IN ('owner','admin','dev','sales_head','sales_manager')
  );
$$;

CREATE OR REPLACE FUNCTION public.is_rep_only(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id)
     AND NOT EXISTS (
       SELECT 1 FROM public.user_roles
        WHERE user_id = _user_id
          AND role::text NOT IN ('sales_person','outside_sales_rep','cold_caller',
                                 'sales_rep','field_chaser','field','crew')
     );
$$;

CREATE OR REPLACE FUNCTION public.can_export(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE user_id = _user_id AND role::text IN ('owner','sales_head','admin','dev')
  );
$$;

-- ============================================================ pipelines
ALTER TABLE public.pipelines
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'other';

ALTER TABLE public.pipeline_stages
  ADD COLUMN IF NOT EXISTS is_computed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_intake boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_exit boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS requires_reason boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS description text;

UPDATE public.pipelines SET is_default = false, is_active = false
 WHERE id = '11111111-1111-4111-8111-111111111111';

INSERT INTO public.pipelines (id, name, entity_type, location_id, is_default, is_active, kind)
VALUES
  ('22222222-2222-4222-8222-222222222222','Prospecting','account',NULL,true,true,'prospecting'),
  ('33333333-3333-4333-8333-333333333333','Client Health','account',NULL,false,true,'client_health')
ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name, kind = EXCLUDED.kind,
      is_default = EXCLUDED.is_default, is_active = true;

INSERT INTO public.pipeline_stages
  (pipeline_id, key, name, sort_order, color, probability, is_won, is_lost,
   is_computed, is_intake, is_exit, requires_reason, description)
VALUES
  ('22222222-2222-4222-8222-222222222222','leads','Leads',10,'#10243D',5,false,false,false,true,false,false,'Sales Head stage — incoming leads land here and are assigned out.'),
  ('22222222-2222-4222-8222-222222222222','new_lead_input','New Lead Input',20,'#B8A030',10,false,false,false,false,false,false,'Rep-entered. Workable immediately; Sales Head must approve within 7 days or it escalates.'),
  ('22222222-2222-4222-8222-222222222222','ready','Ready',30,'#1B5FA8',20,false,false,false,false,false,false,'Researched and ready to work.'),
  ('22222222-2222-4222-8222-222222222222','active_outreach','Active Outreach',40,'#1B5FA8',40,false,false,false,false,false,false,'Calls, emails, drop-ins in progress.'),
  ('22222222-2222-4222-8222-222222222222','conversation_established','Conversation Established',50,'#2E8B57',65,false,false,false,false,false,false,'Two-way conversation with a decision maker.'),
  ('22222222-2222-4222-8222-222222222222','active_client','Active Client',60,'#2E8B57',100,true,false,false,false,true,false,'Exit — hands off to the Client Health pipeline.'),
  ('22222222-2222-4222-8222-222222222222','no_service_needed','No Service Needed',70,'#6B7280',0,false,true,false,false,true,true,'Exit — requires a reason code; supports a reactivation date.'),
  ('22222222-2222-4222-8222-222222222222','goasted','GOASTED',80,'#E81820',0,false,true,false,false,true,false,'No response. After 1 month the Sales Head is notified to reassign or close.'),
  ('33333333-3333-4333-8333-333333333333','healthy','Healthy',10,'#2E8B57',100,false,false,true,false,false,false,'On cadence, nothing overdue.'),
  ('33333333-3333-4333-8333-333333333333','needs_attention','Needs Attention',20,'#B8A030',100,false,false,true,false,false,false,'A task is 7+ days past due. Our lapse, not theirs.'),
  ('33333333-3333-4333-8333-333333333333','annual_meeting','Annual In-Person Meeting',30,'#1B5FA8',100,false,false,true,false,false,false,'From 2 weeks before the annual deadline to 2 weeks after.'),
  ('33333333-3333-4333-8333-333333333333','ghosted','Ghosted',40,'#E81820',0,false,false,true,false,false,false,'Computed, then confirmed by the rep. Returns to Healthy on any answered touch.')
ON CONFLICT (pipeline_id, key) DO UPDATE
  SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order, color = EXCLUDED.color,
      probability = EXCLUDED.probability, is_won = EXCLUDED.is_won, is_lost = EXCLUDED.is_lost,
      is_computed = EXCLUDED.is_computed, is_intake = EXCLUDED.is_intake,
      is_exit = EXCLUDED.is_exit, requires_reason = EXCLUDED.requires_reason,
      description = EXCLUDED.description, is_active = true;

-- ============================================================ accounts
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS approval_state text NOT NULL DEFAULT 'not_required',
  ADD COLUMN IF NOT EXISTS approval_due_on date,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_by uuid,
  ADD COLUMN IF NOT EXISTS no_service_reason_code text,
  ADD COLUMN IF NOT EXISTS reactivate_on date,
  ADD COLUMN IF NOT EXISTS goasted_at timestamptz,
  ADD COLUMN IF NOT EXISTS goasted_escalated_at timestamptz,
  ADD COLUMN IF NOT EXISTS health_pipeline_id uuid REFERENCES public.pipelines(id),
  ADD COLUMN IF NOT EXISTS health_stage_id uuid REFERENCES public.pipeline_stages(id),
  ADD COLUMN IF NOT EXISTS health_changed_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_in_person_at timestamptz,
  ADD COLUMN IF NOT EXISTS annual_meeting_due_on date,
  ADD COLUMN IF NOT EXISTS annual_meeting_missed_at timestamptz,
  ADD COLUMN IF NOT EXISTS ghost_confirmed_by uuid,
  ADD COLUMN IF NOT EXISTS ghost_confirmed_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_accounts_reactivate_on ON public.accounts(reactivate_on)
  WHERE reactivate_on IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_accounts_health_stage ON public.accounts(health_stage_id);

CREATE TABLE IF NOT EXISTS public.no_service_reasons (
  code text PRIMARY KEY,
  label text NOT NULL,
  sort_order int NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.no_service_reasons TO authenticated;
GRANT ALL ON public.no_service_reasons TO service_role;
ALTER TABLE public.no_service_reasons ENABLE ROW LEVEL SECURITY;
CREATE POLICY "reasons readable by signed-in users" ON public.no_service_reasons
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "leadership manages reasons" ON public.no_service_reasons
  FOR ALL TO authenticated
  USING (public.is_sales_leadership(auth.uid()))
  WITH CHECK (public.is_sales_leadership(auth.uid()));

INSERT INTO public.no_service_reasons (code, label, sort_order) VALUES
  ('has_vendor','Already has a restoration vendor',10),
  ('in_house','Handles restoration in house',20),
  ('too_small','Portfolio too small to warrant a vendor',30),
  ('out_of_area','Outside our service area',40),
  ('not_decision_maker','Contact is not a decision maker',50),
  ('budget','No budget / procurement freeze',60),
  ('do_not_contact','Asked not to be contacted',70),
  ('other','Other',99)
ON CONFLICT (code) DO NOTHING;

-- ============================================================ money events
DO $$ BEGIN
  CREATE TYPE public.money_event_type AS ENUM ('payment_received','commission_issued');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.money_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type public.money_event_type NOT NULL,
  job_id uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
  invoice_id uuid REFERENCES public.invoices(id) ON DELETE SET NULL,
  account_id uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  location_id uuid REFERENCES public.locations(id) ON DELETE SET NULL,
  rep_user_id uuid NOT NULL,
  -- The gap is deliberate: a payment_received event NEVER carries an amount.
  amount numeric,
  reference text,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT money_event_amount_rule CHECK (
    (event_type = 'payment_received' AND amount IS NULL)
    OR (event_type = 'commission_issued' AND amount IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_money_events_rep ON public.money_events(rep_user_id, created_at DESC);
GRANT SELECT, INSERT ON public.money_events TO authenticated;
GRANT ALL ON public.money_events TO service_role;
ALTER TABLE public.money_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "reps see their own money events" ON public.money_events
  FOR SELECT TO authenticated
  USING (rep_user_id = auth.uid() OR public.is_sales_leadership(auth.uid()));
CREATE POLICY "leadership records money events" ON public.money_events
  FOR INSERT TO authenticated
  WITH CHECK (public.is_sales_leadership(auth.uid()) AND created_by = auth.uid());

-- Notify the rep on both events. Payment carries no amount by design.
CREATE OR REPLACE FUNCTION public.tg_money_event_notify()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.notifications (user_id, kind, title, body, link, priority)
  VALUES (
    NEW.rep_user_id,
    'money_event',
    CASE WHEN NEW.event_type = 'payment_received'
         THEN 'Payment received — commission coming'
         ELSE 'Commission issued' END,
    CASE WHEN NEW.event_type = 'payment_received'
         THEN 'The office has logged payment on your job. Your commission is being processed.'
         ELSE 'Commission of ' || to_char(NEW.amount, 'FM$999,999,990.00') || ' has been issued.' END,
    CASE WHEN NEW.job_id IS NOT NULL THEN '/jobs/' || NEW.job_id::text ELSE '/notifications' END,
    'normal'
  );
  RETURN NEW;
END $$;

-- ============================================================ field permissions
CREATE TABLE IF NOT EXISTS public.field_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity text NOT NULL DEFAULT 'job',
  role public.app_role NOT NULL,
  field text NOT NULL,
  visible boolean NOT NULL DEFAULT true,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity, role, field)
);
GRANT SELECT ON public.field_permissions TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.field_permissions TO authenticated;
GRANT ALL ON public.field_permissions TO service_role;
ALTER TABLE public.field_permissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "field perms readable" ON public.field_permissions
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "leadership edits field perms" ON public.field_permissions
  FOR ALL TO authenticated
  USING (public.is_sales_leadership(auth.uid()))
  WITH CHECK (public.is_sales_leadership(auth.uid()));

-- Seed: everything visible, except money on rep-grade roles.
INSERT INTO public.field_permissions (entity, role, field, visible)
SELECT 'job', r.role, f.field,
       NOT (r.role::text IN ('sales_person','outside_sales_rep','cold_caller','sales_rep',
                             'field_chaser','field','crew')
            AND f.field IN ('estimated_amount','billed_amount','approved_amount',
                            'collected_amount','carrier_shortfall','uncollected','deductible'))
  FROM (SELECT unnest(enum_range(NULL::public.app_role)) AS role) r
  CROSS JOIN (SELECT column_name AS field FROM information_schema.columns
               WHERE table_schema='public' AND table_name='jobs') f
ON CONFLICT (entity, role, field) DO NOTHING;

-- Fields the caller may see, unioned across the roles they hold.
CREATE OR REPLACE FUNCTION public.visible_fields(_user_id uuid, _entity text DEFAULT 'job')
RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(array_agg(DISTINCT fp.field), ARRAY[]::text[])
    FROM public.field_permissions fp
   WHERE fp.entity = _entity
     AND fp.visible
     AND fp.role IN (SELECT role FROM public.user_roles WHERE user_id = _user_id);
$$;

-- Server-side enforcement: rows still obey RLS (SECURITY INVOKER),
-- and disallowed columns are stripped before they leave the database.
CREATE OR REPLACE FUNCTION public.jobs_scoped(_ids uuid[] DEFAULT NULL)
RETURNS TABLE(id uuid, data jsonb)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT j.id,
         (SELECT jsonb_object_agg(kv.key, kv.value)
            FROM jsonb_each(to_jsonb(j)) kv
           WHERE kv.key = ANY (public.visible_fields(auth.uid(), 'job')))
    FROM public.jobs j
   WHERE (_ids IS NULL OR j.id = ANY(_ids));
$$;

-- ============================================================ export audit
CREATE TABLE IF NOT EXISTS public.export_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  surface text NOT NULL,
  entity text NOT NULL,
  format text NOT NULL DEFAULT 'csv',
  record_count int NOT NULL DEFAULT 0,
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_export_audit_created ON public.export_audit(created_at DESC);
GRANT SELECT ON public.export_audit TO authenticated;
GRANT ALL ON public.export_audit TO service_role;
ALTER TABLE public.export_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY "leadership reviews exports" ON public.export_audit
  FOR SELECT TO authenticated USING (public.is_sales_leadership(auth.uid()));

-- The only way to export: authorises, records, and alerts the Owner on volume.
CREATE OR REPLACE FUNCTION public.log_export(
  _surface text, _entity text, _record_count int,
  _format text DEFAULT 'csv', _filters jsonb DEFAULT '{}'::jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid; v_name text; v_owner uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF NOT public.can_export(auth.uid()) THEN
    RAISE EXCEPTION 'Export is restricted to Sales Head and Owner';
  END IF;
  INSERT INTO public.export_audit (user_id, surface, entity, format, record_count, filters)
  VALUES (auth.uid(), _surface, _entity, _format, GREATEST(_record_count, 0), COALESCE(_filters,'{}'::jsonb))
  RETURNING id INTO v_id;

  IF _record_count >= 500 THEN
    SELECT COALESCE(full_name, email) INTO v_name FROM public.profiles WHERE user_id = auth.uid();
    FOR v_owner IN SELECT user_id FROM public.user_roles WHERE role::text = 'owner' LOOP
      INSERT INTO public.notifications (user_id, kind, title, body, link, priority)
      VALUES (v_owner, 'export_alert', 'Large export',
              COALESCE(v_name,'A user') || ' exported ' || _record_count || ' ' || _entity || ' records from ' || _surface || '.',
              '/admin/exports', 'high');
    END LOOP;
  END IF;
  RETURN v_id;
END $$;
REVOKE EXECUTE ON FUNCTION public.log_export(text,text,int,text,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.log_export(text,text,int,text,jsonb) TO authenticated;

-- ============================================================ contacts: relationship fields
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS birthday_year smallint,
  ADD COLUMN IF NOT EXISTS spouse_name text,
  ADD COLUMN IF NOT EXISTS children text,
  ADD COLUMN IF NOT EXISTS family_notes text,
  ADD COLUMN IF NOT EXISTS personal_preferences text,
  ADD COLUMN IF NOT EXISTS likes text,
  ADD COLUMN IF NOT EXISTS dislikes text,
  ADD COLUMN IF NOT EXISTS hobbies text,
  ADD COLUMN IF NOT EXISTS sports_teams text,
  ADD COLUMN IF NOT EXISTS dietary_notes text,
  ADD COLUMN IF NOT EXISTS anniversary_month smallint,
  ADD COLUMN IF NOT EXISTS anniversary_day smallint,
  ADD COLUMN IF NOT EXISTS preferred_contact_method text,
  ADD COLUMN IF NOT EXISTS best_time_to_reach text,
  ADD COLUMN IF NOT EXISTS relationship_notes text;

-- ============================================================ per-user prefs
CREATE TABLE IF NOT EXISTS public.user_day_mode (
  user_id uuid NOT NULL,
  day date NOT NULL DEFAULT CURRENT_DATE,
  mode text NOT NULL DEFAULT 'inside',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day),
  CONSTRAINT day_mode_valid CHECK (mode IN ('inside','road'))
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_day_mode TO authenticated;
GRANT ALL ON public.user_day_mode TO service_role;
ALTER TABLE public.user_day_mode ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own day mode" ON public.user_day_mode
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE TABLE IF NOT EXISTS public.user_view_prefs (
  user_id uuid NOT NULL,
  scope text NOT NULL,
  view_mode text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, scope)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_view_prefs TO authenticated;
GRANT ALL ON public.user_view_prefs TO service_role;
ALTER TABLE public.user_view_prefs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own view prefs" ON public.user_view_prefs
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- ============================================================ reporting list
CREATE OR REPLACE FUNCTION public.list_business_reps()
 RETURNS TABLE(user_id uuid, full_name text, email text, roles app_role[])
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT p.user_id, p.full_name, p.email,
         COALESCE((SELECT array_agg(ur.role ORDER BY ur.role)
                     FROM public.user_roles ur WHERE ur.user_id = p.user_id),
                  ARRAY[]::public.app_role[]) AS roles
    FROM public.profiles p
   WHERE COALESCE(p.is_active, true)
     AND NOT public.is_staff_account(p.user_id)
     AND EXISTS (
       SELECT 1 FROM public.user_roles ur2
        WHERE ur2.user_id = p.user_id
          AND ur2.role::text IN (
            'sales_person','outside_sales_rep','cold_caller','sales_head',
            'sales_rep','sales_manager','location_manager','regional',
            'field_chaser','field','crew','office')
     );
$function$;