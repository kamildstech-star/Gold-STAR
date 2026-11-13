-- Preserve the stage-history reason without leaving the account falsely marked
-- as lost if the cleanup write fails. SECURITY INVOKER keeps the account RLS
-- policy authoritative; both updates commit or roll back together.
CREATE OR REPLACE FUNCTION public.move_account_back_to_pipeline(
  _account_id uuid,
  _stage_id uuid,
  _reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  affected integer;
BEGIN
  IF btrim(coalesce(_reason, '')) = '' THEN
    RAISE EXCEPTION 'A reversion reason is required.' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.pipeline_stages stage
    JOIN public.pipelines pipeline ON pipeline.id = stage.pipeline_id
    WHERE stage.id = _stage_id
      AND stage.is_active
      AND NOT stage.is_won
      AND pipeline.entity_type = 'account'
      AND pipeline.is_active
  ) THEN
    RAISE EXCEPTION 'The selected prospect stage is unavailable.' USING ERRCODE = '22023';
  END IF;

  UPDATE public.accounts
  SET stage_id = _stage_id,
      lost_reason = btrim(_reason),
      health_pipeline_id = NULL,
      health_stage_id = NULL,
      health_changed_at = NULL,
      status = CASE
        WHEN status::text IN ('active', 'onboarding') THEN 'prospect'
        ELSE status
      END
  WHERE id = _account_id;

  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN
    RAISE EXCEPTION 'The account could not be moved.' USING ERRCODE = '42501';
  END IF;

  -- The stage-history trigger has copied the reason from the first update.
  UPDATE public.accounts SET lost_reason = NULL WHERE id = _account_id;
END;
$$;

REVOKE ALL ON FUNCTION public.move_account_back_to_pipeline(uuid, uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.move_account_back_to_pipeline(uuid, uuid, text)
  TO authenticated, service_role;
