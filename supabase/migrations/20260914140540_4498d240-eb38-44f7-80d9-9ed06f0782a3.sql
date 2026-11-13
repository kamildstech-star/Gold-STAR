CREATE OR REPLACE FUNCTION public.pipeline_activate_client(
  _account_id uuid,
  _green_light_date date DEFAULT current_date
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  won uuid;
  farming uuid;
  healthy uuid;
  watching uuid;
  glow date := coalesce(_green_light_date, current_date);
BEGIN
  IF glow > current_date THEN
    RAISE EXCEPTION 'The green-light date cannot be in the future.' USING ERRCODE = '22023';
  END IF;

  SELECT w.id INTO won
    FROM public.accounts a
    JOIN public.pipeline_stages s ON s.id = a.stage_id
    JOIN public.pipeline_stages w ON w.pipeline_id = s.pipeline_id AND w.is_won AND w.is_active
   WHERE a.id = _account_id
   ORDER BY (w.key = 'active_client') DESC, w.sort_order
   LIMIT 1;
  IF won IS NULL THEN
    RAISE EXCEPTION 'This pipeline has no Active Client stage.' USING ERRCODE = '22023';
  END IF;

  SELECT h.pipeline_id, h.id INTO farming, healthy
    FROM public.pipeline_stages h
    JOIN public.pipelines p ON p.id = h.pipeline_id
   WHERE h.key = 'healthy' AND h.is_active AND p.is_active
   ORDER BY (p.id = '33333333-3333-4333-8333-333333333333'::uuid) DESC
   LIMIT 1;

  -- A new client starts at Watch, not Healthy: on day one the paperwork is by
  -- definition not in place. `needs_attention` is the Farming stage that
  -- asserts Watch (HEALTH_TO_FARMING_STAGE_KEY.monitoring).
  SELECT h.id INTO watching
    FROM public.pipeline_stages h
    JOIN public.pipelines p ON p.id = h.pipeline_id
   WHERE h.key = 'needs_attention' AND h.is_active AND p.is_active
   ORDER BY (p.id = '33333333-3333-4333-8333-333333333333'::uuid) DESC
   LIMIT 1;

  UPDATE public.accounts
     SET stage_id = won,
         status = 'active',
         green_light_date = glow,
         health_pipeline_id = coalesce(farming, health_pipeline_id),
         health_stage_id = coalesce(watching, healthy, health_stage_id),
         health_changed_at = glow::timestamptz,
         annual_meeting_due_on = coalesce(annual_meeting_due_on, (glow + interval '1 year')::date),
         lost_reason = 'Green light ' || to_char(glow, 'YYYY-MM-DD')
   WHERE id = _account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The account could not be activated.' USING ERRCODE = '42501';
  END IF;

  -- The stage-history trigger has copied the reason from the first update.
  UPDATE public.accounts SET lost_reason = NULL WHERE id = _account_id;
END;
$$;