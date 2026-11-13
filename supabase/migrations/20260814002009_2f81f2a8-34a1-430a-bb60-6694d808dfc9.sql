CREATE OR REPLACE FUNCTION public.tg_account_stage_normalize()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE s public.pipeline_stages%ROWTYPE;
BEGIN
  -- Shared reference records (carriers, public adjusting firms) are not prospects.
  IF COALESCE(NEW.is_reference, false) THEN
    NEW.pipeline_id := NULL;
    NEW.stage_id := NULL;
    NEW.stage := 'reference';
    RETURN NEW;
  END IF;

  IF NEW.stage_id IS NULL THEN
    IF NEW.pipeline_id IS NULL THEN
      NEW.pipeline_id := public.default_pipeline_for(NEW.location_id, 'account');
    END IF;
    SELECT * INTO s FROM public.pipeline_stages ps
      WHERE ps.pipeline_id = NEW.pipeline_id AND ps.key = COALESCE(NEW.stage, 'target');
    IF NOT FOUND THEN
      SELECT * INTO s FROM public.pipeline_stages ps
        WHERE ps.pipeline_id = NEW.pipeline_id AND ps.is_active
        ORDER BY ps.sort_order LIMIT 1;
    END IF;
  ELSE
    SELECT * INTO s FROM public.pipeline_stages ps WHERE ps.id = NEW.stage_id;
  END IF;

  IF s.id IS NULL THEN
    RAISE EXCEPTION 'No pipeline stage available for this account';
  END IF;

  NEW.stage_id := s.id;
  NEW.pipeline_id := s.pipeline_id;
  NEW.stage := s.key;

  IF s.is_lost AND (NEW.lost_reason IS NULL OR btrim(NEW.lost_reason) = '') THEN
    RAISE EXCEPTION 'A reason is required when an account is marked lost';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.stage_id IS DISTINCT FROM OLD.stage_id THEN
    NEW.stage_changed_at := now();
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_reference_accounts_off_pipeline ON public.accounts;
DROP FUNCTION IF EXISTS public.tg_reference_accounts_off_pipeline();

UPDATE public.accounts SET stage = 'reference' WHERE is_reference;
