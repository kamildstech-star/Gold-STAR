CREATE TABLE public.geocode_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  query text NOT NULL UNIQUE,
  formatted_address text,
  lat double precision,
  lon double precision,
  provider text NOT NULL DEFAULT 'none',
  resolved boolean NOT NULL DEFAULT false,
  raw jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.geocode_cache TO authenticated;
GRANT ALL ON public.geocode_cache TO service_role;

ALTER TABLE public.geocode_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Signed-in staff can read the geocode cache"
  ON public.geocode_cache FOR SELECT TO authenticated USING (true);

CREATE TRIGGER update_geocode_cache_updated_at
  BEFORE UPDATE ON public.geocode_cache
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.undo_exposure_incident(_incident_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.incidents%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM public.incidents WHERE id = _incident_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- Only the chaser who just tapped it, only while it is still untouched.
  IF v_row.created_by IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Only the person who added this exposure can undo it';
  END IF;
  IF v_row.created_at < now() - interval '10 minutes' THEN
    RAISE EXCEPTION 'Too late to undo this exposure';
  END IF;
  IF v_row.outcome IS NOT NULL THEN
    RAISE EXCEPTION 'This exposure already has an outcome';
  END IF;
  IF EXISTS (SELECT 1 FROM public.incident_dispatches d WHERE d.incident_id = _incident_id) THEN
    RAISE EXCEPTION 'This exposure has already been dispatched';
  END IF;

  DELETE FROM public.incidents WHERE id = _incident_id;
  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.undo_exposure_incident(uuid) TO authenticated;