-- 1. GIST index on geom for spatial queries
CREATE INDEX IF NOT EXISTS fire_leads_geom_gix ON public.fire_leads USING GIST (geom);

-- 2. Trigger: keep geom in sync with lat/lon, and route to nearest location
--    when location_id is null. Never overwrites a human assignment because
--    the trigger only assigns when NEW.location_id IS NULL.
CREATE OR REPLACE FUNCTION public.set_fire_lead_geo()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.lat IS NOT NULL AND NEW.lon IS NOT NULL THEN
    NEW.geom := ST_SetSRID(ST_MakePoint(NEW.lon, NEW.lat), 4326)::geography;
  ELSE
    NEW.geom := NULL;
  END IF;

  IF NEW.location_id IS NULL AND NEW.lat IS NOT NULL AND NEW.lon IS NOT NULL THEN
    NEW.location_id := public.nearest_location(NEW.lat, NEW.lon, 75);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_fire_leads_set_geo ON public.fire_leads;
CREATE TRIGGER trg_fire_leads_set_geo
BEFORE INSERT OR UPDATE OF lat, lon, location_id
ON public.fire_leads
FOR EACH ROW EXECUTE FUNCTION public.set_fire_lead_geo();

-- 3. Backfill existing 4,726 rows. Rows with null lat/lon are left unrouted.
UPDATE public.fire_leads
SET geom = ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography
WHERE geom IS NULL AND lat IS NOT NULL AND lon IS NOT NULL;

UPDATE public.fire_leads
SET location_id = public.nearest_location(lat, lon, 75)
WHERE location_id IS NULL AND lat IS NOT NULL AND lon IS NOT NULL;
