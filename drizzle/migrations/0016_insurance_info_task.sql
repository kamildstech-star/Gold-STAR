CREATE UNIQUE INDEX IF NOT EXISTS tasks_one_open_insurance_info_per_job
  ON public.tasks (job_id)
  WHERE source = 'insurance_info_missing' AND status IN ('open', 'in_progress');
CREATE OR REPLACE FUNCTION public.insurance_info_missing(j public.jobs)
RETURNS text[]
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN j.job_type IS DISTINCT FROM 'insurance' OR j.status IN ('paid', 'cancelled')
      THEN ARRAY[]::text[]
    ELSE array_remove(ARRAY[
      CASE WHEN nullif(btrim(coalesce(j.insurance_carrier_account_id::text, '')), '') IS NULL
            AND nullif(btrim(coalesce(j.insurance_carrier, '')), '') IS NULL
        THEN 'Carrier' END,
      CASE WHEN nullif(btrim(coalesce(j.policy_number, '')), '') IS NULL
        THEN 'Policy #' END,
      CASE WHEN nullif(btrim(coalesce(j.claim_number, '')), '') IS NULL
        THEN 'Claim #' END,
      CASE WHEN nullif(btrim(coalesce(j.adjuster_name, '')), '') IS NULL
            AND nullif(btrim(coalesce(j.desk_adjuster_name, '')), '') IS NULL
            AND j.desk_adjuster_contact_id IS NULL
            AND nullif(btrim(coalesce(j.field_adjuster_name, '')), '') IS NULL
            AND j.field_adjuster_contact_id IS NULL
        THEN 'Carrier adjuster' END,
      CASE WHEN j.public_adjuster_account_id IS NULL
            AND j.public_adjuster_contact_id IS NULL
            AND nullif(btrim(coalesce(j.public_adjuster_name, '')), '') IS NULL
        THEN 'Public adjuster' END
    ], NULL)
  END;
$$;
CREATE OR REPLACE FUNCTION public.sync_insurance_info_task(_job_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  j public.jobs;
  missing text[];
  open_task public.tasks;
  _title text;
  _body text;
BEGIN
  SELECT * INTO j FROM public.jobs WHERE id = _job_id;
  IF NOT FOUND THEN RETURN; END IF;
  missing := public.insurance_info_missing(j);
  SELECT * INTO open_task FROM public.tasks
  WHERE job_id = _job_id
    AND source = 'insurance_info_missing'
    AND status IN ('open', 'in_progress')
  LIMIT 1;
  IF coalesce(array_length(missing, 1), 0) = 0 THEN
    IF open_task.id IS NOT NULL THEN
      UPDATE public.tasks
      SET status = CASE WHEN j.job_type = 'insurance' AND j.status NOT IN ('paid', 'cancelled')
                        THEN 'done'::public.task_status
                        ELSE 'cancelled'::public.task_status END,
          completed_at = now(),
          description = CASE WHEN j.job_type = 'insurance' AND j.status NOT IN ('paid', 'cancelled')
                             THEN 'Resolved: every critical insurance detail is on the job.'
                             ELSE 'No longer applies: this is not an open insurance job.' END,
          updated_at = now()
      WHERE id = open_task.id;
    END IF;
    RETURN;
  END IF;
  _title := 'Insurance info missing: ' || array_to_string(missing, ', ');
  _body := 'This insurance job cannot be billed without these. The task closes itself '
       || 'when all five are filled in on the job''s Insurance card: carrier, policy #, '
       || 'claim #, carrier adjuster and public adjuster.';
  IF open_task.id IS NOT NULL THEN
    IF open_task.title IS DISTINCT FROM _title THEN
      UPDATE public.tasks SET title = _title, updated_at = now() WHERE id = open_task.id;
    END IF;
    RETURN;
  END IF;
  INSERT INTO public.tasks
    (title, description, status, priority, due_date, entity_type, entity_id,
     job_id, account_id, location_id, source, automation_reason)
  VALUES
    (_title, _body, 'open', 'high', current_date, 'job', j.id,
     j.id, j.account_id, j.location_id, 'insurance_info_missing',
     'Insurance job missing critical details')
  ON CONFLICT (job_id)
    WHERE source = 'insurance_info_missing' AND status IN ('open', 'in_progress')
    DO NOTHING;
END;
$$;
CREATE OR REPLACE FUNCTION public.jobs_insurance_info_task_trg()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.sync_insurance_info_task(NEW.id);
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS jobs_insurance_info_task ON public.jobs;
CREATE TRIGGER jobs_insurance_info_task
  AFTER INSERT OR UPDATE OF
    job_type, status, stage_id, insurance_carrier, insurance_carrier_account_id,
    policy_number, claim_number, adjuster_name,
    desk_adjuster_name, desk_adjuster_contact_id,
    field_adjuster_name, field_adjuster_contact_id,
    public_adjuster_name, public_adjuster_contact_id, public_adjuster_account_id
  ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.jobs_insurance_info_task_trg();
CREATE OR REPLACE FUNCTION public.sweep_insurance_info_tasks()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  r record;
  n integer := 0;
BEGIN
  FOR r IN
    SELECT j.id FROM public.jobs j
    WHERE (j.job_type = 'insurance' AND j.status NOT IN ('paid', 'cancelled'))
       OR EXISTS (
         SELECT 1 FROM public.tasks t
         WHERE t.job_id = j.id AND t.source = 'insurance_info_missing'
           AND t.status IN ('open', 'in_progress')
       )
  LOOP
    PERFORM public.sync_insurance_info_task(r.id);
    n := n + 1;
  END LOOP;
  RETURN n;
END;
$$;
REVOKE ALL ON FUNCTION public.sync_insurance_info_task(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sweep_insurance_info_tasks() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.jobs_insurance_info_task_trg() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.insurance_info_missing(public.jobs) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.insurance_info_missing(public.jobs) TO authenticated;
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron is not installed; insurance-info-tasks remains unscheduled.';
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'insurance-info-tasks') THEN
    PERFORM cron.unschedule('insurance-info-tasks');
  END IF;
  PERFORM cron.schedule(
    'insurance-info-tasks',
    '0 11 * * *',
    $cron$SELECT public.sweep_insurance_info_tasks();$cron$
  );
END
$do$;
SELECT public.sweep_insurance_info_tasks();