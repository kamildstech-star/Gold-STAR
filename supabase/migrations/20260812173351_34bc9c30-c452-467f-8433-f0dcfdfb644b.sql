-- Chasers drive personal cars: there is no vehicle telematics to read here.
DROP FUNCTION IF EXISTS public.stamp_arrival_from_position(uuid, double precision, double precision, timestamptz, numeric);
DROP FUNCTION IF EXISTS public.stamp_arrival_from_position(uuid, double precision, double precision, timestamptz, double precision);

ALTER TABLE public.incidents DROP COLUMN IF EXISTS arrival_vehicle_id;

ALTER TABLE public.incidents DROP CONSTRAINT IF EXISTS incidents_arrival_method_chk;
UPDATE public.incidents SET arrival_method = 'manual' WHERE arrival_method = 'raven_gps';
ALTER TABLE public.incidents
  ADD CONSTRAINT incidents_arrival_method_chk
  CHECK (arrival_method IS NULL OR arrival_method IN ('first_action','app_proximity','manual'));

-- The strongest signal available: they are doing something that can only be
-- done on scene, so stamp arrival from that instead of asking for a tap.
CREATE OR REPLACE FUNCTION public.stamp_arrival_from_action(
  _incident_id uuid,
  _action text,
  _lat double precision DEFAULT NULL,
  _lon double precision DEFAULT NULL,
  _accuracy_m double precision DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _row public.incidents%ROWTYPE;
BEGIN
  SELECT * INTO _row FROM public.incidents WHERE id = _incident_id;
  IF NOT FOUND THEN RETURN false; END IF;
  IF _row.arrived_at IS NOT NULL THEN RETURN false; END IF;
  IF _row.accepted_by IS DISTINCT FROM auth.uid() THEN RETURN false; END IF;

  UPDATE public.incidents
     SET arrived_at = now(),
         arrived_lat = COALESCE(_lat, arrived_lat),
         arrived_lon = COALESCE(_lon, arrived_lon),
         arrival_accuracy_m = _accuracy_m,
         arrival_method = 'first_action',
         status = CASE WHEN status = 'accepted' THEN 'on_scene' ELSE status END
   WHERE id = _incident_id;

  INSERT INTO public.incident_events (incident_id, event_type, actor_id, lat, lon, payload)
  VALUES (_incident_id, 'arrived', auth.uid(), _lat, _lon,
          jsonb_build_object('method', 'first_action', 'action', _action));

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.stamp_arrival_from_action(uuid, text, double precision, double precision, double precision) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stamp_arrival_from_action(uuid, text, double precision, double precision, double precision) TO authenticated;