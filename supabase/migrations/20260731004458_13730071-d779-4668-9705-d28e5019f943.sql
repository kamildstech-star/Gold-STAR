CREATE TYPE public.integration_provider AS ENUM ('raven','callrail','outlook','kai');
CREATE TYPE public.integration_status AS ENUM ('not_connected','connected','error','disabled');
CREATE TYPE public.translation_source AS ENUM ('machine','human');

CREATE TABLE public.integration_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider public.integration_provider NOT NULL,
  location_id uuid REFERENCES public.locations(id) ON DELETE CASCADE,
  display_name text,
  external_account_ref text,
  enabled boolean NOT NULL DEFAULT false,
  status public.integration_status NOT NULL DEFAULT 'not_connected',
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_sync_at timestamptz,
  last_event_at timestamptz,
  last_error text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX integration_connections_provider_loc_key
  ON public.integration_connections (provider, COALESCE(location_id, '00000000-0000-0000-0000-000000000000'::uuid));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.integration_connections TO authenticated;
GRANT ALL ON public.integration_connections TO service_role;
ALTER TABLE public.integration_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "connections viewable by members" ON public.integration_connections
  FOR SELECT TO authenticated
  USING (location_id IS NULL OR public.can_view_location(auth.uid(), location_id));
CREATE POLICY "connections managed by admins" ON public.integration_connections
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin'::app_role) OR public.has_role(auth.uid(),'owner'::app_role) OR public.has_role(auth.uid(),'dev'::app_role))
  WITH CHECK (public.has_role(auth.uid(),'admin'::app_role) OR public.has_role(auth.uid(),'owner'::app_role) OR public.has_role(auth.uid(),'dev'::app_role));

CREATE TABLE public.integration_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider public.integration_provider NOT NULL,
  connection_id uuid REFERENCES public.integration_connections(id) ON DELETE SET NULL,
  direction text NOT NULL DEFAULT 'inbound',
  event_type text NOT NULL,
  external_id text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'processed',
  error text,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX integration_events_dedupe
  ON public.integration_events (provider, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX integration_events_recent ON public.integration_events (provider, received_at DESC);

GRANT SELECT ON public.integration_events TO authenticated;
GRANT ALL ON public.integration_events TO service_role;
ALTER TABLE public.integration_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "events readable by admins" ON public.integration_events
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(),'admin'::app_role) OR public.has_role(auth.uid(),'owner'::app_role) OR public.has_role(auth.uid(),'dev'::app_role));

CREATE TABLE public.vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider public.integration_provider NOT NULL DEFAULT 'raven',
  external_id text NOT NULL,
  label text NOT NULL,
  location_id uuid REFERENCES public.locations(id) ON DELETE SET NULL,
  assigned_user_id uuid,
  last_lat double precision,
  last_lon double precision,
  last_position_at timestamptz,
  ignition boolean,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_id)
);
GRANT SELECT ON public.vehicles TO authenticated;
GRANT ALL ON public.vehicles TO service_role;
ALTER TABLE public.vehicles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "vehicles viewable by members" ON public.vehicles
  FOR SELECT TO authenticated
  USING (location_id IS NULL OR public.can_view_location(auth.uid(), location_id));

CREATE TABLE public.vehicle_positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid NOT NULL REFERENCES public.vehicles(id) ON DELETE CASCADE,
  occurred_at timestamptz NOT NULL,
  lat double precision NOT NULL,
  lon double precision NOT NULL,
  speed_mph double precision,
  heading double precision,
  ignition boolean,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vehicle_id, occurred_at)
);
CREATE INDEX vehicle_positions_recent ON public.vehicle_positions (vehicle_id, occurred_at DESC);
GRANT SELECT ON public.vehicle_positions TO authenticated;
GRANT ALL ON public.vehicle_positions TO service_role;
ALTER TABLE public.vehicle_positions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "positions viewable with vehicle" ON public.vehicle_positions
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.vehicles v WHERE v.id = vehicle_id
                 AND (v.location_id IS NULL OR public.can_view_location(auth.uid(), v.location_id))));

CREATE TABLE public.calendar_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider public.integration_provider NOT NULL DEFAULT 'outlook',
  external_id text NOT NULL,
  user_id uuid,
  account_id uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  subject text,
  body_preview text,
  location_text text,
  starts_at timestamptz,
  ends_at timestamptz,
  attendees jsonb NOT NULL DEFAULT '[]'::jsonb,
  touchpoint_id uuid REFERENCES public.touchpoints(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_id)
);
GRANT SELECT ON public.calendar_events TO authenticated;
GRANT ALL ON public.calendar_events TO service_role;
ALTER TABLE public.calendar_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "calendar own or manager" ON public.calendar_events
  FOR SELECT TO authenticated
  USING (user_id = auth.uid()
    OR public.has_role(auth.uid(),'admin'::app_role) OR public.has_role(auth.uid(),'owner'::app_role)
    OR public.has_role(auth.uid(),'dev'::app_role) OR public.has_role(auth.uid(),'regional'::app_role)
    OR public.has_role(auth.uid(),'location_manager'::app_role) OR public.has_role(auth.uid(),'sales_manager'::app_role));

CREATE TABLE public.email_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider public.integration_provider NOT NULL DEFAULT 'outlook',
  external_id text NOT NULL,
  user_id uuid,
  account_id uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  direction text NOT NULL DEFAULT 'outbound',
  subject text,
  preview text,
  counterparty_email text,
  occurred_at timestamptz NOT NULL,
  touchpoint_id uuid REFERENCES public.touchpoints(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_id)
);
CREATE INDEX email_logs_account ON public.email_logs (account_id, occurred_at DESC);
GRANT SELECT ON public.email_logs TO authenticated;
GRANT ALL ON public.email_logs TO service_role;
ALTER TABLE public.email_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "emails own or manager" ON public.email_logs
  FOR SELECT TO authenticated
  USING (user_id = auth.uid()
    OR public.has_role(auth.uid(),'admin'::app_role) OR public.has_role(auth.uid(),'owner'::app_role)
    OR public.has_role(auth.uid(),'dev'::app_role) OR public.has_role(auth.uid(),'regional'::app_role)
    OR public.has_role(auth.uid(),'location_manager'::app_role) OR public.has_role(auth.uid(),'sales_manager'::app_role));

CREATE TABLE public.translations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  field text NOT NULL,
  lang text NOT NULL,
  source_text text,
  text text NOT NULL,
  source public.translation_source NOT NULL DEFAULT 'machine',
  corrected_by uuid,
  corrected_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_type, entity_id, field, lang)
);
GRANT SELECT, INSERT, UPDATE ON public.translations TO authenticated;
GRANT ALL ON public.translations TO service_role;
ALTER TABLE public.translations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "translations readable" ON public.translations
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "translations writable" ON public.translations
  FOR INSERT TO authenticated WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "translations correctable" ON public.translations
  FOR UPDATE TO authenticated USING (auth.uid() IS NOT NULL) WITH CHECK (auth.uid() IS NOT NULL);

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS language text NOT NULL DEFAULT 'en';

CREATE TRIGGER integration_connections_updated_at BEFORE UPDATE ON public.integration_connections
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER vehicles_updated_at BEFORE UPDATE ON public.vehicles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER calendar_events_updated_at BEFORE UPDATE ON public.calendar_events
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER translations_updated_at BEFORE UPDATE ON public.translations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();