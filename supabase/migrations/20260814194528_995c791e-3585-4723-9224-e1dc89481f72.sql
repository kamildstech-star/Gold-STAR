-- ---------------------------------------------------------------------------
-- 1. Assignment rules, configurable per severity band
-- ---------------------------------------------------------------------------
CREATE TABLE public.chase_assignment_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  label text NOT NULL,
  description text,
  -- 1 = a single chaser owns the call. Higher = that many may respond.
  max_responders integer NOT NULL DEFAULT 1 CHECK (max_responders BETWEEN 1 AND 20),
  -- Single-family also locks the surrounding zone so two chasers do not both
  -- drive to the same fire reported twice.
  zone_exclusive boolean NOT NULL DEFAULT false,
  -- Accept but never log arrival within this many minutes and the fire reopens.
  arrival_timeout_minutes integer NOT NULL DEFAULT 45 CHECK (arrival_timeout_minutes BETWEEN 5 AND 1440),
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.chase_assignment_rules TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.chase_assignment_rules TO authenticated;
GRANT ALL ON public.chase_assignment_rules TO service_role;

ALTER TABLE public.chase_assignment_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY chase_assignment_rules_select ON public.chase_assignment_rules
  FOR SELECT TO authenticated USING (true);

CREATE POLICY chase_assignment_rules_manage ON public.chase_assignment_rules
  FOR ALL TO authenticated
  USING (public.is_privileged((SELECT auth.uid())))
  WITH CHECK (public.is_privileged((SELECT auth.uid())));

CREATE TRIGGER chase_assignment_rules_updated_at
  BEFORE UPDATE ON public.chase_assignment_rules
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

INSERT INTO public.chase_assignment_rules
  (key, label, description, max_responders, zone_exclusive, arrival_timeout_minutes, sort_order)
VALUES
  ('single_family', 'Single family', 'One chaser owns the call and the zone around it.', 1, true, 45, 0),
  ('multi_family',  'Multi family',  'Several doors, several owners — more than one chaser can work it.', 3, false, 60, 1),
  ('commercial',    'Commercial',    'Commercial loss — a second chaser can support.', 2, false, 60, 2),
  ('large_loss',    'Large / multi-alarm', 'Big job, all hands.', 4, false, 90, 3);

-- Which rule an incident falls under. Null = inferred.
ALTER TABLE public.incidents ADD COLUMN IF NOT EXISTS severity_key text;

-- Track when an acceptance stopped counting, and why, without losing the fact
-- that the chaser did respond.
ALTER TABLE public.incident_dispatches ADD COLUMN IF NOT EXISTS released_at timestamptz;
ALTER TABLE public.incident_dispatches ADD COLUMN IF NOT EXISTS release_reason text;

-- ---------------------------------------------------------------------------
-- 2. Rule resolution
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.incident_rule(_incident_id uuid)
RETURNS public.chase_assignment_rules
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  inc public.incidents%ROWTYPE;
  rule public.chase_assignment_rules%ROWTYPE;
  guess text;
BEGIN
  SELECT * INTO inc FROM public.incidents WHERE id = _incident_id;
  IF NOT FOUND THEN
    SELECT * INTO rule FROM public.chase_assignment_rules WHERE key = 'single_family';
    RETURN rule;
  END IF;

  IF inc.severity_key IS NOT NULL THEN
    SELECT * INTO rule FROM public.chase_assignment_rules
     WHERE key = inc.severity_key AND is_active;
    IF FOUND THEN RETURN rule; END IF;
  END IF;

  -- Inference, in the order a dispatcher would read the alert.
  guess := CASE
    WHEN COALESCE(inc.units_dispatched, 0) >= 8
      OR lower(COALESCE(inc.alarm_level, '')) ~ '(2nd|3rd|4th|5th|all hands|10-75)' THEN 'large_loss'
    WHEN lower(COALESCE(inc.building_type, '')) ~ '(multi|apartment|apt|tenement|walk-?up|high-?rise|mixed)' THEN 'multi_family'
    WHEN lower(COALESCE(inc.building_type, '')) ~ '(commercial|office|retail|warehouse|industrial|store)' THEN 'commercial'
    ELSE 'single_family'
  END;

  SELECT * INTO rule FROM public.chase_assignment_rules WHERE key = guess AND is_active;
  IF NOT FOUND THEN
    SELECT * INTO rule FROM public.chase_assignment_rules
     WHERE is_active ORDER BY sort_order LIMIT 1;
  END IF;
  RETURN rule;
END;
$$;

-- How many chasers are actively holding this fire right now.
CREATE OR REPLACE FUNCTION public.incident_active_responders(_incident_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT count(*)::int
    FROM public.incident_dispatches d
   WHERE d.incident_id = _incident_id
     AND d.response = 'accepted'
     AND d.released_at IS NULL;
$$;

-- ---------------------------------------------------------------------------
-- 3. Claiming, under the rules
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_incident(_incident_id uuid, _eta_minutes integer DEFAULT NULL::integer, _lock_minutes integer DEFAULT NULL::integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  uid uuid := auth.uid();
  inc public.incidents%ROWTYPE;
  rule public.chase_assignment_rules%ROWTYPE;
  holder uuid;
  active_count integer;
  already boolean;
  lock_until timestamptz;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT * INTO inc FROM public.incidents WHERE id = _incident_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Incident not found'; END IF;

  IF NOT public.incident_market_allowed(uid, inc.market_id) THEN
    RAISE EXCEPTION 'Out of market';
  END IF;

  rule := public.incident_rule(_incident_id);

  -- The lock runs to whichever is later: the configured arrival timeout, or an
  -- explicit hold the caller asked for (overnight claims hold for hours).
  lock_until := GREATEST(
    now() + make_interval(mins => rule.arrival_timeout_minutes),
    now() + make_interval(mins => COALESCE(_lock_minutes, 0))
  );

  SELECT EXISTS (
    SELECT 1 FROM public.incident_dispatches
     WHERE incident_id = _incident_id AND user_id = uid
       AND response = 'accepted' AND released_at IS NULL
  ) INTO already;

  active_count := public.incident_active_responders(_incident_id);

  IF NOT already AND active_count >= rule.max_responders THEN
    -- Full. Record the race so the board can drop it off their list.
    INSERT INTO public.incident_dispatches (incident_id, user_id, tier, responded_at, response)
    VALUES (_incident_id, uid, COALESCE(inc.escalation_tier, 0), now(), 'declined_race')
    ON CONFLICT (incident_id, user_id) DO UPDATE
      SET response = 'declined_race', responded_at = now(), released_at = NULL, release_reason = NULL;

    SELECT d.user_id INTO holder
      FROM public.incident_dispatches d
     WHERE d.incident_id = _incident_id AND d.response = 'accepted' AND d.released_at IS NULL
     ORDER BY d.responded_at
     LIMIT 1;

    RETURN jsonb_build_object(
      'claimed', false,
      'rule', rule.key,
      'max_responders', rule.max_responders,
      'holder_id', holder,
      'holder_name', (SELECT full_name FROM public.profiles WHERE user_id = holder),
      'eta_at', inc.eta_at
    );
  END IF;

  INSERT INTO public.incident_dispatches (incident_id, user_id, tier, responded_at, response)
  VALUES (_incident_id, uid, COALESCE(inc.escalation_tier, 0), now(), 'accepted')
  ON CONFLICT (incident_id, user_id) DO UPDATE
    SET response = 'accepted', responded_at = now(), released_at = NULL, release_reason = NULL;

  UPDATE public.incidents
     SET status = 'accepted',
         lifecycle = 'claimed',
         accepted_by = COALESCE(accepted_by, uid),
         accepted_at = COALESCE(accepted_at, now()),
         locked_by = CASE WHEN rule.max_responders = 1 THEN uid ELSE locked_by END,
         locked_at = CASE WHEN rule.max_responders = 1 THEN now() ELSE locked_at END,
         needs_backup = false,
         claim_expires_at = GREATEST(COALESCE(claim_expires_at, lock_until), lock_until),
         eta_at = CASE WHEN _eta_minutes IS NULL THEN eta_at ELSE now() + make_interval(mins => _eta_minutes) END
   WHERE id = _incident_id;

  -- Zone lock: duplicates of the same fire in the same zone go with it, so a
  -- second chaser is not sent to the same address from a second report.
  IF rule.zone_exclusive AND inc.zone_id IS NOT NULL THEN
    UPDATE public.incidents s
       SET locked_by = uid,
           locked_at = now(),
           claim_expires_at = lock_until
     WHERE s.id <> _incident_id
       AND s.zone_id = inc.zone_id
       AND s.lifecycle = 'live'
       AND s.accepted_by IS NULL
       AND (
         (inc.exposure_group_id IS NOT NULL AND s.exposure_group_id = inc.exposure_group_id)
         OR (inc.dedupe_key IS NOT NULL AND s.dedupe_key = inc.dedupe_key)
       );
  END IF;

  INSERT INTO public.incident_events (incident_id, event_type, actor_id, payload)
  VALUES (_incident_id, 'accepted', uid,
          jsonb_build_object('rule', rule.key,
                             'max_responders', rule.max_responders,
                             'responders', public.incident_active_responders(_incident_id),
                             'arrival_due_at', lock_until));

  RETURN jsonb_build_object(
    'claimed', true,
    'rule', rule.key,
    'rule_label', rule.label,
    'shared', rule.max_responders > 1,
    'max_responders', rule.max_responders,
    'responders', public.incident_active_responders(_incident_id),
    'arrival_due_at', lock_until
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Releasing — chaser cancels, or never arrived
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.release_incident_claim(_incident_id uuid, _reason text DEFAULT 'cancelled')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  uid uuid := auth.uid();
  inc public.incidents%ROWTYPE;
  remaining integer;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT * INTO inc FROM public.incidents WHERE id = _incident_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Incident not found'; END IF;
  IF NOT public.incident_market_allowed(uid, inc.market_id) THEN
    RAISE EXCEPTION 'Out of market';
  END IF;

  UPDATE public.incident_dispatches
     SET released_at = now(),
         release_reason = COALESCE(nullif(btrim(_reason), ''), 'cancelled')
   WHERE incident_id = _incident_id AND user_id = uid
     AND response = 'accepted' AND released_at IS NULL;

  remaining := public.incident_active_responders(_incident_id);

  IF remaining = 0 THEN
    UPDATE public.incidents
       SET lifecycle = 'live',
           status = 'dispatched',
           accepted_by = NULL,
           accepted_at = NULL,
           arrived_at = NULL,
           eta_at = NULL,
           locked_by = NULL,
           locked_at = NULL,
           claim_expires_at = NULL
     WHERE id = _incident_id;

    -- Release any zone siblings this claim was holding.
    UPDATE public.incidents s
       SET locked_by = NULL, locked_at = NULL, claim_expires_at = NULL
     WHERE s.locked_by = uid AND s.accepted_by IS NULL AND s.lifecycle = 'live'
       AND s.zone_id IS NOT DISTINCT FROM inc.zone_id;
  ELSE
    UPDATE public.incidents
       SET accepted_by = (
             SELECT d.user_id FROM public.incident_dispatches d
              WHERE d.incident_id = _incident_id AND d.response = 'accepted' AND d.released_at IS NULL
              ORDER BY d.responded_at LIMIT 1)
     WHERE id = _incident_id AND accepted_by = uid;
  END IF;

  INSERT INTO public.incident_events (incident_id, event_type, actor_id, payload)
  VALUES (_incident_id, 'escalated', uid,
          jsonb_build_object('reason', COALESCE(nullif(btrim(_reason), ''), 'cancelled'),
                             'released', true,
                             'remaining_responders', remaining,
                             'needs_dispatcher', remaining = 0));

  RETURN jsonb_build_object('reopened', remaining = 0, 'remaining', remaining);
END;
$$;

-- Housekeeping: arrival timeouts reopen the fire; unanswered alerts become
-- no_action after the decay window. No action is not a decline.
CREATE OR REPLACE FUNCTION public.expire_stale_chase_claims()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  released integer := 0;
  lapsed integer := 0;
  decay integer := GREATEST(1, public.chase_setting_num('lead_decay_hours', 24)::integer);
  r record;
BEGIN
  FOR r IN
    SELECT id FROM public.incidents
     WHERE lifecycle = 'claimed'
       AND arrived_at IS NULL
       AND claim_expires_at IS NOT NULL
       AND claim_expires_at < now()
     FOR UPDATE
  LOOP
    UPDATE public.incident_dispatches
       SET released_at = now(), release_reason = 'no_arrival_timeout'
     WHERE incident_id = r.id AND response = 'accepted' AND released_at IS NULL;

    UPDATE public.incidents
       SET lifecycle = 'live',
           status = 'dispatched',
           accepted_by = NULL,
           accepted_at = NULL,
           eta_at = NULL,
           locked_by = NULL,
           locked_at = NULL,
           claim_expires_at = NULL,
           escalation_tier = 0,
           escalated_at = NULL
     WHERE id = r.id;

    INSERT INTO public.incident_events (incident_id, event_type, actor_id, payload)
    VALUES (r.id, 'escalated', NULL,
            jsonb_build_object('reason', 'no_arrival_timeout', 'released', true, 'needs_dispatcher', true));

    released := released + 1;
  END LOOP;

  WITH lapse AS (
    UPDATE public.incident_dispatches d
       SET response = 'no_action', responded_at = now()
     WHERE d.response IN ('pending', 'no_response')
       AND d.notified_at < now() - make_interval(hours => decay)
    RETURNING 1
  )
  SELECT count(*)::int INTO lapsed FROM lapse;

  RETURN jsonb_build_object('released', released, 'lapsed', lapsed);
END;
$$;

REVOKE ALL ON FUNCTION public.expire_stale_chase_claims() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.expire_stale_chase_claims() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.incident_rule(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.incident_active_responders(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.release_incident_claim(uuid, text) TO authenticated, service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('chase-claim-expiry') WHERE EXISTS (
      SELECT 1 FROM cron.job WHERE jobname = 'chase-claim-expiry');
    PERFORM cron.schedule('chase-claim-expiry', '*/5 * * * *',
      $cron$SELECT public.expire_stale_chase_claims();$cron$);
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Lost-job buttons: the client's exact top row, one level deep
-- ---------------------------------------------------------------------------
INSERT INTO public.incident_outcome_reasons (key, label, kills_lead, allows_another_try, wins_lead, sort_order, is_active)
SELECT 'going_direct', 'Going direct', true, false, false, 6, true
 WHERE NOT EXISTS (
   SELECT 1 FROM public.incident_outcome_reasons
    WHERE parent_id IS NULL AND key = 'going_direct');

UPDATE public.incident_outcome_reasons
   SET label = 'Going direct', kills_lead = true, allows_another_try = false,
       is_active = true, sort_order = 6, option_list_key = NULL
 WHERE parent_id IS NULL AND key = 'going_direct';

-- The separate TPA branch is retired: "going direct" covers it and the spec
-- wants one level of buttons.
UPDATE public.incident_outcome_reasons SET is_active = false
 WHERE key = 'insurance_sent'
    OR parent_id = (SELECT id FROM public.incident_outcome_reasons WHERE key = 'insurance_sent');

-- Only "another company signed" opens a second row.
UPDATE public.incident_outcome_reasons SET is_active = false
 WHERE parent_id IN (SELECT id FROM public.incident_outcome_reasons WHERE key IN ('homeowner_declined', 'not_owner', 'nobody_home'));

-- Competitors as named buttons, editable in Admin.
UPDATE public.incident_outcome_reasons SET option_list_key = NULL WHERE key = 'another_company';
UPDATE public.incident_outcome_reasons SET is_active = true
 WHERE parent_id = (SELECT id FROM public.incident_outcome_reasons WHERE key = 'another_company')
   AND key IN ('servpro','servicemaster','belfor','paul_davis','puroclean','rainbow','911','first_onsite');
UPDATE public.incident_outcome_reasons SET is_active = false
 WHERE parent_id = (SELECT id FROM public.incident_outcome_reasons WHERE key = 'another_company')
   AND key NOT IN ('servpro','servicemaster','belfor','paul_davis','puroclean','rainbow','911','first_onsite');

-- Top-row order the chasers were shown.
UPDATE public.incident_outcome_reasons SET sort_order = 0 WHERE key = 'signed_by_us';
UPDATE public.incident_outcome_reasons SET sort_order = 1 WHERE key = 'another_company';
UPDATE public.incident_outcome_reasons SET sort_order = 2 WHERE key = 'homeowner_declined';
UPDATE public.incident_outcome_reasons SET sort_order = 3 WHERE key = 'nobody_home';
UPDATE public.incident_outcome_reasons SET sort_order = 4 WHERE key = 'not_owner';
UPDATE public.incident_outcome_reasons SET sort_order = 5 WHERE key = 'too_minor';
UPDATE public.incident_outcome_reasons SET sort_order = 7 WHERE key = 'wrong_address';

-- Handover: these four are dead for everyone.
UPDATE public.incident_outcome_reasons
   SET kills_lead = true, allows_another_try = false
 WHERE key IN ('another_company', 'going_direct', 'too_minor', 'wrong_address');

-- These keep the lead live for the next chaser, with attempt history on it.
UPDATE public.incident_outcome_reasons
   SET kills_lead = false
 WHERE key IN ('nobody_home', 'not_owner');