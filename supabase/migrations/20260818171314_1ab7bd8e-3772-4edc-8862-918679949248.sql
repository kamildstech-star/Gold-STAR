ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS estimate_id uuid REFERENCES public.estimates(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS invoices_estimate_id_idx ON public.invoices(estimate_id);

CREATE OR REPLACE FUNCTION public.tg_invoice_job_rollup()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _job uuid := COALESCE(NEW.job_id, OLD.job_id);
BEGIN
  IF _job IS NULL THEN
    RETURN NULL;
  END IF;
  UPDATE public.jobs j
     SET billed_amount = agg.billed,
         approved_amount = agg.approved,
         collected_amount = agg.collected
    FROM (
      SELECT COALESCE(SUM(billed_amount), 0) AS billed,
             NULLIF(COALESCE(SUM(approved_amount), 0), 0) AS approved,
             COALESCE(SUM(collected_amount), 0) AS collected
        FROM public.invoices
       WHERE job_id = _job
    ) agg
   WHERE j.id = _job
     AND EXISTS (SELECT 1 FROM public.invoices WHERE job_id = _job);
  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.tg_invoice_job_rollup() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS invoices_job_rollup ON public.invoices;
CREATE TRIGGER invoices_job_rollup
AFTER INSERT OR UPDATE OF billed_amount, approved_amount, collected_amount, job_id OR DELETE
ON public.invoices
FOR EACH ROW EXECUTE FUNCTION public.tg_invoice_job_rollup();