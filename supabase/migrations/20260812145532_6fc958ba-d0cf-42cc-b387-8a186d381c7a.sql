-- ============ TERRITORY ============
CREATE TABLE public.markets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  code text NOT NULL UNIQUE,
  is_active boolean NOT NULL DEFAULT true,
  escalation_interval_seconds integer NOT NULL DEFAULT 90,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.markets TO authenticated;
GRANT ALL ON public.markets TO service_role;
ALTER TABLE public.markets ENABLE ROW LEVEL SECURITY;
CREATE POLICY markets_select ON public.markets FOR SELECT TO authenticated USING (true);
CREATE POLICY markets_manage ON public.markets FOR ALL TO authenticated
  USING (public.is_privileged((SELECT auth.uid()))) WITH CHECK (public.is_privileged((SELECT auth.uid())));

CREATE TABLE public.zones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id uuid NOT NULL REFERENCES public.markets(id) ON DELETE CASCADE,
  name text NOT NULL,
  postal_codes text[] NOT NULL DEFAULT '{}',
  is_active boolean NOT NULL DEFAULT true,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.zones TO authenticated;
GRANT ALL ON public.zones TO service_role;
ALTER TABLE public.zones ENABLE ROW LEVEL SECURITY;
CREATE POLICY zones_select ON public.zones FOR SELECT TO authenticated USING (true);
CREATE POLICY zones_manage ON public.zones FOR ALL TO authenticated
  USING (public.is_privileged((SELECT auth.uid()))) WITH CHECK (public.is_privileged((SELECT auth.uid())));
CREATE INDEX zones_market_idx ON public.zones(market_id);
CREATE INDEX zones_postal_idx ON public.zones USING gin (postal_codes);

CREATE TABLE public.zone_adjacency (
  zone_id uuid NOT NULL REFERENCES public.zones(id) ON DELETE CASCADE,
  adjacent_zone_id uuid NOT NULL REFERENCES public.zones(id) ON DELETE CASCADE,
  PRIMARY KEY (zone_id, adjacent_zone_id),
  CHECK (zone_id <> adjacent_zone_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.zone_adjacency TO authenticated;
GRANT ALL ON public.zone_adjacency TO service_role;
ALTER TABLE public.zone_adjacency ENABLE ROW LEVEL SECURITY;
CREATE POLICY zone_adjacency_select ON public.zone_adjacency FOR SELECT TO authenticated USING (true);
CREATE POLICY zone_adjacency_manage ON public.zone_adjacency FOR ALL TO authenticated
  USING (public.is_privileged((SELECT auth.uid()))) WITH CHECK (public.is_privileged((SELECT auth.uid())));

-- one market per chaser: user_id is the primary key
CREATE TABLE public.chaser_territories (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  market_id uuid NOT NULL REFERENCES public.markets(id) ON DELETE RESTRICT,
  primary_zone_id uuid REFERENCES public.zones(id) ON DELETE SET NULL,
  dispatch_zone_ids uuid[] NOT NULL DEFAULT '{}',
  dispatch_whole_market boolean NOT NULL DEFAULT false,
  view_zone_ids uuid[] NOT NULL DEFAULT '{}',
  view_whole_market boolean NOT NULL DEFAULT true,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.chaser_territories TO authenticated;
GRANT ALL ON public.chaser_territories TO service_role;
ALTER TABLE public.chaser_territories ENABLE ROW LEVEL SECURITY;
CREATE POLICY chaser_territories_select ON public.chaser_territories FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) OR public.is_privileged((SELECT auth.uid())));
CREATE POLICY chaser_territories_manage ON public.chaser_territories FOR ALL TO authenticated
  USING (public.is_privileged((SELECT auth.uid()))) WITH CHECK (public.is_privileged((SELECT auth.uid())));
CREATE INDEX chaser_territories_market_idx ON public.chaser_territories(market_id);

CREATE TRIGGER markets_updated BEFORE UPDATE ON public.markets
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER zones_updated BEFORE UPDATE ON public.zones
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER chaser_territories_updated BEFORE UPDATE ON public.chaser_territories
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============ INCIDENT COLUMNS ============
DO $$ BEGIN
  CREATE TYPE public.incident_exclusivity AS ENUM ('exclusive','shared');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.dispatch_response AS ENUM ('pending','accepted','declined','declined_race','no_response');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.incidents
  ADD COLUMN IF NOT EXISTS market_id uuid REFERENCES public.markets(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS zone_id uuid REFERENCES public.zones(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS exclusivity public.incident_exclusivity NOT NULL DEFAULT 'exclusive',
  ADD COLUMN IF NOT EXISTS locked_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS eta_at timestamptz,
  ADD COLUMN IF NOT EXISTS needs_backup boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS escalation_tier smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS escalated_at timestamptz,
  ADD COLUMN IF NOT EXISTS admin_routed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS admin_route_reason text,
  ADD COLUMN IF NOT EXISTS dedupe_key text,
  ADD COLUMN IF NOT EXISTS duplicate_of uuid REFERENCES public.incidents(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS incidents_market_idx ON public.incidents(market_id);
CREATE INDEX IF NOT EXISTS incidents_dedupe_idx ON public.incidents(dedupe_key, reported_at);

-- ============ DISPATCH LOG ============
CREATE TABLE public.incident_dispatches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES public.incidents(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tier smallint NOT NULL,
  notified_at timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  response public.dispatch_response NOT NULL DEFAULT 'pending',
  is_demo boolean NOT NULL DEFAULT false,
  UNIQUE (incident_id, user_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.incident_dispatches TO authenticated;
GRANT ALL ON public.incident_dispatches TO service_role;
ALTER TABLE public.incident_dispatches ENABLE ROW LEVEL SECURITY;
CREATE POLICY incident_dispatches_select ON public.incident_dispatches FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) OR public.is_privileged((SELECT auth.uid())));
CREATE POLICY incident_dispatches_manage ON public.incident_dispatches FOR ALL TO authenticated
  USING (public.is_privileged((SELECT auth.uid()))) WITH CHECK (public.is_privileged((SELECT auth.uid())));
CREATE INDEX incident_dispatches_incident_idx ON public.incident_dispatches(incident_id);

-- ============ HELPERS ============
-- The market wall. A user with a territory row sees only their own market.
CREATE OR REPLACE FUNCTION public.user_market(_user_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT market_id FROM public.chaser_territories WHERE user_id = _user_id
$$;

CREATE OR REPLACE FUNCTION public.incident_market_allowed(_user_id uuid, _market_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN (SELECT market_id FROM public.chaser_territories WHERE user_id = _user_id) IS NULL THEN true
    ELSE _market_id IS NOT NULL
         AND _market_id = (SELECT market_id FROM public.chaser_territories WHERE user_id = _user_id)
  END
$$;

-- Resolve a postal code to a zone (and its market). NULL zone => route to admin.
CREATE OR REPLACE FUNCTION public.resolve_zone(_postal_code text)
RETURNS TABLE (zone_id uuid, market_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT z.id, z.market_id
  FROM public.zones z
  WHERE z.is_active AND _postal_code IS NOT NULL AND _postal_code = ANY (z.postal_codes)
  LIMIT 1
$$;

GRANT EXECUTE ON FUNCTION public.user_market(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.incident_market_allowed(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_zone(text) TO authenticated;

-- ============ RLS: fold the market wall into incident visibility ============
DROP POLICY IF EXISTS incidents_select_by_acceptor ON public.incidents;
DROP POLICY IF EXISTS incidents_select_by_creator ON public.incidents;
DROP POLICY IF EXISTS incidents_select_by_location ON public.incidents;
DROP POLICY IF EXISTS incidents_select_staff ON public.incidents;

CREATE POLICY incidents_select ON public.incidents FOR SELECT TO authenticated
USING (
  public.incident_market_allowed((SELECT auth.uid()), market_id)
  AND (
    accepted_by = (SELECT auth.uid())
    OR created_by = (SELECT auth.uid())
    OR (location_id IS NOT NULL AND public.can_view_location((SELECT auth.uid()), location_id))
    OR public.is_privileged((SELECT auth.uid()))
  )
);

-- ============ TERRITORY + DEDUPE ON INTAKE ============
CREATE OR REPLACE FUNCTION public.incidents_classify()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r record;
  dup uuid;
BEGIN
  -- Territory resolution: postal code -> zone -> market.
  IF NEW.zone_id IS NULL AND NEW.postal_code IS NOT NULL THEN
    SELECT * INTO r FROM public.resolve_zone(NEW.postal_code);
    IF FOUND THEN
      NEW.zone_id := r.zone_id;
      NEW.market_id := COALESCE(NEW.market_id, r.market_id);
    END IF;
  END IF;

  -- Unmapped ZIP never drops: it goes to admin.
  IF NEW.zone_id IS NULL THEN
    NEW.admin_routed := true;
    NEW.admin_route_reason := COALESCE(
      NEW.admin_route_reason,
      CASE WHEN NEW.postal_code IS NULL THEN 'No postal code on incident'
           ELSE 'ZIP ' || NEW.postal_code || ' is not mapped to a zone' END
    );
  END IF;

  -- Dedupe key: address + type. Window applied below.
  NEW.dedupe_key := lower(regexp_replace(coalesce(NEW.address, NEW.external_ref, NEW.id::text), '\s+', ' ', 'g'))
                    || '|' || NEW.incident_type::text;

  IF TG_OP = 'INSERT' THEN
    SELECT i.id INTO dup
    FROM public.incidents i
    WHERE i.dedupe_key = NEW.dedupe_key
      AND i.duplicate_of IS NULL
      AND i.reported_at > NEW.reported_at - interval '60 minutes'
      AND i.reported_at < NEW.reported_at + interval '60 minutes'
    ORDER BY i.reported_at ASC
    LIMIT 1;
    IF dup IS NOT NULL THEN
      NEW.duplicate_of := dup;
      NEW.status := 'discarded';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS incidents_classify_trg ON public.incidents;
CREATE TRIGGER incidents_classify_trg BEFORE INSERT OR UPDATE OF postal_code, address, incident_type
  ON public.incidents FOR EACH ROW EXECUTE FUNCTION public.incidents_classify();

-- ============ CLAIMING ============
-- First write wins. Losers are recorded as declined_race, not decline.
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

  -- Exclusive: only an unlocked incident, or one reopened for backup, can be taken.
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

  -- Lost the race.
  SELECT locked_by INTO holder FROM public.incidents WHERE id = _incident_id;
  INSERT INTO public.incident_dispatches (incident_id, user_id, tier, responded_at, response)
  VALUES (_incident_id, uid, inc.escalation_tier, now(), 'declined_race')
  ON CONFLICT (incident_id, user_id) DO UPDATE SET response = 'declined_race', responded_at = now();

  RETURN jsonb_build_object(
    'claimed', false,
    'holder_id', holder,
    'holder_name', (SELECT full_name FROM public.profiles WHERE id = holder),
    'eta_at', (SELECT eta_at FROM public.incidents WHERE id = _incident_id)
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.claim_incident(uuid, integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.decline_incident(_incident_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE uid uuid := auth.uid();
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  INSERT INTO public.incident_dispatches (incident_id, user_id, tier, responded_at, response)
  VALUES (_incident_id, uid,
          COALESCE((SELECT escalation_tier FROM public.incidents WHERE id = _incident_id), 0),
          now(), 'declined')
  ON CONFLICT (incident_id, user_id) DO UPDATE SET response = 'declined', responded_at = now();
END;
$$;
GRANT EXECUTE ON FUNCTION public.decline_incident(uuid) TO authenticated;

-- NEED BACKUP reopens an exclusive incident for further accepts.
CREATE OR REPLACE FUNCTION public.request_backup(_incident_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE uid uuid := auth.uid();
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  UPDATE public.incidents
     SET needs_backup = true, escalation_tier = 0, escalated_at = NULL
   WHERE id = _incident_id
     AND (locked_by = uid OR accepted_by = uid OR public.is_privileged(uid));
  IF NOT FOUND THEN RAISE EXCEPTION 'Not permitted'; END IF;
END;
$$;
GRANT EXECUTE ON FUNCTION public.request_backup(uuid) TO authenticated;

-- Lock release: cancelled, or no outcome 15 minutes past ETA.
CREATE OR REPLACE FUNCTION public.release_stale_incident_locks()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer;
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
       AND eta_at < now() - interval '15 minutes'
    RETURNING id
  ) SELECT count(*) INTO n FROM released;
  RETURN n;
END;
$$;
GRANT EXECUTE ON FUNCTION public.release_stale_incident_locks() TO authenticated;

-- ============ ESCALATION ============
-- Tier 1 primary zone, tier 2 adjacent zones, tier 3 whole market, then admin.
CREATE OR REPLACE FUNCTION public.incident_tier_recipients(_incident_id uuid, _tier smallint)
RETURNS TABLE (user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH inc AS (SELECT * FROM public.incidents WHERE id = _incident_id)
  SELECT t.user_id
  FROM public.chaser_territories t, inc
  WHERE t.market_id = inc.market_id
    AND (
      (_tier = 1 AND inc.zone_id IS NOT NULL AND t.primary_zone_id = inc.zone_id)
      OR (_tier = 2 AND inc.zone_id IS NOT NULL AND t.primary_zone_id IN (
            SELECT adjacent_zone_id FROM public.zone_adjacency WHERE zone_id = inc.zone_id))
      OR (_tier = 3)
    )
    AND (
      t.dispatch_whole_market
      OR inc.zone_id IS NULL
      OR t.dispatch_zone_ids = '{}'::uuid[]
      OR inc.zone_id = ANY (t.dispatch_zone_ids)
      OR t.primary_zone_id = inc.zone_id
    )
$$;
GRANT EXECUTE ON FUNCTION public.incident_tier_recipients(uuid, smallint) TO authenticated;

-- Advance every open incident that has waited past its market's interval.
-- Empty tiers are skipped, never looped; tier 4 means admin owns it.
CREATE OR REPLACE FUNCTION public.escalate_incidents()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  inc record;
  interval_s integer;
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
    interval_s := COALESCE((SELECT escalation_interval_seconds FROM public.markets WHERE id = inc.market_id), 90);
    CONTINUE WHEN COALESCE(inc.escalated_at, inc.dispatched_at, inc.created_at) > now() - make_interval(secs => interval_s);

    -- Unmapped territory goes straight to admin.
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
$$;
GRANT EXECUTE ON FUNCTION public.escalate_incidents() TO authenticated;