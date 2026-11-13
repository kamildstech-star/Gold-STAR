ALTER TABLE public.incidents
  ADD COLUMN IF NOT EXISTS needs_review boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS review_reason text;

-- Survival is a property of the reason, never a chaser toggle.
UPDATE public.incident_outcome_reasons SET allows_another_try = false WHERE allows_another_try;

CREATE OR REPLACE FUNCTION public.log_incident_outcome(
  _incident_id uuid,
  _reason_id uuid,
  _sub_reason_id uuid DEFAULT NULL,
  _sub_label text DEFAULT NULL,
  _note text DEFAULT NULL,
  _worth_another_try boolean DEFAULT false,
  _revisit_after timestamptz DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  inc public.incidents%ROWTYPE;
  reason public.incident_outcome_reasons%ROWTYPE;
  sub public.incident_outcome_reasons%ROWTYPE;
  sub_text text;
  keep_live boolean;
  next_life public.incident_lifecycle;
  attempts_n int;
  review_limit int;
  flag_review boolean := false;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT * INTO inc FROM public.incidents WHERE id = _incident_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Incident not found'; END IF;
  IF NOT public.incident_market_allowed(uid, inc.market_id) THEN
    RAISE EXCEPTION 'Out of market';
  END IF;

  SELECT * INTO reason FROM public.incident_outcome_reasons WHERE id = _reason_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown outcome reason'; END IF;
  IF _sub_reason_id IS NOT NULL THEN
    SELECT * INTO sub FROM public.incident_outcome_reasons WHERE id = _sub_reason_id;
  END IF;
  sub_text := COALESCE(sub.label, nullif(btrim(coalesce(_sub_label, '')), ''));

  -- The reason row alone decides survival.
  keep_live := NOT reason.kills_lead AND NOT reason.wins_lead;

  IF reason.wins_lead THEN next_life := 'won';
  ELSIF keep_live THEN next_life := 'live';
  ELSE next_life := 'dead';
  END IF;

  INSERT INTO public.incident_attempts
    (incident_id, chaser_id, reason_id, sub_reason_id, reason_label, sub_reason_label, note, kept_live)
  VALUES
    (_incident_id, uid, reason.id, sub.id, reason.label, sub_text, nullif(btrim(coalesce(_note,'')), ''), keep_live);

  SELECT count(*) INTO attempts_n FROM public.incident_attempts WHERE incident_id = _incident_id;
  review_limit := GREATEST(1, COALESCE(public.chase_setting_num('max_attempts_before_review', 3)::int, 3));
  flag_review := keep_live AND attempts_n >= review_limit;

  UPDATE public.incidents
     SET lifecycle = next_life,
         outcome = CASE WHEN keep_live THEN outcome
                        ELSE COALESCE(reason.outcome_code, outcome) END,
         bad_data = bad_data OR reason.flags_bad_data,
         worth_another_try = keep_live,
         revisit_after = CASE WHEN keep_live THEN _revisit_after ELSE NULL END,
         needs_review = CASE WHEN keep_live THEN (needs_review OR flag_review) ELSE false END,
         review_reason = CASE WHEN keep_live AND flag_review
                              THEN attempts_n || ' attempts, still no contact'
                              WHEN keep_live THEN review_reason END,
         outcome_notes = COALESCE(nullif(btrim(coalesce(_note,'')), ''), outcome_notes),
         outcome_at = now(),
         status = CASE WHEN next_life = 'live' THEN 'dispatched'::incident_status
                       ELSE 'closed'::incident_status END,
         locked_by = CASE WHEN next_life = 'live' THEN NULL ELSE locked_by END,
         locked_at = CASE WHEN next_life = 'live' THEN NULL ELSE locked_at END,
         accepted_by = CASE WHEN next_life = 'live' THEN NULL ELSE accepted_by END,
         accepted_at = CASE WHEN next_life = 'live' THEN NULL ELSE accepted_at END,
         arrived_at = CASE WHEN next_life = 'live' THEN NULL ELSE arrived_at END,
         eta_at = CASE WHEN next_life = 'live' THEN NULL ELSE eta_at END,
         needs_backup = false,
         escalation_tier = CASE WHEN next_life = 'live' THEN 0 ELSE escalation_tier END,
         escalated_at = CASE WHEN next_life = 'live' THEN NULL ELSE escalated_at END
   WHERE id = _incident_id;

  IF next_life = 'live' THEN
    -- Released for everyone else...
    DELETE FROM public.incident_dispatches
     WHERE incident_id = _incident_id AND user_id <> uid;
    -- ...but off the board of the chaser who just attended it. Past Leads keeps it.
    INSERT INTO public.incident_dispatches (incident_id, user_id, tier, response, responded_at, release_reason)
    VALUES (_incident_id, uid, 0, 'no_action', now(), 'Attempted — handed to next chaser')
    ON CONFLICT (incident_id, user_id)
    DO UPDATE SET response = 'no_action', responded_at = now(),
                  release_reason = 'Attempted — handed to next chaser';
  END IF;

  RETURN jsonb_build_object(
    'lifecycle', next_life,
    'kept_live', keep_live,
    'attempts', attempts_n,
    'needs_review', flag_review
  );
END;
$$;