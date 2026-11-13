CREATE OR REPLACE FUNCTION public.jobs_before_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND (NEW.job_number IS NULL OR NEW.job_number = '') THEN
    NEW.job_number := public.next_job_number();
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.job_number IS DISTINCT FROM OLD.job_number THEN
    RAISE EXCEPTION 'job_number is immutable once assigned';
  END IF;
  IF NEW.lat IS NOT NULL AND NEW.lon IS NOT NULL THEN
    NEW.geom := ST_SetSRID(ST_MakePoint(NEW.lon, NEW.lat), 4326)::geography;
  ELSE
    NEW.geom := NULL;
  END IF;
  IF TG_OP = 'UPDATE' THEN NEW.updated_at := now(); END IF;
  RETURN NEW;
END $$;

COMMENT ON FUNCTION public.jobs_before_write() IS
  'BEFORE INSERT OR UPDATE on public.jobs: allocates job_number, enforces its immutability, derives geom, stamps updated_at. SECURITY DEFINER so it can call next_job_number(), which stays revoked from anon and authenticated so end users cannot burn job numbers directly. See 20260914090000.';