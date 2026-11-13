-- 1. Jobs pipeline seeded from the current job_status enum
DO $$
DECLARE v_pipeline uuid;
BEGIN
  SELECT id INTO v_pipeline FROM public.pipelines
   WHERE entity_type = 'job' AND location_id IS NULL AND is_default;

  IF v_pipeline IS NULL THEN
    INSERT INTO public.pipelines (name, entity_type, location_id, is_default, is_active, kind)
    VALUES ('Jobs', 'job', NULL, true, true, 'other')
    RETURNING id INTO v_pipeline;
  END IF;

  INSERT INTO public.pipeline_stages (pipeline_id, key, name, sort_order, color, probability, is_won, is_lost, is_intake, is_exit)
  VALUES
    (v_pipeline, 'new',         'New',         10, '#64748B',  0, false, false, true,  false),
    (v_pipeline, 'scheduled',   'Scheduled',   20, '#2563EB', 20, false, false, false, false),
    (v_pipeline, 'in_progress', 'In progress', 30, '#1B5FA8', 40, false, false, false, false),
    (v_pipeline, 'drying',      'Drying',      40, '#0EA5E9', 55, false, false, false, false),
    (v_pipeline, 'complete',    'Complete',    50, '#059669', 75, false, false, false, false),
    (v_pipeline, 'invoiced',    'Invoiced',    60, '#B8A030', 90, false, false, false, false),
    (v_pipeline, 'paid',        'Paid',        70, '#047857',100, true,  false, false, true),
    (v_pipeline, 'cancelled',   'Cancelled',   80, '#E31B23',  0, false, true,  false, true)
  ON CONFLICT (pipeline_id, key) DO NOTHING;
END $$;

-- 2. jobs.stage_id
ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS pipeline_id uuid REFERENCES public.pipelines(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS stage_id uuid REFERENCES public.pipeline_stages(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS stage_entered_at timestamptz;

CREATE INDEX IF NOT EXISTS jobs_stage_idx ON public.jobs (stage_id);

-- 3. Backfill existing jobs by matching enum value to stage key
UPDATE public.jobs j
   SET stage_id = s.id,
       pipeline_id = s.pipeline_id,
       stage_entered_at = COALESCE(j.stage_entered_at, j.updated_at, j.created_at)
  FROM public.pipeline_stages s
  JOIN public.pipelines p ON p.id = s.pipeline_id
 WHERE p.entity_type = 'job' AND p.location_id IS NULL AND p.is_default
   AND s.key = j.status::text
   AND j.stage_id IS NULL;

-- 4. Keep the two in sync in both directions until the enum column is dropped
CREATE OR REPLACE FUNCTION public.jobs_sync_stage_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_stage public.pipeline_stages%ROWTYPE;
  v_pipeline uuid;
BEGIN
  -- stage drives status when it is set or changed
  IF NEW.stage_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.stage_id IS DISTINCT FROM OLD.stage_id) THEN
    SELECT * INTO v_stage FROM public.pipeline_stages WHERE id = NEW.stage_id;
    NEW.pipeline_id := v_stage.pipeline_id;
    NEW.stage_entered_at := now();
    IF v_stage.key IN ('new','scheduled','in_progress','drying','complete','invoiced','paid','cancelled') THEN
      NEW.status := v_stage.key::public.job_status;
    ELSIF v_stage.is_won THEN
      NEW.status := 'complete'::public.job_status;
    ELSIF v_stage.is_lost THEN
      NEW.status := 'cancelled'::public.job_status;
    ELSE
      NEW.status := 'in_progress'::public.job_status;
    END IF;
    RETURN NEW;
  END IF;

  -- otherwise resolve a stage from the legacy enum value
  IF NEW.stage_id IS NULL OR (TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status) THEN
    SELECT s.id, s.pipeline_id INTO v_stage.id, v_pipeline
      FROM public.pipeline_stages s
      JOIN public.pipelines p ON p.id = s.pipeline_id
     WHERE p.entity_type = 'job'
       AND p.is_default
       AND (p.location_id IS NULL OR p.location_id = NEW.location_id)
       AND s.key = NEW.status::text
     ORDER BY (p.location_id IS NOT NULL) DESC
     LIMIT 1;
    IF v_stage.id IS NOT NULL THEN
      NEW.stage_id := v_stage.id;
      NEW.pipeline_id := v_pipeline;
      NEW.stage_entered_at := COALESCE(NEW.stage_entered_at, now());
    END IF;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_jobs_sync_stage_status ON public.jobs;
CREATE TRIGGER trg_jobs_sync_stage_status
BEFORE INSERT OR UPDATE ON public.jobs
FOR EACH ROW EXECUTE FUNCTION public.jobs_sync_stage_status();

-- 5. Remove the decorative option list (single source of truth is now pipeline_stages)
DELETE FROM public.option_lists WHERE key = 'job_status';
