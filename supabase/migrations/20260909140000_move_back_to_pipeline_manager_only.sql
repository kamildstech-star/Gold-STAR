-- Moving a client back to the pipeline is a manager decision.
--
-- The written permissions spec: "Reps cannot assign owners, move a client back
-- to the pipeline, or clear a Critical directly" — "Managers can do everything
-- reps can, plus assign owners, move clients back to the pipeline, reassign
-- accounts, and make the day thirty decision."
--
-- Until now the function was SECURITY INVOKER with no check of its own, so the
-- only guard was the `accounts_update` policy — `can_manage_location(uid,
-- location_id) OR assigned_rep = uid` — which let the assigned rep revert their
-- own client. Proven against production in a rolled-back transaction on
-- 2026-09-09: as role `authenticated` with a plain `sales_rep`'s claims the RPC
-- succeeded and wrote a stage-history row.
--
-- The manager notion is the app's existing one, not a new role list:
-- `can_manage_location()` — privileged, or an office/location_manager/
-- sales_manager member of that office, or a regional over it. `is_privileged()`
-- is named separately so owner/admin/dev still work on an account with no
-- office (`can_manage_location` is false for a NULL location).
--
-- Everything else is unchanged: one transaction, a required reason carried into
-- `account_stage_history` by the trigger, and nothing deleted.
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
  account_location uuid;
BEGIN
  IF btrim(coalesce(_reason, '')) = '' THEN
    RAISE EXCEPTION 'A reversion reason is required.' USING ERRCODE = '22023';
  END IF;

  -- Read under the caller's own RLS: an account they cannot even see is
  -- refused with the same message as one they may not move.
  SELECT a.location_id INTO account_location
  FROM public.accounts a
  WHERE a.id = _account_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'The account could not be moved.' USING ERRCODE = '42501';
  END IF;

  IF NOT (
    public.is_privileged((SELECT auth.uid()))
    OR public.can_manage_location((SELECT auth.uid()), account_location)
  ) THEN
    RAISE EXCEPTION 'Managers move a client back to the pipeline.'
      USING ERRCODE = '42501';
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
