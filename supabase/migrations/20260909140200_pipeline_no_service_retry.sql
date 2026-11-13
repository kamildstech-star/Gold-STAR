-- No Service Needed (Mark, 9 Sep): "Can only be moved here manually. Once
-- moved here, a pop-up comes up: why don't they need our service (text box),
-- and should we try again in 6 months / 12 months? If yes, at that 6/12 month
-- mark it moves back into Active Outreach with a task to reach out."
--
-- What already existed (20260806170640): accounts.no_service_reason_code,
-- no_service_reason_detail (the text box) and reactivate_on (the retry date),
-- and the stage-move dialog writes them. What did not exist: anything that
-- acted on reactivate_on. The automation engine's date_reached trigger could
-- watch it, but no rule did and it cannot move a stage with a task in one
-- step. So:
--
--   * pipeline_mark_no_service(...) — the one call the popup makes: stage,
--     reason text, retry months -> reactivate_on, atomically, under RLS.
--   * pipeline_no_service_return_sweep() — on reactivate_on, back to Active
--     Outreach (a fresh stage entry, so the ghost clock restarts) with a
--     "Reach out again" task for the rep, idempotent on cadence_key. Runs
--     from the existing ten-minute stage_advance_sweep().
--   * Leaving No Service Needed by hand clears the retry (the stage-reset
--     trigger from 20260909120100), so a record someone already revived is
--     never yanked back to Outreach later.
--
-- The view pipeline_rule_state exposes reactivate_on as retry_at and
-- no_service_reason_detail as no_service_reason.

CREATE OR REPLACE FUNCTION public.pipeline_mark_no_service(
  _account_id uuid,
  _reason text DEFAULT NULL,
  _retry_months integer DEFAULT NULL,
  _reason_code text DEFAULT NULL
)
RETURNS date
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  target uuid;
  retry date;
  note text := nullif(btrim(coalesce(_reason, '')), '');
BEGIN
  IF _retry_months IS NOT NULL AND (_retry_months < 1 OR _retry_months > 24) THEN
    RAISE EXCEPTION 'Retry must be between 1 and 24 months.' USING ERRCODE = '22023';
  END IF;

  SELECT n.id INTO target
    FROM public.accounts a
    JOIN public.pipeline_stages s ON s.id = a.stage_id
    JOIN public.pipeline_stages n ON n.pipeline_id = s.pipeline_id AND n.key = 'no_service_needed' AND n.is_active
   WHERE a.id = _account_id;
  IF target IS NULL THEN
    RAISE EXCEPTION 'This pipeline has no No Service Needed stage.' USING ERRCODE = '22023';
  END IF;

  retry := CASE WHEN _retry_months IS NULL THEN NULL
                ELSE (current_date + make_interval(months => _retry_months))::date END;

  UPDATE public.accounts
     SET stage_id = target,
         lost_reason = 'No service needed' || coalesce(' — ' || note, ''),
         no_service_reason_detail = coalesce(note, no_service_reason_detail),
         no_service_reason_code = coalesce(nullif(btrim(coalesce(_reason_code, '')), ''), no_service_reason_code, 'other'),
         no_service_retry_months = _retry_months,
         reactivate_on = retry
   WHERE id = _account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The account could not be moved.' USING ERRCODE = '42501';
  END IF;
  RETURN retry;
END;
$$;
REVOKE ALL ON FUNCTION public.pipeline_mark_no_service(uuid, text, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pipeline_mark_no_service(uuid, text, integer, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.pipeline_no_service_return_sweep()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  r record;
  outreach uuid;
  assignee uuid;
  moved int := 0;
  ck text;
BEGIN
  FOR r IN
    SELECT a.id, a.name, a.location_id, a.assigned_rep, a.created_by, a.reactivate_on,
           a.no_service_retry_months, a.is_demo, a.stage_id, s.pipeline_id
      FROM public.accounts a
      JOIN public.pipeline_stages s ON s.id = a.stage_id
      JOIN public.pipelines p ON p.id = s.pipeline_id
     WHERE s.key = 'no_service_needed'
       AND a.archived_at IS NULL
       AND a.reactivate_on IS NOT NULL
       AND a.reactivate_on <= current_date
       AND p.auto_advance_enabled AND p.is_active
     LIMIT 500
  LOOP
    SELECT id INTO outreach FROM public.pipeline_stages
     WHERE pipeline_id = r.pipeline_id AND key = 'active_outreach' AND is_active LIMIT 1;
    CONTINUE WHEN outreach IS NULL;

    -- The reason rides through lost_reason into stage history (the same
    -- pattern as move_account_back_to_pipeline), then is cleared: the
    -- account is being worked again, not lost.
    UPDATE public.accounts
       SET stage_id = outreach,
           lost_reason = 'Back to Active Outreach — retry date ' || to_char(r.reactivate_on, 'YYYY-MM-DD') || ' reached',
           reactivate_on = NULL,
           no_service_retry_months = NULL
     WHERE id = r.id AND stage_id = r.stage_id;
    IF NOT FOUND THEN CONTINUE; END IF;
    UPDATE public.accounts SET lost_reason = NULL WHERE id = r.id;
    moved := moved + 1;

    assignee := coalesce(r.assigned_rep, r.created_by);
    ck := 'no_service_retry:' || r.id::text || ':' || to_char(r.reactivate_on, 'YYYY-MM-DD');
    IF assignee IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.tasks WHERE cadence_key = ck) THEN
      INSERT INTO public.tasks
        (title, description, assignee, due_date, priority, status, entity_type, entity_id,
         account_id, location_id, source, cadence_key, automation_reason, created_by, is_demo)
      VALUES
        ('Reach out again — ' || r.name,
         'Marked No Service Needed' || coalesce(' with a retry in ' || r.no_service_retry_months || ' months', '')
           || '. The date has come and the record is back in Active Outreach.',
         assignee, current_date, 'high', 'open', 'account', r.id,
         r.id, r.location_id, 'pipeline_rule', ck,
         'Created automatically: the No Service Needed retry date was reached.',
         assignee, r.is_demo);

      INSERT INTO public.notifications (user_id, type, title, body, entity_type, entity_id, href, priority, is_demo)
      VALUES (assignee, 'automation_task', 'Reach out again — ' || r.name,
              'The retry date on this No Service Needed record has come. It is back in Active Outreach.',
              'account', r.id, '/accounts/' || r.id::text, 'normal', r.is_demo);
    END IF;
  END LOOP;
  RETURN moved;
END;
$$;
REVOKE ALL ON FUNCTION public.pipeline_no_service_return_sweep() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pipeline_no_service_return_sweep() TO service_role;

-- Fold it into the ten-minute sweep beside the ghost rules.
CREATE OR REPLACE FUNCTION public.stage_advance_sweep()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  r record;
  moved int := 0;
BEGIN
  FOR r IN
    SELECT a.id
      FROM public.accounts a
      JOIN public.pipeline_stages s ON s.id = a.stage_id
      JOIN public.pipelines p ON p.id = s.pipeline_id
     WHERE a.archived_at IS NULL
       AND s.auto_advance AND s.is_active
       AND p.auto_advance_enabled AND p.is_active
     LIMIT 5000
  LOOP
    IF public.stage_advance_evaluate(r.id) IS NOT NULL THEN moved := moved + 1; END IF;
  END LOOP;
  moved := moved + public.pipeline_ghost_sweep();
  moved := moved + public.pipeline_no_service_return_sweep();
  RETURN moved;
END;
$$;
