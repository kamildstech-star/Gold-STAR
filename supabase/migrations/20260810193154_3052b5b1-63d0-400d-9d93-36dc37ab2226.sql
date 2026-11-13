CREATE TABLE public.location_regions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  region_id uuid NOT NULL REFERENCES public.regions(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (location_id, region_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.location_regions TO authenticated;
GRANT ALL ON public.location_regions TO service_role;

ALTER TABLE public.location_regions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "location_regions_select" ON public.location_regions
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "location_regions_write" ON public.location_regions
  FOR ALL TO authenticated
  USING (public.is_privileged((select auth.uid())))
  WITH CHECK (public.is_privileged((select auth.uid())));

CREATE INDEX location_regions_region_idx ON public.location_regions(region_id);
CREATE INDEX location_regions_location_idx ON public.location_regions(location_id);

INSERT INTO public.location_regions (location_id, region_id)
SELECT id, region_id FROM public.locations WHERE region_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- keep legacy locations.region_id populated with the first assigned region
CREATE OR REPLACE FUNCTION public.sync_location_primary_region()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _loc uuid := COALESCE(NEW.location_id, OLD.location_id);
BEGIN
  UPDATE public.locations l
  SET region_id = (
    SELECT lr.region_id FROM public.location_regions lr
    WHERE lr.location_id = _loc
    ORDER BY lr.created_at
    LIMIT 1
  )
  WHERE l.id = _loc;
  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_location_regions_sync
AFTER INSERT OR UPDATE OR DELETE ON public.location_regions
FOR EACH ROW EXECUTE FUNCTION public.sync_location_primary_region();

-- regional scope now honours all regions a location belongs to
CREATE OR REPLACE FUNCTION public.is_regional_for(_user_id uuid, _location_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF _user_id IS NULL OR _location_id IS NULL THEN
    RETURN false;
  END IF;
  IF NOT public.has_role(_user_id, 'regional'::app_role) THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1
    FROM public.region_members rm
    JOIN public.location_regions lr ON lr.region_id = rm.region_id
    WHERE rm.user_id = _user_id AND lr.location_id = _location_id
  );
END;
$$;