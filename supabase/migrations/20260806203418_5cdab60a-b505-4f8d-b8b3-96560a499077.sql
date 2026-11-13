-- ============ app settings ============
CREATE TABLE IF NOT EXISTS public.app_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.profiles(user_id) ON DELETE SET NULL
);
GRANT SELECT ON public.app_settings TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.app_settings TO authenticated;
GRANT ALL ON public.app_settings TO service_role;
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS app_settings_select ON public.app_settings;
CREATE POLICY app_settings_select ON public.app_settings FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS app_settings_write ON public.app_settings;
CREATE POLICY app_settings_write ON public.app_settings FOR ALL TO authenticated
  USING (public.is_privileged(auth.uid())) WITH CHECK (public.is_privileged(auth.uid()));
CREATE TRIGGER touch_app_settings BEFORE UPDATE ON public.app_settings
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

INSERT INTO public.app_settings (key, value)
VALUES ('labels', '{"who_can_create":"privileged"}'::jsonb)
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.can_create_labels(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.is_privileged(_user_id)
     OR COALESCE((SELECT value->>'who_can_create' FROM public.app_settings WHERE key = 'labels'), 'privileged') = 'everyone';
$$;
REVOKE EXECUTE ON FUNCTION public.can_create_labels(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_create_labels(uuid) TO authenticated, service_role;

-- ============ tags ============
ALTER TABLE public.tags
  ALTER COLUMN color SET DEFAULT '#64748B',
  ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;
UPDATE public.tags SET color = '#64748B' WHERE color IS NULL;
ALTER TABLE public.tags ALTER COLUMN color SET NOT NULL;

DROP POLICY IF EXISTS tags_write_privileged ON public.tags;
CREATE POLICY tags_insert ON public.tags FOR INSERT TO authenticated
  WITH CHECK (public.can_create_labels(auth.uid()));
CREATE POLICY tags_update ON public.tags FOR UPDATE TO authenticated
  USING (public.can_create_labels(auth.uid())) WITH CHECK (public.can_create_labels(auth.uid()));
CREATE POLICY tags_delete ON public.tags FOR DELETE TO authenticated
  USING (public.is_privileged(auth.uid()));

-- ============ label link tables ============
CREATE TABLE IF NOT EXISTS public.account_tags (
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES public.tags(id) ON DELETE CASCADE,
  created_by uuid REFERENCES public.profiles(user_id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, tag_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.account_tags TO authenticated;
GRANT ALL ON public.account_tags TO service_role;
ALTER TABLE public.account_tags ENABLE ROW LEVEL SECURITY;
CREATE POLICY account_tags_select ON public.account_tags FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = account_id AND public.can_view_location(auth.uid(), a.location_id)));
CREATE POLICY account_tags_write ON public.account_tags FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = account_id AND public.can_view_location(auth.uid(), a.location_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = account_id AND public.can_view_location(auth.uid(), a.location_id)));

CREATE TABLE IF NOT EXISTS public.contact_tags (
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES public.tags(id) ON DELETE CASCADE,
  created_by uuid REFERENCES public.profiles(user_id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contact_id, tag_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.contact_tags TO authenticated;
GRANT ALL ON public.contact_tags TO service_role;
ALTER TABLE public.contact_tags ENABLE ROW LEVEL SECURITY;
CREATE POLICY contact_tags_select ON public.contact_tags FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.contacts c JOIN public.accounts a ON a.id = c.account_id
                 WHERE c.id = contact_id AND public.can_view_location(auth.uid(), a.location_id)));
CREATE POLICY contact_tags_write ON public.contact_tags FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.contacts c JOIN public.accounts a ON a.id = c.account_id
                 WHERE c.id = contact_id AND public.can_view_location(auth.uid(), a.location_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.contacts c JOIN public.accounts a ON a.id = c.account_id
                 WHERE c.id = contact_id AND public.can_view_location(auth.uid(), a.location_id)));

CREATE TABLE IF NOT EXISTS public.job_tags (
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES public.tags(id) ON DELETE CASCADE,
  created_by uuid REFERENCES public.profiles(user_id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, tag_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.job_tags TO authenticated;
GRANT ALL ON public.job_tags TO service_role;
ALTER TABLE public.job_tags ENABLE ROW LEVEL SECURITY;
CREATE POLICY job_tags_select ON public.job_tags FOR SELECT TO authenticated
  USING (public.can_view_job(auth.uid(), job_id));
CREATE POLICY job_tags_write ON public.job_tags FOR ALL TO authenticated
  USING (public.can_manage_job(auth.uid(), job_id)) WITH CHECK (public.can_manage_job(auth.uid(), job_id));

-- ============ leads inbox columns ============
ALTER TABLE public.fire_leads
  ADD COLUMN IF NOT EXISTS title text,
  ADD COLUMN IF NOT EXISTS org_name text,
  ADD COLUMN IF NOT EXISTS contact_name text,
  ADD COLUMN IF NOT EXISTS contact_email text,
  ADD COLUMN IF NOT EXISTS contact_phone text,
  ADD COLUMN IF NOT EXISTS value_amount numeric(12,2),
  ADD COLUMN IF NOT EXISTS expected_close_date date,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by uuid REFERENCES public.profiles(user_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES public.profiles(user_id) ON DELETE SET NULL;
ALTER TABLE public.fire_leads
  ALTER COLUMN source_system SET DEFAULT 'manual',
  ALTER COLUMN source_record_id SET DEFAULT gen_random_uuid()::text,
  ALTER COLUMN jurisdiction SET DEFAULT 'manual';
CREATE INDEX IF NOT EXISTS fire_leads_archived_idx ON public.fire_leads (archived_at);
CREATE INDEX IF NOT EXISTS tags_sort_idx ON public.tags (sort_order, name);

ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS archived_by uuid REFERENCES public.profiles(user_id) ON DELETE SET NULL;
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS archived_by uuid REFERENCES public.profiles(user_id) ON DELETE SET NULL;

-- ============ convert lead to opportunity ============
CREATE OR REPLACE FUNCTION public.convert_lead_to_opportunity(_lead_id uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _lead public.fire_leads%ROWTYPE;
  _uid uuid := auth.uid();
  _account_id uuid;
  _name text;
  _pipeline uuid;
BEGIN
  SELECT * INTO _lead FROM public.fire_leads WHERE id = _lead_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Lead not found'; END IF;
  IF NOT public.can_view_lead(_uid, _lead_id) THEN RAISE EXCEPTION 'Not permitted'; END IF;
  IF _lead.account_id IS NOT NULL THEN RETURN _lead.account_id; END IF;
  IF _lead.location_id IS NULL THEN RAISE EXCEPTION 'Lead has no location; assign one before converting'; END IF;

  _name := COALESCE(NULLIF(btrim(_lead.org_name), ''), NULLIF(btrim(_lead.title), ''),
                    NULLIF(btrim(_lead.owner_name), ''), NULLIF(btrim(_lead.address), ''), 'Untitled opportunity');
  _pipeline := public.default_pipeline_for(_lead.location_id, 'account');

  INSERT INTO public.accounts (name, location_id, assigned_rep, status, stage, pipeline_id,
                               estimated_annual_value, notes, created_by, is_demo)
  VALUES (_name, _lead.location_id, COALESCE(_lead.assigned_rep, _uid), 'prospect', 'target', _pipeline,
          _lead.value_amount, NULLIF(btrim(concat_ws(E'\n',
            CASE WHEN _lead.address IS NOT NULL THEN 'Property: ' || _lead.address END,
            CASE WHEN _lead.source_system <> 'manual' THEN 'Source: ' || _lead.source_system END)), ''),
          _uid, _lead.is_demo)
  RETURNING id INTO _account_id;

  IF COALESCE(btrim(_lead.contact_name), '') <> '' THEN
    INSERT INTO public.contacts (account_id, full_name, email, phone, is_primary, created_by, is_demo)
    VALUES (_account_id, _lead.contact_name, _lead.contact_email, _lead.contact_phone, true, _uid, _lead.is_demo);
  END IF;

  INSERT INTO public.account_tags (account_id, tag_id, created_by)
  SELECT _account_id, lt.tag_id, _uid FROM public.lead_tags lt WHERE lt.lead_id = _lead_id
  ON CONFLICT DO NOTHING;

  INSERT INTO public.account_notes (account_id, body, created_by, created_at, is_demo)
  SELECT _account_id, ln.body, ln.author_id, ln.created_at, ln.is_demo
  FROM public.lead_notes ln WHERE ln.lead_id = _lead_id;

  INSERT INTO public.account_notes (account_id, body, created_by, is_demo)
  SELECT _account_id,
         'Converted from lead' ||
         CASE WHEN _lead.source_system <> 'manual' THEN ' (' || _lead.source_system || ')' ELSE '' END ||
         CASE WHEN _lead.address IS NOT NULL THEN ' — ' || _lead.address ELSE '' END,
         _uid, _lead.is_demo;

  UPDATE public.fire_leads
     SET account_id = _account_id,
         pipeline_stage = 'converted'::pipeline_stage,
         stage_changed_at = now(),
         archived_at = COALESCE(archived_at, now()),
         archived_by = COALESCE(archived_by, _uid)
   WHERE id = _lead_id;

  RETURN _account_id;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.convert_lead_to_opportunity(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.convert_lead_to_opportunity(uuid) TO authenticated, service_role;