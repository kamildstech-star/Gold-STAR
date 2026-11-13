ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS billing_location_id uuid REFERENCES public.locations(id);

UPDATE public.jobs SET billing_location_id = location_id WHERE billing_location_id IS NULL;

CREATE INDEX IF NOT EXISTS jobs_billing_location_id_idx ON public.jobs (billing_location_id);

CREATE OR REPLACE FUNCTION public.resolve_billing_location(
  _region text,
  _lat double precision DEFAULT NULL,
  _lon double precision DEFAULT NULL
)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT l.id
  FROM public.locations l
  WHERE l.active
    AND _region IS NOT NULL
    AND upper(btrim(l.region)) = upper(btrim(_region))
  ORDER BY
    CASE
      WHEN _lat IS NULL OR _lon IS NULL OR l.lat IS NULL OR l.lon IS NULL THEN 1
      ELSE 0
    END,
    CASE
      WHEN _lat IS NULL OR _lon IS NULL OR l.lat IS NULL OR l.lon IS NULL THEN 0
      ELSE ((l.lat - _lat) ^ 2) + ((l.lon - _lon) ^ 2)
    END,
    l.code
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_billing_location(text, double precision, double precision) TO authenticated;