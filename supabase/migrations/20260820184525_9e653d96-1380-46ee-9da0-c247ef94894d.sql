ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS priority text;

CREATE TABLE IF NOT EXISTS public.job_field_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  field text NOT NULL,
  old_value text,
  new_value text,
  changed_by uuid,
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS job_field_changes_job_idx ON public.job_field_changes (job_id, changed_at DESC);

GRANT SELECT ON public.job_field_changes TO authenticated;
GRANT ALL ON public.job_field_changes TO service_role;

ALTER TABLE public.job_field_changes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "read job change log" ON public.job_field_changes;
CREATE POLICY "read job change log" ON public.job_field_changes
  FOR SELECT TO authenticated
  USING (public.can_view_job(auth.uid(), job_id));

CREATE OR REPLACE FUNCTION public.log_job_field_changes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  col record;
  old_v text;
  new_v text;
  actor uuid := auth.uid();
BEGIN
  FOR col IN
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'jobs'
      AND column_name NOT IN ('id','created_at','updated_at','geom','stage_entered_at','created_by')
  LOOP
    EXECUTE format('SELECT ($1).%I::text, ($2).%I::text', col.column_name, col.column_name)
      INTO old_v, new_v
      USING OLD, NEW;
    IF old_v IS DISTINCT FROM new_v THEN
      INSERT INTO public.job_field_changes (job_id, field, old_value, new_value, changed_by)
      VALUES (NEW.id, col.column_name, old_v, new_v, actor);
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS jobs_log_field_changes ON public.jobs;
CREATE TRIGGER jobs_log_field_changes
AFTER UPDATE ON public.jobs
FOR EACH ROW EXECUTE FUNCTION public.log_job_field_changes();