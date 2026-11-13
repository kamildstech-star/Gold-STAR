-- TM3 (27 Oct 2026): the T&M bill's fee and multiplier rules, per job.
--
-- WRITTEN, NOT APPLIED. Run by hand after 20261027130000_seller_billing_not_costs.sql
-- (can_view_job_costs).
--
-- The rules themselves are set once in Settings (app_settings key
-- 'tm.bill_rules', no schema change). This table is a job's override, laid
-- over Settings key by key (src/lib/tm-bill-rules.ts): Small Tools %, Per
-- Diem, O&P %, pass-through markup, standard hours, overtime threshold,
-- weekend days, holidays, multipliers, the job's tax rate, the OH fee and
-- the labor code field-form crew bills at.
--
-- Anyone who can see the job reads it (the bill shows which rules applied);
-- only a caller who may see the job's costs — who bills it — changes it.

CREATE TABLE IF NOT EXISTS public.job_tm_settings (
  job_id uuid PRIMARY KEY REFERENCES public.jobs(id) ON DELETE CASCADE,
  rules jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(rules) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid DEFAULT auth.uid()
);

ALTER TABLE public.job_tm_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.job_tm_settings FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.job_tm_settings TO authenticated;
GRANT ALL ON public.job_tm_settings TO service_role;

DROP POLICY IF EXISTS job_tm_settings_read ON public.job_tm_settings;
CREATE POLICY job_tm_settings_read ON public.job_tm_settings
  FOR SELECT TO authenticated
  USING (public.can_view_job(auth.uid(), job_id));

DROP POLICY IF EXISTS job_tm_settings_write ON public.job_tm_settings;
CREATE POLICY job_tm_settings_write ON public.job_tm_settings
  FOR ALL TO authenticated
  USING (public.can_view_job_costs(job_id))
  WITH CHECK (public.can_view_job_costs(job_id));

CREATE OR REPLACE FUNCTION public.tg_job_tm_settings_touch()
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
REVOKE ALL ON FUNCTION public.tg_job_tm_settings_touch() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS job_tm_settings_touch ON public.job_tm_settings;
CREATE TRIGGER job_tm_settings_touch BEFORE INSERT OR UPDATE ON public.job_tm_settings
  FOR EACH ROW EXECUTE FUNCTION public.tg_job_tm_settings_touch();
