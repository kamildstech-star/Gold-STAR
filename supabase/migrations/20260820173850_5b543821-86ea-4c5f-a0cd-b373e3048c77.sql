CREATE OR REPLACE FUNCTION public.jobs_set_billing_location()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.billing_location_id IS NULL THEN
    NEW.billing_location_id := COALESCE(
      public.resolve_billing_location(NEW.region, NEW.lat, NEW.lon),
      NEW.location_id
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS jobs_set_billing_location_trg ON public.jobs;
CREATE TRIGGER jobs_set_billing_location_trg
BEFORE INSERT ON public.jobs
FOR EACH ROW EXECUTE FUNCTION public.jobs_set_billing_location();