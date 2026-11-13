ALTER TABLE public.incident_outcome_reasons
  ADD COLUMN IF NOT EXISTS outcome_code public.incident_outcome;

UPDATE public.incident_outcome_reasons SET outcome_code = CASE key
  WHEN 'signed_by_us' THEN 'contract_signed'
  WHEN 'another_company' THEN 'competitor_present'
  WHEN 'homeowner_declined' THEN 'homeowner_declined'
  WHEN 'nobody_home' THEN 'no_contact'
  WHEN 'not_owner' THEN 'not_owner'
  WHEN 'too_minor' THEN 'damage_too_minor'
  WHEN 'going_direct' THEN 'going_direct'
  WHEN 'wrong_address' THEN 'wrong_address'
  WHEN 'insurance_sent' THEN 'competitor_present'
END::public.incident_outcome
WHERE parent_id IS NULL;

-- Competitor picks come from the managed option list, not child reason rows.
UPDATE public.incident_outcome_reasons SET option_list_key = 'competitor'
 WHERE key = 'another_company' AND parent_id IS NULL;
UPDATE public.incident_outcome_reasons SET is_active = false
 WHERE parent_id = (SELECT id FROM public.incident_outcome_reasons WHERE key = 'another_company' AND parent_id IS NULL);

-- Old rows: the retired catch-all becomes "damage too minor".
UPDATE public.incidents SET outcome = 'damage_too_minor'
 WHERE outcome = 'not_real_loss';

CREATE OR REPLACE FUNCTION public.log_incident_outcome(_incident_id uuid, _reason_id uuid, _sub_reason_id uuid DEFAULT NULL::uuid, _note text DEFAULT NULL::text, _worth_another_try boolean DEFAULT false, _revisit_after timestamp with time zone DEFAULT NULL::timestamp with time zone, _sub_label text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  uid uuid := auth.uid();
  inc public.incidents%ROWTYPE;
  reason public.incident_outcome_reasons%ROWTYPE;
  sub public.incident_outcome_reasons%ROWTYPE;
  sub_text text;
  keep_live boolean;
  next_life public.incident_lifecycle;
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

  keep_live := (NOT reason.kills_lead) OR (reason.allows_another_try AND COALESCE(_worth_another_try, false));

  IF reason.wins_lead THEN
    next_life := 'won';
    keep_live := false;
  ELSIF keep_live THEN
    next_life := 'live';
  ELSE
    next_life := 'dead';
  END IF;

  INSERT INTO public.incident_attempts
    (incident_id, chaser_id, reason_id, sub_reason_id, reason_label, sub_reason_label, note, kept_live)
  VALUES
    (_incident_id, uid, reason.id, sub.id, reason.label, sub_text, nullif(btrim(coalesce(_note,'')), ''), keep_live);

  UPDATE public.incidents
     SET lifecycle = next_life,
         -- The reason row carries the reportable outcome; a lead that stays
         -- live keeps whatever it had, because nothing has concluded yet.
         outcome = CASE WHEN keep_live THEN outcome
                        ELSE COALESCE(reason.outcome_code, outcome) END,
         bad_data = bad_data OR reason.flags_bad_data,
         worth_another_try = COALESCE(_worth_another_try, false),
         revisit_after = CASE WHEN keep_live THEN _revisit_after ELSE NULL END,
         outcome_notes = COALESCE(nullif(btrim(coalesce(_note,'')), ''), outcome_notes),
         outcome_at = now(),
         status = CASE WHEN next_life = 'live' THEN 'dispatched'::incident_status
                       WHEN next_life = 'won' THEN 'closed'::incident_status
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
    DELETE FROM public.incident_dispatches
     WHERE incident_id = _incident_id AND user_id <> uid;
  END IF;

  RETURN jsonb_build_object('lifecycle', next_life, 'kept_live', keep_live);
END;
$function$;