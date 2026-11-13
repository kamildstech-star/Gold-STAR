-- 1. Chaser-set morning digest time (never hardcoded).
ALTER TABLE public.chaser_territories
  ADD COLUMN IF NOT EXISTS digest_time time NOT NULL DEFAULT '07:00';

-- 2. Exposures are siblings, not children: a shared group id, no parent link.
ALTER TABLE public.incidents
  ADD COLUMN IF NOT EXISTS exposure_group_id uuid,
  ADD COLUMN IF NOT EXISTS is_exposure boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS building_type text,
  ADD COLUMN IF NOT EXISTS claim_expires_at timestamptz;

UPDATE public.incidents SET exposure_group_id = id WHERE exposure_group_id IS NULL;
CREATE INDEX IF NOT EXISTS incidents_exposure_group_idx ON public.incidents (exposure_group_id);
CREATE INDEX IF NOT EXISTS incidents_still_open_idx ON public.incidents (market_id, lifecycle, reported_at DESC);

-- 3. Claim lock length is caller-supplied: 15 min on a live alert, 4 hours overnight.
DROP FUNCTION IF EXISTS public.claim_incident(uuid, integer);

CREATE OR REPLACE FUNCTION public.claim_incident(
  _incident_id uuid,
  _eta_minutes integer DEFAULT NULL,
  _lock_minutes integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  uid uuid := auth.uid();
  inc public.incidents%ROWTYPE;
  holder uuid;
  lock_until timestamptz;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT * INTO inc FROM public.incidents WHERE id = _incident_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Incident not found'; END IF;

  IF NOT public.incident_market_allowed(uid, inc.market_id) THEN
    RAISE EXCEPTION 'Out of market';
  END IF;

  lock_until := now() + make_interval(mins => COALESCE(_lock_minutes, COALESCE(_eta_minutes, 0) + 15));

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

REVOKE ALL ON FUNCTION public.claim_incident(uuid, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_incident(uuid, integer, integer) TO authenticated;

-- 4. A claim that produced no outcome by its expiry returns to the board.
CREATE OR REPLACE FUNCTION public.release_expired_claims()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE n integer;
BEGIN
  UPDATE public.incidents
     SET locked_by = NULL,
         locked_at = NULL,
         accepted_by = NULL,
         accepted_at = NULL,
         claim_expires_at = NULL,
         eta_at = NULL,
         status = 'dispatched',
         lifecycle = 'live',
         escalation_tier = 0
   WHERE claim_expires_at IS NOT NULL
     AND claim_expires_at < now()
     AND outcome IS NULL
     AND lifecycle = 'claimed';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$function$;

REVOKE ALL ON FUNCTION public.release_expired_claims() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.release_expired_claims() TO authenticated, service_role;

-- 5. Add a damaged neighbour as its own lead. Siblings share a group and
--    nothing else: separate homeowner, carrier, outcome and job.
CREATE OR REPLACE FUNCTION public.create_exposure_incident(
  _origin_incident_id uuid,
  _address text,
  _lat double precision DEFAULT NULL,
  _lon double precision DEFAULT NULL,
  _postal_code text DEFAULT NULL,
  _building_type text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  uid uuid := auth.uid();
  origin public.incidents%ROWTYPE;
  new_id uuid;
  grp uuid;
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
    uid, now(), uid, now(), now() + interval '4 hours'
  ) RETURNING id INTO new_id;

  UPDATE public.incidents SET exposure_group_id = grp WHERE id = origin.id;

  INSERT INTO public.incident_events (incident_id, event_type, actor_id, payload)
  VALUES (new_id, 'created', uid, jsonb_build_object('exposure_of', origin.id));

  RETURN new_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.create_exposure_incident(uuid, text, double precision, double precision, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_exposure_incident(uuid, text, double precision, double precision, text, text) TO authenticated;

-- 6. Search is not browse: 3 characters minimum, 7 days, 20 rows, own market.
CREATE OR REPLACE FUNCTION public.search_chase_incidents(_q text)
RETURNS TABLE (
  id uuid,
  address text,
  locality text,
  postal_code text,
  incident_type public.incident_type,
  lifecycle public.incident_lifecycle,
  reported_at timestamptz,
  is_mine boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT i.id, i.address, i.locality, i.postal_code, i.incident_type, i.lifecycle,
         i.reported_at, (i.accepted_by = auth.uid()) AS is_mine
    FROM public.incidents i
   WHERE auth.uid() IS NOT NULL
     AND length(btrim(coalesce(_q, ''))) >= 3
     AND public.incident_market_allowed(auth.uid(), i.market_id)
     AND i.reported_at > now() - interval '7 days'
     AND (i.address ILIKE '%' || btrim(_q) || '%' OR i.postal_code ILIKE btrim(_q) || '%')
   ORDER BY i.reported_at DESC
   LIMIT 20;
$function$;

REVOKE ALL ON FUNCTION public.search_chase_incidents(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_chase_incidents(text) TO authenticated;

-- 7. A chaser's own jobs: stage, days in stage, open action items and their own
--    commission with its state. No revenue, cost, margin or referral figures,
--    and no other chaser's jobs.
CREATE OR REPLACE FUNCTION public.my_chase_jobs()
RETURNS TABLE (
  job_id uuid,
  job_number text,
  address text,
  stage_name text,
  days_in_stage integer,
  open_tasks integer,
  commission_amount numeric,
  commission_state text,
  commission_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH mine AS (
    SELECT DISTINCT j.*
      FROM public.jobs j
     WHERE auth.uid() IS NOT NULL
       AND (
         EXISTS (SELECT 1 FROM public.incidents i WHERE i.job_id = j.id AND i.accepted_by = auth.uid())
         OR EXISTS (
           SELECT 1 FROM public.job_assignments a
            WHERE a.job_id = j.id AND a.user_id = auth.uid()
           )
       )
  ),
  paid AS (
    SELECT me.job_id, sum(me.amount) AS amount, max(me.created_at) AS at
      FROM public.money_events me
     WHERE me.event_type = 'commission_issued' AND me.rep_user_id = auth.uid()
     GROUP BY me.job_id
  ),
  plan AS (
    SELECT cp.rate_percent, cp.flat_amount
      FROM public.commission_plans cp
     WHERE cp.user_id = auth.uid()
       AND cp.effective_from <= current_date
       AND (cp.effective_to IS NULL OR cp.effective_to >= current_date)
     ORDER BY cp.effective_from DESC
     LIMIT 1
  ),
  billed AS (
    SELECT inv.job_id,
           sum(coalesce(inv.collected_amount, 0)) AS collected,
           sum(coalesce(inv.approved_amount, inv.billed_amount, 0)) AS approved
      FROM public.invoices inv
     GROUP BY inv.job_id
  )
  SELECT m.id,
         m.job_number,
         m.address,
         ps.name,
         GREATEST(0, (EXTRACT(EPOCH FROM (now() - coalesce(m.stage_entered_at, m.created_at))) / 86400)::int),
         (SELECT count(*)::int FROM public.tasks t
           WHERE t.job_id = m.id AND t.assignee = auth.uid() AND t.status <> 'done'),
         CASE
           WHEN p.amount IS NOT NULL THEN p.amount
           WHEN b.collected > 0 THEN coalesce((SELECT flat_amount FROM plan), b.collected * coalesce((SELECT rate_percent FROM plan), 0) / 100)
           ELSE coalesce((SELECT flat_amount FROM plan), coalesce(b.approved, 0) * coalesce((SELECT rate_percent FROM plan), 0) / 100)
         END,
         CASE
           WHEN p.amount IS NOT NULL THEN 'paid'
           WHEN coalesce(b.collected, 0) > 0 THEN 'confirmed'
           ELSE 'estimated'
         END,
         p.at
    FROM mine m
    LEFT JOIN public.pipeline_stages ps ON ps.id = m.stage_id
    LEFT JOIN paid p ON p.job_id = m.id
    LEFT JOIN billed b ON b.job_id = m.id
   ORDER BY m.created_at DESC
   LIMIT 100;
$function$;

REVOKE ALL ON FUNCTION public.my_chase_jobs() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_chase_jobs() TO authenticated;