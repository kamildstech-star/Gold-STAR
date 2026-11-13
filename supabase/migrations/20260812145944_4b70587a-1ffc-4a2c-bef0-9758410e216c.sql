CREATE OR REPLACE FUNCTION public.claim_incident(_incident_id uuid, _eta_minutes integer DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  uid uuid := auth.uid();
  inc public.incidents%ROWTYPE;
  holder uuid;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT * INTO inc FROM public.incidents WHERE id = _incident_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Incident not found'; END IF;

  IF NOT public.incident_market_allowed(uid, inc.market_id) THEN
    RAISE EXCEPTION 'Out of market';
  END IF;

  IF inc.exclusivity = 'shared' THEN
    INSERT INTO public.incident_dispatches (incident_id, user_id, tier, responded_at, response)
    VALUES (_incident_id, uid, inc.escalation_tier, now(), 'accepted')
    ON CONFLICT (incident_id, user_id)
      DO UPDATE SET response = 'accepted', responded_at = now();
    UPDATE public.incidents
       SET status = 'accepted',
           accepted_by = COALESCE(accepted_by, uid),
           accepted_at = COALESCE(accepted_at, now()),
           eta_at = CASE WHEN _eta_minutes IS NULL THEN eta_at ELSE now() + make_interval(mins => _eta_minutes) END
     WHERE id = _incident_id;
    RETURN jsonb_build_object('claimed', true, 'shared', true);
  END IF;

  UPDATE public.incidents
     SET locked_by = uid,
         locked_at = now(),
         accepted_by = uid,
         accepted_at = now(),
         status = 'accepted',
         needs_backup = false,
         eta_at = CASE WHEN _eta_minutes IS NULL THEN NULL ELSE now() + make_interval(mins => _eta_minutes) END
   WHERE id = _incident_id
     AND (locked_by IS NULL OR locked_by = uid OR needs_backup)
  RETURNING locked_by INTO holder;

  IF holder IS NOT NULL THEN
    INSERT INTO public.incident_dispatches (incident_id, user_id, tier, responded_at, response)
    VALUES (_incident_id, uid, inc.escalation_tier, now(), 'accepted')
    ON CONFLICT (incident_id, user_id) DO UPDATE SET response = 'accepted', responded_at = now();
    RETURN jsonb_build_object('claimed', true, 'shared', false);
  END IF;

  SELECT locked_by INTO holder FROM public.incidents WHERE id = _incident_id;
  INSERT INTO public.incident_dispatches (incident_id, user_id, tier, responded_at, response)
  VALUES (_incident_id, uid, inc.escalation_tier, now(), 'declined_race')
  ON CONFLICT (incident_id, user_id) DO UPDATE SET response = 'declined_race', responded_at = now();

  RETURN jsonb_build_object(
    'claimed', false,
    'holder_id', holder,
    'holder_name', (SELECT full_name FROM public.profiles WHERE user_id = holder),
    'eta_at', (SELECT eta_at FROM public.incidents WHERE id = _incident_id)
  );
END;
$$;