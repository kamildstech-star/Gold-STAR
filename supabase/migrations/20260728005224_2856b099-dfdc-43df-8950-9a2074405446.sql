
-- ============================================================================
-- ENUMS
-- ============================================================================
CREATE TYPE public.lead_status AS ENUM ('open', 'rescinded');
CREATE TYPE public.pipeline_stage AS ENUM ('new', 'attempting_contact', 'contacted', 'appointment_set', 'quoted', 'won', 'lost', 'unqualified');
CREATE TYPE public.tag_scope AS ENUM ('lead', 'job', 'contact', 'photo', 'project');
CREATE TYPE public.contact_channel AS ENUM ('call', 'sms', 'email', 'door', 'other');
CREATE TYPE public.lead_event_type AS ENUM ('new_lead', 'status_changed', 'stage_changed', 'assigned', 'note_added', 'contact_attempted', 'rescinded');

-- ============================================================================
-- fire_leads
--   SOURCE columns: owned by sync, overwritten on every run.
--   CRM columns:    owned by app, sync must NEVER touch these.
-- ============================================================================
CREATE TABLE public.fire_leads (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,

  -- === SOURCE columns (owned by sync) =======================================
  source_system      text NOT NULL,        -- e.g. 'nyc_hpd_vacate'
  source_record_id   text NOT NULL,        -- NYC: vacate_order_number
  jurisdiction       text NOT NULL,        -- e.g. 'NYC'
  incident_date      date,
  address            text,
  locality           text,
  region             text,
  postal_code        text,
  neighborhood       text,
  lat                double precision,
  lon                double precision,
  geom               geography(Point, 4326),
  units_vacated      integer,
  vacate_type        text,                 -- full / partial / vacate order type text
  status             public.lead_status NOT NULL DEFAULT 'open',
  rescind_date       date,
  source_ref         jsonb NOT NULL DEFAULT '{}'::jsonb, -- BBL, BIN, building_id, registration_id, etc.
  owner_name             text,
  owner_role             text,
  owner_mailing_address  text,
  agent_name             text,
  agent_mailing_address  text,
  source_first_seen_at   timestamptz NOT NULL DEFAULT now(),
  source_last_synced_at  timestamptz NOT NULL DEFAULT now(),

  -- === CRM columns (owned by app, sync must never overwrite) ================
  location_id       uuid REFERENCES public.locations(id) ON DELETE SET NULL,
  assigned_rep      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  pipeline_stage    public.pipeline_stage NOT NULL DEFAULT 'new',
  stage_changed_at  timestamptz NOT NULL DEFAULT now(),
  priority          smallint NOT NULL DEFAULT 0,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fire_leads_natural_key UNIQUE (source_system, source_record_id)
);

CREATE INDEX fire_leads_jurisdiction_idx    ON public.fire_leads (jurisdiction);
CREATE INDEX fire_leads_status_idx          ON public.fire_leads (status);
CREATE INDEX fire_leads_pipeline_stage_idx  ON public.fire_leads (pipeline_stage);
CREATE INDEX fire_leads_location_idx        ON public.fire_leads (location_id);
CREATE INDEX fire_leads_assigned_rep_idx    ON public.fire_leads (assigned_rep);
CREATE INDEX fire_leads_incident_date_idx   ON public.fire_leads (incident_date DESC);
CREATE INDEX fire_leads_geom_idx            ON public.fire_leads USING GIST (geom);

-- ============================================================================
-- tags (global) + lead_tags
-- ============================================================================
CREATE TABLE public.tags (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name text NOT NULL,
  color text,
  scopes public.tag_scope[] NOT NULL DEFAULT ARRAY['lead']::public.tag_scope[],
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tags_name_unique UNIQUE (name)
);

CREATE TABLE public.lead_tags (
  lead_id uuid NOT NULL REFERENCES public.fire_leads(id) ON DELETE CASCADE,
  tag_id  uuid NOT NULL REFERENCES public.tags(id) ON DELETE CASCADE,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (lead_id, tag_id)
);

-- ============================================================================
-- lead_notes
-- ============================================================================
CREATE TABLE public.lead_notes (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  lead_id uuid NOT NULL REFERENCES public.fire_leads(id) ON DELETE CASCADE,
  author_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lead_notes_lead_idx ON public.lead_notes (lead_id, created_at DESC);

-- ============================================================================
-- contact_attempts
-- ============================================================================
CREATE TABLE public.contact_attempts (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  lead_id uuid NOT NULL REFERENCES public.fire_leads(id) ON DELETE CASCADE,
  author_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  channel public.contact_channel NOT NULL,
  outcome text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  duration_seconds integer,
  recording_url text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contact_attempts_lead_idx ON public.contact_attempts (lead_id, occurred_at DESC);

-- ============================================================================
-- lead_stage_history (populated by trigger)
-- ============================================================================
CREATE TABLE public.lead_stage_history (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  lead_id uuid NOT NULL REFERENCES public.fire_leads(id) ON DELETE CASCADE,
  from_stage public.pipeline_stage,
  to_stage   public.pipeline_stage NOT NULL,
  changed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lead_stage_history_lead_idx ON public.lead_stage_history (lead_id, changed_at DESC);

-- ============================================================================
-- lead_events (drives alerting)
-- ============================================================================
CREATE TABLE public.lead_events (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  lead_id uuid NOT NULL REFERENCES public.fire_leads(id) ON DELETE CASCADE,
  event_type public.lead_event_type NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lead_events_lead_idx ON public.lead_events (lead_id, occurred_at DESC);
CREATE INDEX lead_events_type_idx ON public.lead_events (event_type, occurred_at DESC);

-- ============================================================================
-- sync_runs
-- ============================================================================
CREATE TABLE public.sync_runs (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  source_system text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  source_rows integer,
  upserted integer,
  new_count integer,
  owner_match_count integer,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  success boolean
);
CREATE INDEX sync_runs_source_idx ON public.sync_runs (source_system, started_at DESC);

-- ============================================================================
-- updated_at trigger fn + wiring
-- ============================================================================
CREATE OR REPLACE FUNCTION public.tg_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

CREATE TRIGGER touch_fire_leads BEFORE UPDATE ON public.fire_leads
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();
CREATE TRIGGER touch_tags BEFORE UPDATE ON public.tags
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();
CREATE TRIGGER touch_lead_notes BEFORE UPDATE ON public.lead_notes
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

-- ============================================================================
-- Stage change → history trigger
-- ============================================================================
CREATE OR REPLACE FUNCTION public.tg_fire_leads_stage_history()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.pipeline_stage IS DISTINCT FROM OLD.pipeline_stage THEN
    NEW.stage_changed_at := now();
    INSERT INTO public.lead_stage_history (lead_id, from_stage, to_stage, changed_by)
      VALUES (NEW.id, OLD.pipeline_stage, NEW.pipeline_stage, auth.uid());
    INSERT INTO public.lead_events (lead_id, event_type, payload, actor_id)
      VALUES (NEW.id, 'stage_changed',
              jsonb_build_object('from', OLD.pipeline_stage, 'to', NEW.pipeline_stage),
              auth.uid());
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER fire_leads_stage_history
  BEFORE UPDATE OF pipeline_stage ON public.fire_leads
  FOR EACH ROW EXECUTE FUNCTION public.tg_fire_leads_stage_history();

-- ============================================================================
-- Visibility helper for field users
-- Field sees: leads assigned to them, or early-stage leads in their office(s).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.is_lead_visible_to_field(_user_id uuid, _lead_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.fire_leads l
    WHERE l.id = _lead_id
      AND (
        l.assigned_rep = _user_id
        OR (
          l.location_id IS NOT NULL
          AND public.is_member_of(_user_id, l.location_id)
          AND l.pipeline_stage IN ('new','attempting_contact','contacted','appointment_set')
        )
      )
  );
$$;

-- ============================================================================
-- GRANTS
-- ============================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON public.fire_leads         TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tags               TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.lead_tags          TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.lead_notes         TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.contact_attempts   TO authenticated;
GRANT SELECT                         ON public.lead_stage_history TO authenticated;
GRANT SELECT                         ON public.lead_events        TO authenticated;
GRANT SELECT                         ON public.sync_runs          TO authenticated;

GRANT ALL ON public.fire_leads         TO service_role;
GRANT ALL ON public.tags               TO service_role;
GRANT ALL ON public.lead_tags          TO service_role;
GRANT ALL ON public.lead_notes         TO service_role;
GRANT ALL ON public.contact_attempts   TO service_role;
GRANT ALL ON public.lead_stage_history TO service_role;
GRANT ALL ON public.lead_events        TO service_role;
GRANT ALL ON public.sync_runs          TO service_role;

-- ============================================================================
-- RLS
-- ============================================================================
ALTER TABLE public.fire_leads         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tags               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_tags          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_notes         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contact_attempts   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_stage_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_events        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_runs          ENABLE ROW LEVEL SECURITY;

-- fire_leads --------------------------------------------------------------
CREATE POLICY "Admins full access to fire_leads" ON public.fire_leads
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Office views leads in their locations" ON public.fire_leads
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'office')
    AND location_id IS NOT NULL
    AND public.is_member_of(auth.uid(), location_id)
  );

CREATE POLICY "Office manages leads in their locations" ON public.fire_leads
  FOR UPDATE TO authenticated
  USING (
    public.has_role(auth.uid(), 'office')
    AND location_id IS NOT NULL
    AND public.is_member_of(auth.uid(), location_id)
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'office')
    AND location_id IS NOT NULL
    AND public.is_member_of(auth.uid(), location_id)
  );

CREATE POLICY "Field views own or early-stage leads" ON public.fire_leads
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'field')
    AND (
      assigned_rep = auth.uid()
      OR (
        location_id IS NOT NULL
        AND public.is_member_of(auth.uid(), location_id)
        AND pipeline_stage IN ('new','attempting_contact','contacted','appointment_set')
      )
    )
  );

CREATE POLICY "Field updates their assigned leads" ON public.fire_leads
  FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'field') AND assigned_rep = auth.uid())
  WITH CHECK (public.has_role(auth.uid(), 'field') AND assigned_rep = auth.uid());

-- tags --------------------------------------------------------------------
CREATE POLICY "Signed-in users view tags" ON public.tags
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "Admins and office manage tags" ON public.tags
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'office'))
  WITH CHECK (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'office'));

-- lead_tags ---------------------------------------------------------------
CREATE POLICY "View lead_tags if you can view the lead" ON public.lead_tags
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR EXISTS (
      SELECT 1 FROM public.fire_leads l
      WHERE l.id = lead_tags.lead_id
        AND (
          (public.has_role(auth.uid(), 'office') AND l.location_id IS NOT NULL AND public.is_member_of(auth.uid(), l.location_id))
          OR (public.has_role(auth.uid(), 'field') AND public.is_lead_visible_to_field(auth.uid(), l.id))
        )
    )
  );

CREATE POLICY "Manage lead_tags if you can update the lead" ON public.lead_tags
  FOR ALL TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR EXISTS (
      SELECT 1 FROM public.fire_leads l
      WHERE l.id = lead_tags.lead_id
        AND (
          (public.has_role(auth.uid(), 'office') AND l.location_id IS NOT NULL AND public.is_member_of(auth.uid(), l.location_id))
          OR (public.has_role(auth.uid(), 'field') AND l.assigned_rep = auth.uid())
        )
    )
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'admin')
    OR EXISTS (
      SELECT 1 FROM public.fire_leads l
      WHERE l.id = lead_tags.lead_id
        AND (
          (public.has_role(auth.uid(), 'office') AND l.location_id IS NOT NULL AND public.is_member_of(auth.uid(), l.location_id))
          OR (public.has_role(auth.uid(), 'field') AND l.assigned_rep = auth.uid())
        )
    )
  );

-- lead_notes --------------------------------------------------------------
CREATE POLICY "View lead_notes if you can view the lead" ON public.lead_notes
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR EXISTS (
      SELECT 1 FROM public.fire_leads l
      WHERE l.id = lead_notes.lead_id
        AND (
          (public.has_role(auth.uid(), 'office') AND l.location_id IS NOT NULL AND public.is_member_of(auth.uid(), l.location_id))
          OR (public.has_role(auth.uid(), 'field') AND public.is_lead_visible_to_field(auth.uid(), l.id))
        )
    )
  );

CREATE POLICY "Insert own lead_notes on visible leads" ON public.lead_notes
  FOR INSERT TO authenticated
  WITH CHECK (
    author_id = auth.uid()
    AND (
      public.has_role(auth.uid(), 'admin')
      OR EXISTS (
        SELECT 1 FROM public.fire_leads l
        WHERE l.id = lead_notes.lead_id
          AND (
            (public.has_role(auth.uid(), 'office') AND l.location_id IS NOT NULL AND public.is_member_of(auth.uid(), l.location_id))
            OR (public.has_role(auth.uid(), 'field') AND public.is_lead_visible_to_field(auth.uid(), l.id))
          )
      )
    )
  );

CREATE POLICY "Authors update own notes" ON public.lead_notes
  FOR UPDATE TO authenticated
  USING (author_id = auth.uid() OR public.has_role(auth.uid(), 'admin'))
  WITH CHECK (author_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Authors delete own notes" ON public.lead_notes
  FOR DELETE TO authenticated
  USING (author_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));

-- contact_attempts --------------------------------------------------------
CREATE POLICY "View contact_attempts if you can view the lead" ON public.contact_attempts
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR EXISTS (
      SELECT 1 FROM public.fire_leads l
      WHERE l.id = contact_attempts.lead_id
        AND (
          (public.has_role(auth.uid(), 'office') AND l.location_id IS NOT NULL AND public.is_member_of(auth.uid(), l.location_id))
          OR (public.has_role(auth.uid(), 'field') AND public.is_lead_visible_to_field(auth.uid(), l.id))
        )
    )
  );

CREATE POLICY "Insert own contact_attempts on visible leads" ON public.contact_attempts
  FOR INSERT TO authenticated
  WITH CHECK (
    author_id = auth.uid()
    AND (
      public.has_role(auth.uid(), 'admin')
      OR EXISTS (
        SELECT 1 FROM public.fire_leads l
        WHERE l.id = contact_attempts.lead_id
          AND (
            (public.has_role(auth.uid(), 'office') AND l.location_id IS NOT NULL AND public.is_member_of(auth.uid(), l.location_id))
            OR (public.has_role(auth.uid(), 'field') AND public.is_lead_visible_to_field(auth.uid(), l.id))
          )
      )
    )
  );

CREATE POLICY "Authors update own contact_attempts" ON public.contact_attempts
  FOR UPDATE TO authenticated
  USING (author_id = auth.uid() OR public.has_role(auth.uid(), 'admin'))
  WITH CHECK (author_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Authors delete own contact_attempts" ON public.contact_attempts
  FOR DELETE TO authenticated
  USING (author_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));

-- lead_stage_history (read-only via app; sync/trigger writes) -------------
CREATE POLICY "View stage history if you can view the lead" ON public.lead_stage_history
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR EXISTS (
      SELECT 1 FROM public.fire_leads l
      WHERE l.id = lead_stage_history.lead_id
        AND (
          (public.has_role(auth.uid(), 'office') AND l.location_id IS NOT NULL AND public.is_member_of(auth.uid(), l.location_id))
          OR (public.has_role(auth.uid(), 'field') AND public.is_lead_visible_to_field(auth.uid(), l.id))
        )
    )
  );

-- lead_events (read-only via app; sync/trigger writes) --------------------
CREATE POLICY "View lead_events if you can view the lead" ON public.lead_events
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR EXISTS (
      SELECT 1 FROM public.fire_leads l
      WHERE l.id = lead_events.lead_id
        AND (
          (public.has_role(auth.uid(), 'office') AND l.location_id IS NOT NULL AND public.is_member_of(auth.uid(), l.location_id))
          OR (public.has_role(auth.uid(), 'field') AND public.is_lead_visible_to_field(auth.uid(), l.id))
        )
    )
  );

-- sync_runs (admin only) --------------------------------------------------
CREATE POLICY "Admins view sync_runs" ON public.sync_runs
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
