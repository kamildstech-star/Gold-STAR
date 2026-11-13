ALTER TABLE public.incidents
  ADD COLUMN IF NOT EXISTS arrival_method text,
  ADD COLUMN IF NOT EXISTS arrival_accuracy_m numeric,
  ADD COLUMN IF NOT EXISTS arrival_vehicle_id uuid REFERENCES public.vehicles(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'incidents_arrival_method_chk') THEN
    ALTER TABLE public.incidents
      ADD CONSTRAINT incidents_arrival_method_chk
      CHECK (arrival_method IS NULL OR arrival_method IN ('raven_gps','app_proximity','manual'));
  END IF;
END $$;

-- Vehicle GPS arrival: the most reliable signal, and the one the chaser cannot forget.
CREATE OR REPLACE FUNCTION public.stamp_arrival_from_position(
  _vehicle_id uuid,
  _lat double precision,
  _lon double precision,
  _occurred_at timestamptz,
  _speed_mph numeric DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _driver uuid;
  _inc uuid;
BEGIN
  IF _lat IS NULL OR _lon IS NULL THEN RETURN NULL; END IF;
  IF _speed_mph IS NOT NULL AND _speed_mph > 3 THEN RETURN NULL; END IF;

  SELECT assigned_user_id INTO _driver FROM public.vehicles WHERE id = _vehicle_id;
  IF _driver IS NULL THEN RETURN NULL; END IF;

  SELECT i.id INTO _inc
  FROM public.incidents i
  WHERE i.accepted_by = _driver
    AND i.arrived_at IS NULL
    AND i.outcome IS NULL
    AND i.accepted_at IS NOT NULL
    AND i.accepted_at > _occurred_at - interval '8 hours'
    AND i.lat IS NOT NULL AND i.lon IS NOT NULL
    AND ST_DWithin(
          ST_SetSRID(ST_MakePoint(i.lon, i.lat), 4326)::geography,
          ST_SetSRID(ST_MakePoint(_lon, _lat), 4326)::geography,
          100)
  ORDER BY i.accepted_at DESC
  LIMIT 1;

  IF _inc IS NULL THEN RETURN NULL; END IF;

  UPDATE public.incidents
     SET arrived_at = _occurred_at,
         arrived_lat = _lat,
         arrived_lon = _lon,
         status = 'on_scene',
         arrival_method = 'raven_gps',
         arrival_vehicle_id = _vehicle_id
   WHERE id = _inc;

  INSERT INTO public.incident_events (incident_id, event_type, actor_id, lat, lon, payload)
  VALUES (_inc, 'arrived', _driver, _lat, _lon,
          jsonb_build_object('method', 'raven_gps', 'vehicle_id', _vehicle_id));

  RETURN _inc;
END $$;

REVOKE ALL ON FUNCTION public.stamp_arrival_from_position(uuid, double precision, double precision, timestamptz, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stamp_arrival_from_position(uuid, double precision, double precision, timestamptz, numeric) TO service_role;

-- App-focus proximity: the device says where it is, the server decides whether that counts.
CREATE OR REPLACE FUNCTION public.stamp_arrival_proximity(
  _incident_id uuid,
  _lat double precision,
  _lon double precision,
  _accuracy_m numeric DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _ok boolean;
BEGIN
  SELECT true INTO _ok
  FROM public.incidents i
  WHERE i.id = _incident_id
    AND i.accepted_by = auth.uid()
    AND i.arrived_at IS NULL
    AND i.outcome IS NULL
    AND i.lat IS NOT NULL AND i.lon IS NOT NULL
    AND ST_DWithin(
          ST_SetSRID(ST_MakePoint(i.lon, i.lat), 4326)::geography,
          ST_SetSRID(ST_MakePoint(_lon, _lat), 4326)::geography,
          150);

  IF _ok IS NOT TRUE THEN RETURN false; END IF;

  UPDATE public.incidents
     SET arrived_at = now(),
         arrived_lat = _lat,
         arrived_lon = _lon,
         status = 'on_scene',
         arrival_method = 'app_proximity',
         arrival_accuracy_m = _accuracy_m
   WHERE id = _incident_id;

  INSERT INTO public.incident_events (incident_id, event_type, actor_id, lat, lon, payload)
  VALUES (_incident_id, 'arrived', auth.uid(), _lat, _lon,
          jsonb_build_object('method', 'app_proximity', 'accuracy_m', _accuracy_m));

  RETURN true;
END $$;

REVOKE ALL ON FUNCTION public.stamp_arrival_proximity(uuid, double precision, double precision, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stamp_arrival_proximity(uuid, double precision, double precision, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.stamp_arrival_proximity(uuid, double precision, double precision, numeric) TO service_role;

-- Property lookup cache. One paid lookup per incident, on accept only.
CREATE TABLE IF NOT EXISTS public.incident_property_lookups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL UNIQUE REFERENCES public.incidents(id) ON DELETE CASCADE,
  provider text NOT NULL,
  owner_name text,
  owner_phone text,
  owner_email text,
  owner_occupied boolean,
  unit_count integer,
  year_built integer,
  last_sale_date date,
  last_sale_amount numeric,
  mailing_address text,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  looked_up_by uuid,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.incident_property_lookups TO authenticated;
GRANT ALL ON public.incident_property_lookups TO service_role;

ALTER TABLE public.incident_property_lookups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS incident_property_lookups_select ON public.incident_property_lookups;
CREATE POLICY incident_property_lookups_select
  ON public.incident_property_lookups
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.incidents i WHERE i.id = incident_id));

DROP TRIGGER IF EXISTS trg_incident_property_lookups_updated_at ON public.incident_property_lookups;
CREATE TRIGGER trg_incident_property_lookups_updated_at
  BEFORE UPDATE ON public.incident_property_lookups
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Where a neighbour lead came from: the origin of its exposure group.
CREATE OR REPLACE FUNCTION public.exposure_origin_address(_incident_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT o.address
  FROM public.incidents c
  JOIN public.incidents o
    ON o.exposure_group_id = c.exposure_group_id
   AND COALESCE(o.is_exposure, false) = false
  WHERE c.id = _incident_id
    AND COALESCE(c.is_exposure, false) = true
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION public.exposure_origin_address(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.exposure_origin_address(uuid) TO authenticated, service_role;

-- Same answer for a job, which reaches its incident through incidents.job_id.
CREATE OR REPLACE FUNCTION public.job_exposure_origin_address(_job_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT public.exposure_origin_address(i.id)
  FROM public.incidents i
  WHERE i.job_id = _job_id
    AND COALESCE(i.is_exposure, false) = true
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION public.job_exposure_origin_address(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.job_exposure_origin_address(uuid) TO authenticated, service_role;