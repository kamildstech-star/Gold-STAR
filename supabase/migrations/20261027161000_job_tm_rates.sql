-- TM2 (27 Oct 2026): each job carries its own T&M rate sheet.
--
-- WRITTEN, NOT APPLIED. Run by hand after 20261027160000_tm_rate_catalog_costs.sql
-- and 20261027130000_seller_billing_not_costs.sql (can_view_job_costs).
--
-- A job's rates are a LAYER over Settings › T&M rate codes:
--   * a row here for (job, code) is that job's rate, and it wins;
--   * no row: the job reads the Settings rate, live.
-- Job-sticky: a new job copies every Settings rate that is set at the moment
-- it is created (trigger below), so a later change in Settings never re-prices
-- a job already running. Existing jobs that already have T&M daily forms get
-- the same snapshot now; other existing jobs keep reading Settings until a
-- rate is set for them.
--
-- "No rate set for 100, 102 … — billed at $0" becomes "set the rate for this
-- job": one upsert of one row here.
--
-- cost_rate is internal: withheld from `authenticated` by column grants and
-- read through job_tm_rate_costs(job), which answers only a caller who may
-- see that job's costs (can_view_job_costs).

CREATE TABLE IF NOT EXISTS public.job_tm_rates (
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  code text NOT NULL REFERENCES public.tm_rate_codes(code),
  rate numeric(10,2) CHECK (rate IS NULL OR rate >= 0),
  cost_rate numeric(10,2) CHECK (cost_rate IS NULL OR cost_rate >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid DEFAULT auth.uid(),
  PRIMARY KEY (job_id, code)
);

ALTER TABLE public.job_tm_rates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.job_tm_rates FROM anon, authenticated;
GRANT SELECT (job_id, code, rate, updated_at, updated_by) ON public.job_tm_rates TO authenticated;
GRANT INSERT (job_id, code, rate, cost_rate), UPDATE (rate, cost_rate), DELETE
  ON public.job_tm_rates TO authenticated;
GRANT ALL ON public.job_tm_rates TO service_role;

DROP POLICY IF EXISTS job_tm_rates_read ON public.job_tm_rates;
CREATE POLICY job_tm_rates_read ON public.job_tm_rates
  FOR SELECT TO authenticated
  USING (public.can_view_job(auth.uid(), job_id));

-- Who bills the job sets its rates: finance, or job.view_costs at its office.
DROP POLICY IF EXISTS job_tm_rates_write ON public.job_tm_rates;
CREATE POLICY job_tm_rates_write ON public.job_tm_rates
  FOR ALL TO authenticated
  USING (public.can_view_job_costs(job_id))
  WITH CHECK (public.can_view_job_costs(job_id));

CREATE OR REPLACE FUNCTION public.tg_job_tm_rates_touch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := now();
  NEW.updated_by := auth.uid();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_job_tm_rates_touch() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS job_tm_rates_touch ON public.job_tm_rates;
CREATE TRIGGER job_tm_rates_touch BEFORE INSERT OR UPDATE ON public.job_tm_rates
  FOR EACH ROW EXECUTE FUNCTION public.tg_job_tm_rates_touch();

-- A job's cost rates, for those who may see its costs.
CREATE OR REPLACE FUNCTION public.job_tm_rate_costs(_job_id uuid)
RETURNS TABLE (code text, cost_rate numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT r.code, r.cost_rate
    FROM public.job_tm_rates r
   WHERE r.job_id = _job_id
     AND public.can_view_job_costs(_job_id);
$$;
REVOKE ALL ON FUNCTION public.job_tm_rate_costs(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.job_tm_rate_costs(uuid) TO authenticated, service_role;

-- New jobs: snapshot the Settings rates that are set (job-sticky).
CREATE OR REPLACE FUNCTION public.tg_jobs_snapshot_tm_rates()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.job_tm_rates (job_id, code, rate, cost_rate)
  SELECT NEW.id, t.code, t.rate, t.cost_rate
    FROM public.tm_rate_codes t
   WHERE t.active AND (t.rate IS NOT NULL OR t.cost_rate IS NOT NULL)
  ON CONFLICT (job_id, code) DO NOTHING;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_jobs_snapshot_tm_rates() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS jobs_snapshot_tm_rates ON public.jobs;
CREATE TRIGGER jobs_snapshot_tm_rates AFTER INSERT ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.tg_jobs_snapshot_tm_rates();

-- Jobs already billing T&M: the same snapshot, once.
INSERT INTO public.job_tm_rates (job_id, code, rate, cost_rate)
SELECT DISTINCT f.job_id, t.code, t.rate, t.cost_rate
  FROM public.job_tm_forms f
  CROSS JOIN public.tm_rate_codes t
 WHERE t.active AND (t.rate IS NOT NULL OR t.cost_rate IS NOT NULL)
ON CONFLICT (job_id, code) DO NOTHING;
