-- Outcome reason parents may draw their sub-options from a managed option list.
ALTER TABLE public.incident_outcome_reasons
  ADD COLUMN IF NOT EXISTS option_list_key text;

-- Chase settings live in app_settings under the single key 'chase'.
CREATE OR REPLACE FUNCTION public.chase_settings_defaults()
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path TO 'public' AS $$
  SELECT jsonb_build_object(
    'escalation_interval_seconds', 90,
    'live_lock_grace_minutes', 15,
    'overnight_lock_hours', 4,
    'lead_decay_hours', 24,
    'dedupe_window_minutes', 60,
    'default_exclusivity', 'exclusive',
    'overnight_severity_floor', 'other',
    'search_window_days', 7,
    'search_result_limit', 20,
    'search_min_chars', 3,
    'past_lead_retention_days', 90,
    'exposure_multi_family_units', 6,
    'exposure_row_house_span', 2,
    'exposure_semi_detached_span', 1,
    'exposure_detached_nearby', 4
  )
$$;

CREATE OR REPLACE FUNCTION public.chase_settings()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT public.chase_settings_defaults()
         || COALESCE((SELECT value FROM public.app_settings WHERE key = 'chase'), '{}'::jsonb)
$$;

CREATE OR REPLACE FUNCTION public.chase_setting_num(_key text, _default numeric)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT COALESCE(
    NULLIF(public.chase_settings() ->> _key, '')::numeric,
    _default
  )
$$;

GRANT EXECUTE ON FUNCTION public.chase_settings_defaults() TO authenticated;
GRANT EXECUTE ON FUNCTION public.chase_settings() TO authenticated;
GRANT EXECUTE ON FUNCTION public.chase_setting_num(text, numeric) TO authenticated;

-- Duplicate window
CREATE OR REPLACE FUNCTION public.incidents_classify()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  r record;
  dup uuid;
  win integer := public.chase_setting_num('dedupe_window_minutes', 60)::integer;
BEGIN
  IF NEW.zone_id IS NULL AND NEW.postal_code IS NOT NULL THEN
    SELECT * INTO r FROM public.resolve_zone(NEW.postal_code);
    IF FOUND THEN
      NEW.zone_id := r.zone_id;
      NEW.market_id := COALESCE(NEW.market_id, r.market_id);
    END IF;
  END IF;

  IF NEW.zone_id IS NULL THEN
    NEW.admin_routed := true;
    NEW.admin_route_reason := COALESCE(
      NEW.admin_route_reason,
      CASE WHEN NEW.postal_code IS NULL THEN 'No postal code on incident'
           ELSE 'ZIP ' || NEW.postal_code || ' is not mapped to a zone' END
    );
  END IF;

  NEW.dedupe_key := lower(regexp_replace(coalesce(NEW.address, NEW.external_ref, NEW.id::text), '\s+', ' ', 'g'))
                    || '|' || NEW.incident_type::text;

  IF TG_OP = 'INSERT' THEN
    SELECT i.id INTO dup
    FROM public.incidents i
    WHERE i.dedupe_key = NEW.dedupe_key
      AND i.duplicate_of IS NULL
      AND i.reported_at > NEW.reported_at - make_interval(mins => win)
      AND i.reported_at < NEW.reported_at + make_interval(mins => win)
    ORDER BY i.reported_at ASC
    LIMIT 1;
    IF dup IS NOT NULL THEN
      NEW.duplicate_of := dup;
      NEW.status := 'discarded';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

-- Live claim lock grace past ETA
CREATE OR REPLACE FUNCTION public.claim_incident(_incident_id uuid, _eta_minutes integer DEFAULT NULL::integer, _lock_minutes integer DEFAULT NULL::integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  uid uuid := auth.uid();
  inc public.incidents%ROWTYPE;
  holder uuid;
  lock_until timestamptz;
  grace integer := public.chase_setting_num('live_lock_grace_minutes', 15)::integer;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT * INTO inc FROM public.incidents WHERE id = _incident_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Incident not found'; END IF;

  IF NOT public.incident_market_allowed(uid, inc.market_id) THEN
    RAISE EXCEPTION 'Out of market';
  END IF;

  lock_until := now() + make_interval(mins => COALESCE(_lock_minutes, COALESCE(_eta_minutes, 0) + grace));

  IF inc.exclusivity = 'shared' THEN
    INSERT INTO public.incident_dispatches (incident_id, user_id, tier, responded_at, response)
    VALUES (_incident_id, uid, inc.escalation_tier, now(), 'accepted')
    ON CONFLICT (incident_id, user_id)
      DO UPDATE SET response = 'accepted', responded_at = now();
    UPDATE public.incidents
       SET status = 'accepted',
           lifecycle = 'claimed',
           accepted_by = COALESCE(accepted_by, uid),
           accepted_at = COALESCE(accepted_at, now()),
           claim_expires_at = GREATEST(COALESCE(claim_expires_at, lock_until), lock_until),
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
         lifecycle = 'claimed',
         needs_backup = false,
         claim_expires_at = lock_until,
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
$function$;

CREATE OR REPLACE FUNCTION public.release_stale_incident_locks()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  n integer;
  grace integer := public.chase_setting_num('live_lock_grace_minutes', 15)::integer;
BEGIN
  WITH released AS (
    UPDATE public.incidents
       SET locked_by = NULL, locked_at = NULL, accepted_by = NULL, accepted_at = NULL,
           status = 'dispatched', escalation_tier = 0, escalated_at = NULL
     WHERE exclusivity = 'exclusive'
       AND locked_by IS NOT NULL
       AND outcome IS NULL
       AND status NOT IN ('closed','discarded','on_scene')
       AND eta_at IS NOT NULL
       AND eta_at < now() - make_interval(mins => grace)
    RETURNING id
  ) SELECT count(*) INTO n FROM released;
  RETURN n;
END;
$function$;

CREATE OR REPLACE FUNCTION public.expire_stale_dispatches()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  n integer;
  decay integer := public.chase_setting_num('lead_decay_hours', 24)::integer;
BEGIN
  WITH expired AS (
    UPDATE public.incident_dispatches
       SET response = 'no_action', responded_at = now()
     WHERE response = 'pending' AND notified_at < now() - make_interval(hours => decay)
    RETURNING id
  ) SELECT count(*) INTO n FROM expired;
  RETURN n;
END;
$function$;

CREATE OR REPLACE FUNCTION public.escalate_incidents()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  inc record;
  interval_s integer;
  default_interval integer := public.chase_setting_num('escalation_interval_seconds', 90)::integer;
  next_tier smallint;
  recipients integer;
  advanced integer := 0;
  to_admin integer := 0;
BEGIN
  FOR inc IN
    SELECT i.* FROM public.incidents i
    WHERE i.status IN ('new','dispatched')
      AND i.duplicate_of IS NULL
      AND (i.locked_by IS NULL OR i.needs_backup)
      AND i.escalation_tier < 4
  LOOP
    interval_s := COALESCE(
      (SELECT escalation_interval_seconds FROM public.markets WHERE id = inc.market_id),
      default_interval);
    CONTINUE WHEN COALESCE(inc.escalated_at, inc.dispatched_at, inc.created_at) > now() - make_interval(secs => interval_s);

    IF inc.market_id IS NULL OR inc.zone_id IS NULL THEN
      UPDATE public.incidents
         SET escalation_tier = 4, escalated_at = now(), admin_routed = true,
             admin_route_reason = COALESCE(admin_route_reason, 'No mapped territory')
       WHERE id = inc.id;
      to_admin := to_admin + 1;
      CONTINUE;
    END IF;

    next_tier := (inc.escalation_tier + 1)::smallint;
    recipients := 0;
    WHILE next_tier <= 3 AND recipients = 0 LOOP
      SELECT count(*) INTO recipients FROM public.incident_tier_recipients(inc.id, next_tier);
      EXIT WHEN recipients > 0;
      next_tier := (next_tier + 1)::smallint;
    END LOOP;

    IF recipients = 0 THEN
      UPDATE public.incidents
         SET escalation_tier = 4, escalated_at = now(), admin_routed = true,
             admin_route_reason = COALESCE(admin_route_reason, 'No chaser available in market')
       WHERE id = inc.id;
      to_admin := to_admin + 1;
    ELSE
      INSERT INTO public.incident_dispatches (incident_id, user_id, tier)
      SELECT inc.id, r.user_id, next_tier FROM public.incident_tier_recipients(inc.id, next_tier) r
      ON CONFLICT (incident_id, user_id) DO NOTHING;
      UPDATE public.incidents
         SET escalation_tier = next_tier, escalated_at = now(),
             status = CASE WHEN status = 'new' THEN 'dispatched'::incident_status ELSE status END,
             dispatched_at = COALESCE(dispatched_at, now())
       WHERE id = inc.id;
      advanced := advanced + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('advanced', advanced, 'to_admin', to_admin,
                            'locks_released', public.release_stale_incident_locks());
END;
$function$;

CREATE OR REPLACE FUNCTION public.search_chase_incidents(_q text)
RETURNS TABLE(id uuid, address text, locality text, postal_code text, incident_type incident_type, lifecycle incident_lifecycle, reported_at timestamp with time zone, is_mine boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT i.id, i.address, i.locality, i.postal_code, i.incident_type, i.lifecycle,
         i.reported_at, (i.accepted_by = auth.uid()) AS is_mine
    FROM public.incidents i
   WHERE auth.uid() IS NOT NULL
     AND length(btrim(coalesce(_q, ''))) >= public.chase_setting_num('search_min_chars', 3)::integer
     AND public.incident_market_allowed(auth.uid(), i.market_id)
     AND i.reported_at > now() - make_interval(days => public.chase_setting_num('search_window_days', 7)::integer)
     AND (i.address ILIKE '%' || btrim(_q) || '%' OR i.postal_code ILIKE btrim(_q) || '%')
   ORDER BY i.reported_at DESC
   LIMIT public.chase_setting_num('search_result_limit', 20)::integer;
$function$;

CREATE OR REPLACE FUNCTION public.create_exposure_incident(_origin_incident_id uuid, _address text, _lat double precision DEFAULT NULL::double precision, _lon double precision DEFAULT NULL::double precision, _postal_code text DEFAULT NULL::text, _building_type text DEFAULT NULL::text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  uid uuid := auth.uid();
  origin public.incidents%ROWTYPE;
  new_id uuid;
  grp uuid;
  lock_hours integer := public.chase_setting_num('overnight_lock_hours', 4)::integer;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF _address IS NULL OR length(btrim(_address)) < 4 THEN RAISE EXCEPTION 'Address required'; END IF;

  SELECT * INTO origin FROM public.incidents WHERE id = _origin_incident_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Origin incident not found'; END IF;
  IF NOT public.incident_market_allowed(uid, origin.market_id) THEN
    RAISE EXCEPTION 'Out of market';
  END IF;

  grp := COALESCE(origin.exposure_group_id, origin.id);

  INSERT INTO public.incidents (
    source, external_ref, incident_type, address, locality, postal_code, lat, lon,
    market_id, zone_id, location_id, region, reported_at, status, lifecycle,
    exposure_group_id, is_exposure, building_type, created_by,
    accepted_by, accepted_at, locked_by, locked_at, claim_expires_at
  ) VALUES (
    'exposure', NULL, origin.incident_type, btrim(_address), origin.locality,
    COALESCE(_postal_code, origin.postal_code), _lat, _lon,
    origin.market_id, origin.zone_id, origin.location_id, origin.region,
    origin.reported_at, 'accepted', 'claimed',
    grp, true, _building_type, uid,
    uid, now(), uid, now(), now() + make_interval(hours => lock_hours)
  ) RETURNING id INTO new_id;

  UPDATE public.incidents SET exposure_group_id = grp WHERE id = origin.id;

  INSERT INTO public.incident_events (incident_id, event_type, actor_id, payload)
  VALUES (new_id, 'created', uid, jsonb_build_object('exposure_of', origin.id));

  RETURN new_id;
END;
$function$;

-- Outcome logging accepts a sub-option chosen from a managed list.
CREATE OR REPLACE FUNCTION public.log_incident_outcome(_incident_id uuid, _reason_id uuid, _sub_reason_id uuid DEFAULT NULL::uuid, _note text DEFAULT NULL::text, _worth_another_try boolean DEFAULT false, _revisit_after timestamp with time zone DEFAULT NULL::timestamp with time zone, _sub_label text DEFAULT NULL::text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
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

  keep_live := (NOT reason.kills_lead)
               OR (reason.allows_another_try AND COALESCE(_worth_another_try, false));

  IF reason.wins_lead THEN
    next_life := 'won';
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

REVOKE EXECUTE ON FUNCTION public.escalate_incidents() FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.expire_stale_dispatches() FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.release_stale_incident_locks() FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.claim_incident(uuid, integer, integer) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.search_chase_incidents(text) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.create_exposure_incident(uuid, text, double precision, double precision, text, text) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.log_incident_outcome(uuid, uuid, uuid, text, boolean, timestamp with time zone, text) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.chase_settings() FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.chase_setting_num(text, numeric) FROM anon, PUBLIC;
