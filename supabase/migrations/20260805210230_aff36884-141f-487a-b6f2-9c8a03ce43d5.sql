-- 1. Pipelines -------------------------------------------------------------
CREATE TABLE public.pipelines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  entity_type text NOT NULL DEFAULT 'account'
    CHECK (entity_type IN ('account','job','lead','incident')),
  location_id uuid REFERENCES public.locations(id) ON DELETE CASCADE,
  is_default boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES public.profiles(user_id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pipelines TO authenticated;
GRANT ALL ON public.pipelines TO service_role;
ALTER TABLE public.pipelines ENABLE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX pipelines_global_default_idx
  ON public.pipelines(entity_type) WHERE is_default AND location_id IS NULL;
CREATE UNIQUE INDEX pipelines_location_default_idx
  ON public.pipelines(entity_type, location_id) WHERE is_default AND location_id IS NOT NULL;

CREATE POLICY "pipelines_select" ON public.pipelines FOR SELECT TO authenticated USING (true);
CREATE POLICY "pipelines_write" ON public.pipelines FOR ALL TO authenticated
  USING (
    public.is_privileged(auth.uid())
    OR (location_id IS NOT NULL AND public.can_manage_location(auth.uid(), location_id))
  )
  WITH CHECK (
    public.is_privileged(auth.uid())
    OR (location_id IS NOT NULL AND public.can_manage_location(auth.uid(), location_id))
  );

CREATE TRIGGER trg_pipelines_updated_at BEFORE UPDATE ON public.pipelines
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 2. Stages -----------------------------------------------------------------
CREATE TABLE public.pipeline_stages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id uuid NOT NULL REFERENCES public.pipelines(id) ON DELETE CASCADE,
  key text NOT NULL,
  name text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  color text NOT NULL DEFAULT '#64748B',
  probability numeric(5,2) NOT NULL DEFAULT 0 CHECK (probability >= 0 AND probability <= 100),
  is_won boolean NOT NULL DEFAULT false,
  is_lost boolean NOT NULL DEFAULT false,
  wip_limit integer CHECK (wip_limit IS NULL OR wip_limit > 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pipeline_id, key)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pipeline_stages TO authenticated;
GRANT ALL ON public.pipeline_stages TO service_role;
ALTER TABLE public.pipeline_stages ENABLE ROW LEVEL SECURITY;
CREATE INDEX pipeline_stages_pipeline_idx ON public.pipeline_stages(pipeline_id, sort_order);

CREATE POLICY "pipeline_stages_select" ON public.pipeline_stages
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "pipeline_stages_write" ON public.pipeline_stages FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.pipelines p WHERE p.id = pipeline_stages.pipeline_id
      AND (public.is_privileged(auth.uid())
           OR (p.location_id IS NOT NULL AND public.can_manage_location(auth.uid(), p.location_id)))
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.pipelines p WHERE p.id = pipeline_stages.pipeline_id
      AND (public.is_privileged(auth.uid())
           OR (p.location_id IS NOT NULL AND public.can_manage_location(auth.uid(), p.location_id)))
  ));

CREATE TRIGGER trg_pipeline_stages_updated_at BEFORE UPDATE ON public.pipeline_stages
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 3. Seed the agreed default account lifecycle -------------------------------
INSERT INTO public.pipelines (id, name, entity_type, location_id, is_default, is_active)
VALUES ('11111111-1111-4111-8111-111111111111', 'Relationship pipeline', 'account', NULL, true, true);

INSERT INTO public.pipeline_stages
  (pipeline_id, key, name, sort_order, color, probability, is_won, is_lost)
VALUES
  ('11111111-1111-4111-8111-111111111111','target','Target',10,'#64748B',5,false,false),
  ('11111111-1111-4111-8111-111111111111','researching','Researching',20,'#0F766E',10,false,false),
  ('11111111-1111-4111-8111-111111111111','attempting_contact','Attempting contact',30,'#1B5FA8',20,false,false),
  ('11111111-1111-4111-8111-111111111111','meeting_booked','Meeting booked',40,'#2563EB',35,false,false),
  ('11111111-1111-4111-8111-111111111111','meeting_held','Meeting held',50,'#7C3AED',50,false,false),
  ('11111111-1111-4111-8111-111111111111','vendor_onboarding','Vendor onboarding',60,'#C8951C',70,false,false),
  ('11111111-1111-4111-8111-111111111111','active','Active',70,'#15803D',100,true,false),
  ('11111111-1111-4111-8111-111111111111','nurture','Nurture',80,'#0891B2',25,false,false),
  ('11111111-1111-4111-8111-111111111111','dormant','Dormant',90,'#78716C',0,false,false),
  ('11111111-1111-4111-8111-111111111111','lost','Lost',100,'#DC2626',0,false,true);

-- 4. Move accounts onto stage_id --------------------------------------------
DROP VIEW IF EXISTS public.account_fire_rollup;
DROP TRIGGER IF EXISTS trg_account_stage_change_ins ON public.accounts;
DROP TRIGGER IF EXISTS trg_account_stage_change_upd ON public.accounts;

ALTER TABLE public.accounts ALTER COLUMN stage DROP DEFAULT;
ALTER TABLE public.accounts ALTER COLUMN stage TYPE text USING stage::text;
ALTER TABLE public.accounts ALTER COLUMN stage SET DEFAULT 'target';
ALTER TABLE public.accounts
  ADD COLUMN pipeline_id uuid REFERENCES public.pipelines(id) ON DELETE SET NULL,
  ADD COLUMN stage_id uuid REFERENCES public.pipeline_stages(id) ON DELETE RESTRICT,
  ADD COLUMN estimated_annual_value numeric(14,2),
  ADD COLUMN priority text NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('low','normal','high','critical'));
CREATE INDEX accounts_stage_id_idx ON public.accounts(stage_id);

ALTER TABLE public.account_stage_history
  ALTER COLUMN from_stage TYPE text USING from_stage::text,
  ALTER COLUMN to_stage TYPE text USING to_stage::text,
  ADD COLUMN from_stage_id uuid REFERENCES public.pipeline_stages(id) ON DELETE SET NULL,
  ADD COLUMN to_stage_id uuid REFERENCES public.pipeline_stages(id) ON DELETE SET NULL;

DROP FUNCTION IF EXISTS public.person_accounts(uuid);
DROP TYPE IF EXISTS public.account_stage;

CREATE FUNCTION public.person_accounts(_user_id uuid)
RETURNS TABLE(id uuid, name text, stage text, status account_status, location_id uuid,
              last_touch timestamptz, days_since_touch integer, overdue boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT a.id, a.name, a.stage, a.status, a.location_id, lt.last_touch,
         CASE WHEN lt.last_touch IS NULL THEN NULL
              ELSE EXTRACT(DAY FROM now() - lt.last_touch)::int END,
         (lt.last_touch IS NULL OR lt.last_touch < now() - interval '90 days')
    FROM public.accounts a
    LEFT JOIN LATERAL (
      SELECT max(t.occurred_at) AS last_touch FROM public.touchpoints t WHERE t.account_id = a.id
    ) lt ON true
   WHERE public.can_view_person_scorecard(_user_id)
     AND a.assigned_rep = _user_id
   ORDER BY lt.last_touch NULLS FIRST;
$fn$;
GRANT EXECUTE ON FUNCTION public.person_accounts(uuid) TO authenticated;

CREATE VIEW public.account_fire_rollup AS
  SELECT a.id AS account_id,
     a.name, a.status, a.stage, a.stage_id, a.pipeline_id, a.priority,
     a.estimated_annual_value,
     a.account_type, a.location_id, a.assigned_rep, a.notes, a.updated_at,
     COALESCE(l.lead_count, 0::bigint) AS lead_count,
     COALESCE(l.open_count, 0::bigint) AS open_count,
     l.last_loss_date,
     COALESCE(l.units_vacated, 0::bigint) AS units_vacated,
     l.mailing_address,
     c.primary_contact_id, c.primary_contact_name, c.primary_contact_email,
     c.primary_contact_phone, c.primary_contact_gift_policy,
     t.last_touch_at, t.last_in_person_at,
     COALESCE(t.touch_count, 0::bigint) AS touch_count
    FROM public.accounts a
      LEFT JOIN LATERAL ( SELECT count(*) AS lead_count,
             count(*) FILTER (WHERE fl.status = 'open'::lead_status AND fl.rescind_date IS NULL) AS open_count,
             max(fl.incident_date) AS last_loss_date,
             COALESCE(sum(fl.units_vacated), 0::bigint) AS units_vacated,
             (array_remove(array_agg(fl.owner_mailing_address ORDER BY fl.incident_date DESC NULLS LAST), NULL::text))[1] AS mailing_address
            FROM public.fire_leads fl WHERE fl.account_id = a.id) l ON true
      LEFT JOIN LATERAL ( SELECT ct.id AS primary_contact_id, ct.full_name AS primary_contact_name,
             ct.email AS primary_contact_email, ct.phone AS primary_contact_phone,
             ct.gift_policy AS primary_contact_gift_policy
            FROM public.contacts ct WHERE ct.account_id = a.id
           ORDER BY ct.is_primary DESC, ct.created_at LIMIT 1) c ON true
      LEFT JOIN LATERAL ( SELECT max(tp.occurred_at) AS last_touch_at,
             max(tp.occurred_at) FILTER (WHERE tp.type = 'meeting_in_person'::touchpoint_type) AS last_in_person_at,
             count(*) AS touch_count
            FROM public.touchpoints tp WHERE tp.account_id = a.id) t ON true;

GRANT SELECT ON public.account_fire_rollup TO authenticated;
GRANT ALL ON public.account_fire_rollup TO service_role;

-- 5. Default pipeline resolution --------------------------------------------
CREATE OR REPLACE FUNCTION public.default_pipeline_for(_location_id uuid, _entity_type text DEFAULT 'account')
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.id FROM public.pipelines p
  WHERE p.entity_type = _entity_type AND p.is_active
    AND (p.location_id = _location_id OR p.location_id IS NULL)
  ORDER BY (p.location_id IS NOT NULL) DESC, p.is_default DESC, p.created_at ASC
  LIMIT 1;
$$;

-- 6. Stage normalisation + history ------------------------------------------
CREATE OR REPLACE FUNCTION public.tg_account_stage_normalize()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE s public.pipeline_stages%ROWTYPE;
BEGIN
  IF NEW.stage_id IS NULL THEN
    IF NEW.pipeline_id IS NULL THEN
      NEW.pipeline_id := public.default_pipeline_for(NEW.location_id, 'account');
    END IF;
    SELECT * INTO s FROM public.pipeline_stages ps
      WHERE ps.pipeline_id = NEW.pipeline_id AND ps.key = COALESCE(NEW.stage, 'target');
    IF NOT FOUND THEN
      SELECT * INTO s FROM public.pipeline_stages ps
        WHERE ps.pipeline_id = NEW.pipeline_id AND ps.is_active
        ORDER BY ps.sort_order LIMIT 1;
    END IF;
  ELSE
    SELECT * INTO s FROM public.pipeline_stages ps WHERE ps.id = NEW.stage_id;
  END IF;

  IF s.id IS NULL THEN
    RAISE EXCEPTION 'No pipeline stage available for this account';
  END IF;

  NEW.stage_id := s.id;
  NEW.pipeline_id := s.pipeline_id;
  NEW.stage := s.key;

  IF s.is_lost AND (NEW.lost_reason IS NULL OR btrim(NEW.lost_reason) = '') THEN
    RAISE EXCEPTION 'A reason is required when an account is marked lost';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.stage_id IS DISTINCT FROM OLD.stage_id THEN
    NEW.stage_changed_at := now();
  END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION public.tg_account_stage_history()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.account_stage_history(account_id, from_stage, to_stage, from_stage_id, to_stage_id, reason, changed_by)
    VALUES (NEW.id, NULL, NEW.stage, NULL, NEW.stage_id, NEW.lost_reason, auth.uid());
  ELSIF NEW.stage_id IS DISTINCT FROM OLD.stage_id THEN
    INSERT INTO public.account_stage_history(account_id, from_stage, to_stage, from_stage_id, to_stage_id, reason, changed_by)
    VALUES (NEW.id, OLD.stage, NEW.stage, OLD.stage_id, NEW.stage_id, NEW.lost_reason, auth.uid());
  END IF;
  RETURN NULL;
END; $$;

DROP FUNCTION IF EXISTS public.tg_account_stage_change();

CREATE TRIGGER trg_accounts_stage_normalize BEFORE INSERT OR UPDATE ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.tg_account_stage_normalize();
CREATE TRIGGER trg_accounts_stage_history AFTER INSERT OR UPDATE ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.tg_account_stage_history();

-- 7. Minimal cross-location projection for the board -------------------------
CREATE OR REPLACE FUNCTION public.pipeline_cards_minimal()
RETURNS TABLE(account_id uuid, account_name text, owning_location_id uuid,
              owning_location_code text, owning_location_name text,
              stage_id uuid, stage_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT a.id, a.name, l.id, l.code, l.name, a.stage_id, ps.name
  FROM public.accounts a
  JOIN public.locations l ON l.id = a.location_id
  LEFT JOIN public.pipeline_stages ps ON ps.id = a.stage_id
  WHERE auth.uid() IS NOT NULL
    AND NOT (a.created_by = auth.uid() OR a.assigned_rep = auth.uid()
             OR public.can_view_location(auth.uid(), a.location_id));
$$;
REVOKE ALL ON FUNCTION public.pipeline_cards_minimal() FROM public;
GRANT EXECUTE ON FUNCTION public.pipeline_cards_minimal() TO authenticated;
GRANT EXECUTE ON FUNCTION public.default_pipeline_for(uuid, text) TO authenticated;