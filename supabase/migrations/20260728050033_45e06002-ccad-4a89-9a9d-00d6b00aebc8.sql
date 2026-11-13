-- =========================================================
-- ENUMS
-- =========================================================
CREATE TYPE public.incident_status AS ENUM (
  'new','dispatched','accepted','on_scene','closed','discarded'
);

CREATE TYPE public.incident_type AS ENUM (
  'fire','water','smoke','storm','other'
);

CREATE TYPE public.incident_outcome AS ENUM (
  'contract_signed','homeowner_declined','no_contact','competitor_present','not_real_loss'
);

CREATE TYPE public.chase_event_type AS ENUM (
  'created','dispatched','accepted','declined','arrived',
  'outcome_logged','converted','escalated','matched_hpd','discarded'
);

-- =========================================================
-- 1. incidents  (source-agnostic intake spine)
-- =========================================================
CREATE TABLE public.incidents (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- provenance
  source                  text NOT NULL,                 -- 'manual' | 'webhook' | 'scanner' | 'emulator' | ...
  external_ref            text,                          -- source-side id where available
  reported_at             timestamptz NOT NULL DEFAULT now(),
  raw_text                text,
  -- geography
  address                 text,
  locality                text,
  region                  text,
  postal_code             text,
  lat                     double precision,
  lon                     double precision,
  geom                    geography(Point,4326),
  -- classification
  incident_type           public.incident_type NOT NULL DEFAULT 'fire',
  alarm_level             text,                          -- "10-75", "2nd alarm", etc.
  call_sign               text,
  -- chase state
  status                  public.incident_status NOT NULL DEFAULT 'new',
  location_id             uuid REFERENCES public.locations(id),
  dispatched_at           timestamptz,
  accepted_by             uuid,
  accepted_at             timestamptz,
  arrived_at              timestamptz,
  arrived_lat             double precision,
  arrived_lon             double precision,
  -- outcome
  outcome                 public.incident_outcome,
  outcome_notes           text,
  outcome_at              timestamptz,
  -- links
  job_id                  uuid REFERENCES public.jobs(id),
  matched_fire_lead_id    uuid REFERENCES public.fire_leads(id),
  matched_at              timestamptz,
  -- audit
  created_by              uuid,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT incidents_source_ref_unique UNIQUE (source, external_ref)
);

CREATE INDEX incidents_status_reported_idx  ON public.incidents (status, reported_at DESC);
CREATE INDEX incidents_location_idx         ON public.incidents (location_id, reported_at DESC);
CREATE INDEX incidents_accepted_by_idx      ON public.incidents (accepted_by, accepted_at DESC);
CREATE INDEX incidents_geom_gix             ON public.incidents USING GIST (geom);

GRANT SELECT, INSERT, UPDATE ON public.incidents TO authenticated;
GRANT ALL ON public.incidents TO service_role;

ALTER TABLE public.incidents ENABLE ROW LEVEL SECURITY;

-- Staff (admin/owner/dev) see everything.
CREATE POLICY "incidents_select_staff" ON public.incidents
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(),'admin')
    OR public.has_role(auth.uid(),'owner')
    OR public.has_role(auth.uid(),'dev')
  );

-- Anyone with visibility into the routed location.
CREATE POLICY "incidents_select_by_location" ON public.incidents
  FOR SELECT TO authenticated
  USING (
    location_id IS NOT NULL
    AND public.can_view_location(auth.uid(), location_id)
  );

-- Accepting chasers keep read access even if unrouted.
CREATE POLICY "incidents_select_by_acceptor" ON public.incidents
  FOR SELECT TO authenticated
  USING (accepted_by = auth.uid());

-- Anyone who can view the (target) location may create manual incidents there.
-- For unrouted inserts (location_id NULL), only staff may create.
CREATE POLICY "incidents_insert" ON public.incidents
  FOR INSERT TO authenticated
  WITH CHECK (
    public.has_role(auth.uid(),'admin')
    OR public.has_role(auth.uid(),'owner')
    OR public.has_role(auth.uid(),'dev')
    OR (
      location_id IS NOT NULL
      AND public.can_view_location(auth.uid(), location_id)
    )
  );

-- Update: staff, managers of the location, or the chaser who accepted.
CREATE POLICY "incidents_update" ON public.incidents
  FOR UPDATE TO authenticated
  USING (
    public.has_role(auth.uid(),'admin')
    OR public.has_role(auth.uid(),'owner')
    OR public.has_role(auth.uid(),'dev')
    OR (location_id IS NOT NULL AND public.can_manage_location(auth.uid(), location_id))
    OR (location_id IS NOT NULL AND public.can_view_location(auth.uid(), location_id))
  )
  WITH CHECK (
    public.has_role(auth.uid(),'admin')
    OR public.has_role(auth.uid(),'owner')
    OR public.has_role(auth.uid(),'dev')
    OR (location_id IS NOT NULL AND public.can_view_location(auth.uid(), location_id))
  );

-- =========================================================
-- 2. incident_events  (append-only audit)
-- =========================================================
CREATE TABLE public.incident_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id  uuid NOT NULL REFERENCES public.incidents(id) ON DELETE CASCADE,
  event_type   public.chase_event_type NOT NULL,
  actor_id     uuid,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  lat          double precision,
  lon          double precision
);

CREATE INDEX incident_events_incident_idx ON public.incident_events (incident_id, occurred_at DESC);
CREATE INDEX incident_events_type_idx     ON public.incident_events (event_type, occurred_at DESC);

GRANT SELECT, INSERT ON public.incident_events TO authenticated;
GRANT ALL ON public.incident_events TO service_role;

ALTER TABLE public.incident_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "incident_events_select" ON public.incident_events
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.incidents i
      WHERE i.id = incident_events.incident_id
        AND (
          public.has_role(auth.uid(),'admin')
          OR public.has_role(auth.uid(),'owner')
          OR public.has_role(auth.uid(),'dev')
          OR (i.location_id IS NOT NULL AND public.can_view_location(auth.uid(), i.location_id))
          OR i.accepted_by = auth.uid()
        )
    )
  );

CREATE POLICY "incident_events_insert" ON public.incident_events
  FOR INSERT TO authenticated
  WITH CHECK (
    actor_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.incidents i
      WHERE i.id = incident_events.incident_id
        AND (
          public.has_role(auth.uid(),'admin')
          OR public.has_role(auth.uid(),'owner')
          OR public.has_role(auth.uid(),'dev')
          OR (i.location_id IS NOT NULL AND public.can_view_location(auth.uid(), i.location_id))
          OR i.accepted_by = auth.uid()
        )
    )
  );

-- =========================================================
-- 3. chaser_shifts  (on-duty / off-duty; event-based GPS only)
-- =========================================================
CREATE TABLE public.chaser_shifts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL,
  location_id   uuid NOT NULL REFERENCES public.locations(id),
  started_at    timestamptz NOT NULL DEFAULT now(),
  ended_at      timestamptz,
  started_lat   double precision,
  started_lon   double precision,
  ended_lat     double precision,
  ended_lon     double precision
);

CREATE INDEX chaser_shifts_user_open_idx     ON public.chaser_shifts (user_id, ended_at);
CREATE INDEX chaser_shifts_location_open_idx ON public.chaser_shifts (location_id, ended_at);

-- Only one open shift per user.
CREATE UNIQUE INDEX chaser_shifts_one_open_per_user
  ON public.chaser_shifts (user_id)
  WHERE ended_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON public.chaser_shifts TO authenticated;
GRANT ALL ON public.chaser_shifts TO service_role;

ALTER TABLE public.chaser_shifts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "chaser_shifts_select_own" ON public.chaser_shifts
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "chaser_shifts_select_managers" ON public.chaser_shifts
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(),'admin')
    OR public.has_role(auth.uid(),'owner')
    OR public.has_role(auth.uid(),'dev')
    OR public.can_manage_location(auth.uid(), location_id)
    OR public.can_view_location(auth.uid(), location_id)
  );

CREATE POLICY "chaser_shifts_insert_self" ON public.chaser_shifts
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND public.can_view_location(auth.uid(), location_id)
  );

CREATE POLICY "chaser_shifts_update_self" ON public.chaser_shifts
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- =========================================================
-- Triggers: keep geom/routing/updated_at consistent
-- =========================================================
CREATE OR REPLACE FUNCTION public.trg_incidents_set_geo()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.lat IS NOT NULL AND NEW.lon IS NOT NULL THEN
    NEW.geom := ST_SetSRID(ST_MakePoint(NEW.lon, NEW.lat), 4326)::geography;
    IF NEW.location_id IS NULL THEN
      NEW.location_id := public.nearest_location(NEW.lat, NEW.lon, 250);
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_incidents_biu
BEFORE INSERT OR UPDATE ON public.incidents
FOR EACH ROW EXECUTE FUNCTION public.trg_incidents_set_geo();

-- Log creation as an incident_event.
CREATE OR REPLACE FUNCTION public.trg_incidents_log_created()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.incident_events (incident_id, event_type, actor_id, payload)
  VALUES (NEW.id, 'created', NEW.created_by,
          jsonb_build_object('source', NEW.source,
                             'incident_type', NEW.incident_type,
                             'address', NEW.address,
                             'location_id', NEW.location_id));
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_incidents_ai_log
AFTER INSERT ON public.incidents
FOR EACH ROW EXECUTE FUNCTION public.trg_incidents_log_created();

-- =========================================================
-- Helper: on-duty chasers for a location
-- =========================================================
CREATE OR REPLACE FUNCTION public.on_duty_chasers(_location_id uuid)
RETURNS TABLE (user_id uuid, started_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT s.user_id, s.started_at
  FROM public.chaser_shifts s
  WHERE s.ended_at IS NULL
    AND s.location_id = _location_id;
$$;

-- =========================================================
-- HPD match: link incidents to fire_leads (200m / ±14 days)
-- =========================================================
CREATE OR REPLACE FUNCTION public.match_incidents_to_fire_leads()
RETURNS TABLE(matched_count int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n int := 0;
BEGIN
  WITH candidates AS (
    SELECT i.id AS incident_id,
           l.id AS lead_id,
           l.owner_name,
           l.owner_mailing_address,
           l.agent_name,
           ROW_NUMBER() OVER (
             PARTITION BY i.id
             ORDER BY ST_Distance(i.geom, l.geom) ASC
           ) AS rn
    FROM public.incidents i
    JOIN public.fire_leads l
      ON l.geom IS NOT NULL
     AND i.geom IS NOT NULL
     AND ST_DWithin(i.geom, l.geom, 200)  -- meters
     AND l.incident_date IS NOT NULL
     AND l.incident_date BETWEEN (i.reported_at::date - INTERVAL '2 days')
                             AND (i.reported_at::date + INTERVAL '14 days')
    WHERE i.matched_fire_lead_id IS NULL
      AND i.reported_at > now() - INTERVAL '60 days'
  ),
  picks AS (
    SELECT * FROM candidates WHERE rn = 1
  ),
  updated AS (
    UPDATE public.incidents i
       SET matched_fire_lead_id = p.lead_id,
           matched_at = now()
    FROM picks p
    WHERE i.id = p.incident_id
    RETURNING i.id, p.lead_id, p.owner_name
  ),
  logged AS (
    INSERT INTO public.incident_events (incident_id, event_type, payload)
    SELECT u.id, 'matched_hpd',
           jsonb_build_object('fire_lead_id', u.lead_id, 'owner_name', u.owner_name)
    FROM updated u
    RETURNING 1
  )
  SELECT COUNT(*) INTO n FROM updated;

  RETURN QUERY SELECT n;
END;
$$;

-- =========================================================
-- Realtime
-- =========================================================
ALTER PUBLICATION supabase_realtime ADD TABLE public.incidents;
ALTER PUBLICATION supabase_realtime ADD TABLE public.incident_events;
ALTER PUBLICATION supabase_realtime ADD TABLE public.chaser_shifts;