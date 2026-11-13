-- Vehicle maintenance tracking: what was done to each van, and what is coming
-- due on it.
--
-- David, 24 Sep, on Fleet: per-vehicle maintenance, and the dates that must
-- not lapse — inspection, registration, insurance, next service — with his
-- Fleet-Vehicle Info sheet (insurance policy, registration and inspection
-- dates) as the data it has to hold.
--
-- Requires 20260928123000_notification_type_vehicle_due.sql. Run that first.
--
-- SHAPE
--   vehicle_maintenance_records  one row per thing done: date, type, odometer,
--                                cost, vendor, note.
--   vehicle_due_items            one row per vehicle per kind (inspection,
--                                registration, insurance, service): the due
--                                date, optionally a due odometer, how early to
--                                warn, and the reference/provider the sheet
--                                carries (policy number + carrier, plate/
--                                registration number, inspection station).
--                                One row per (vehicle, kind), so a sheet import
--                                is an upsert on that pair.
--
-- WHO SEES IT: exactly who sees the vehicle. The select policies repeat
-- vehicles_select (20260823090000) against the parent van, so a location's
-- maintenance history is that location's, and corporate sees across them.
-- WHO WRITES IT: whoever can see the van AND manages its office
-- (can_manage_location) or holds fleet.manage; vans not yet given an office
-- need fleet.manage or a privileged role, like their visibility.
--
-- ALERTS: run_vehicle_due_alerts(), daily, into the notification bell — the
-- way credential expiry already alerts (run_credential_expiry_alerts).

-- ---------------------------------------------------------------------------
-- 0. Who may see / write a given van. SECURITY DEFINER so the policies can
--    ask about the parent row without a recursive RLS read; explicit
--    auth checks, empty search_path.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.can_view_vehicle(_user_id uuid, _vehicle_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.vehicles v
     WHERE v.id = _vehicle_id
       AND CASE
             WHEN v.location_id IS NULL
               THEN public.has_permission(_user_id, 'fleet.view', NULL)
                    OR public.is_privileged(_user_id)
             ELSE public.can_view_location(_user_id, v.location_id)
           END
  );
$$;
REVOKE ALL ON FUNCTION public.can_view_vehicle(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_view_vehicle(uuid, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.can_manage_vehicle(_user_id uuid, _vehicle_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.vehicles v
     WHERE v.id = _vehicle_id
       AND public.can_view_vehicle(_user_id, v.id)
       AND (
         public.is_privileged(_user_id)
         OR public.has_permission(_user_id, 'fleet.manage', v.location_id)
         OR (v.location_id IS NOT NULL AND public.can_manage_location(_user_id, v.location_id))
       )
  );
$$;
REVOKE ALL ON FUNCTION public.can_manage_vehicle(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_manage_vehicle(uuid, uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 1. Maintenance records.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.vehicle_maintenance_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid NOT NULL REFERENCES public.vehicles(id) ON DELETE CASCADE,
  performed_on date NOT NULL,
  kind text NOT NULL CHECK (kind IN (
    'service', 'oil_change', 'tires', 'brakes', 'repair',
    'inspection', 'registration', 'insurance', 'other'
  )),
  -- Miles, as read off the dash. Optional: a registration renewal has none.
  odometer integer CHECK (odometer IS NULL OR odometer >= 0),
  cost numeric(12, 2) CHECK (cost IS NULL OR cost >= 0),
  vendor text,
  note text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vehicle_maintenance_records_vehicle_idx
  ON public.vehicle_maintenance_records (vehicle_id, performed_on DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.vehicle_maintenance_records TO authenticated;
GRANT ALL ON public.vehicle_maintenance_records TO service_role;
ALTER TABLE public.vehicle_maintenance_records ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS vehicle_maintenance_records_select ON public.vehicle_maintenance_records;
CREATE POLICY vehicle_maintenance_records_select ON public.vehicle_maintenance_records
  FOR SELECT TO authenticated
  USING (public.can_view_vehicle((SELECT auth.uid()), vehicle_id));

DROP POLICY IF EXISTS vehicle_maintenance_records_write ON public.vehicle_maintenance_records;
CREATE POLICY vehicle_maintenance_records_write ON public.vehicle_maintenance_records
  FOR ALL TO authenticated
  USING (public.can_manage_vehicle((SELECT auth.uid()), vehicle_id))
  WITH CHECK (public.can_manage_vehicle((SELECT auth.uid()), vehicle_id));

DROP TRIGGER IF EXISTS touch_vehicle_maintenance_records ON public.vehicle_maintenance_records;
CREATE TRIGGER touch_vehicle_maintenance_records BEFORE UPDATE ON public.vehicle_maintenance_records
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

-- ---------------------------------------------------------------------------
-- 2. Due items — one per vehicle per kind.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.vehicle_due_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid NOT NULL REFERENCES public.vehicles(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('inspection', 'registration', 'insurance', 'service')),
  -- Date-based is the rule; odometer-based is optional (service by miles).
  due_on date,
  due_odometer integer CHECK (due_odometer IS NULL OR due_odometer >= 0),
  warn_days integer NOT NULL DEFAULT 30 CHECK (warn_days BETWEEN 0 AND 365),
  warn_miles integer NOT NULL DEFAULT 500 CHECK (warn_miles BETWEEN 0 AND 100000),
  -- From the Fleet-Vehicle Info sheet: policy number, plate / registration
  -- number, inspection certificate; and who issues it (carrier, DMV, shop).
  reference text,
  provider text,
  note text,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vehicle_id, kind),
  CHECK (due_on IS NOT NULL OR due_odometer IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS vehicle_due_items_due_idx ON public.vehicle_due_items (due_on);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.vehicle_due_items TO authenticated;
GRANT ALL ON public.vehicle_due_items TO service_role;
ALTER TABLE public.vehicle_due_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS vehicle_due_items_select ON public.vehicle_due_items;
CREATE POLICY vehicle_due_items_select ON public.vehicle_due_items
  FOR SELECT TO authenticated
  USING (public.can_view_vehicle((SELECT auth.uid()), vehicle_id));

DROP POLICY IF EXISTS vehicle_due_items_write ON public.vehicle_due_items;
CREATE POLICY vehicle_due_items_write ON public.vehicle_due_items
  FOR ALL TO authenticated
  USING (public.can_manage_vehicle((SELECT auth.uid()), vehicle_id))
  WITH CHECK (public.can_manage_vehicle((SELECT auth.uid()), vehicle_id));

DROP TRIGGER IF EXISTS touch_vehicle_due_items ON public.vehicle_due_items;
CREATE TRIGGER touch_vehicle_due_items BEFORE UPDATE ON public.vehicle_due_items
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

-- ---------------------------------------------------------------------------
-- 3. Alerts. Once when an item enters its warning window, again in its last
--    week, then weekly while overdue — never daily for a month, which is how
--    a bell gets muted. The stage rides in entity_type so each is deduped on
--    its own. The van's office managers hear about it; a van with no office
--    yet goes to owners and admins, who are the only people who can see it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.run_vehicle_due_alerts()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  rec record;
  u uuid;
  n integer := 0;
  stage text;
  what text;
  dedupe interval;
BEGIN
  FOR rec IN
    SELECT d.id, d.kind, d.due_on, d.due_odometer, d.warn_days, d.warn_miles,
           v.id AS vehicle_id, v.label AS vehicle_label, v.location_id,
           (d.due_on - current_date) AS days_left,
           d.due_odometer - (
             SELECT max(r.odometer) FROM public.vehicle_maintenance_records r
              WHERE r.vehicle_id = v.id
           ) AS miles_left
      FROM public.vehicle_due_items d
      JOIN public.vehicles v ON v.id = d.vehicle_id
     WHERE COALESCE(v.is_demo, false) = false
  LOOP
    stage := CASE
      WHEN rec.days_left < 0 OR rec.miles_left < 0 THEN 'overdue'
      WHEN rec.days_left <= LEAST(7, rec.warn_days) THEN 'week'
      WHEN rec.days_left <= rec.warn_days OR rec.miles_left <= rec.warn_miles THEN 'window'
      ELSE NULL
    END;
    CONTINUE WHEN stage IS NULL;

    dedupe := CASE stage
      WHEN 'overdue' THEN interval '7 days'
      WHEN 'week' THEN interval '8 days'
      ELSE make_interval(days => rec.warn_days + 1)
    END;

    what := initcap(rec.kind);
    FOR u IN
      SELECT DISTINCT x FROM (
        SELECT lm.user_id AS x
          FROM public.location_members lm
         WHERE rec.location_id IS NOT NULL
           AND lm.location_id = rec.location_id
           AND (public.can_manage_location(lm.user_id, rec.location_id)
                OR public.has_permission(lm.user_id, 'fleet.manage', rec.location_id))
        UNION
        SELECT ur.user_id
          FROM public.user_roles ur
         WHERE rec.location_id IS NULL
           AND ur.role::text IN ('owner', 'admin')
      ) t
      WHERE x IS NOT NULL
    LOOP
      CONTINUE WHEN EXISTS (
        SELECT 1 FROM public.notifications nt
         WHERE nt.user_id = u
           AND nt.entity_type = 'vehicle_due:' || stage
           AND nt.entity_id = rec.id
           AND nt.created_at > now() - dedupe
      );

      INSERT INTO public.notifications
        (user_id, type, title, body, entity_type, entity_id, href, priority)
      VALUES (
        u,
        'vehicle_due',
        CASE
          WHEN rec.days_left < 0 THEN format('%s: %s overdue by %s days', rec.vehicle_label, what, -rec.days_left)
          WHEN rec.miles_left < 0 THEN format('%s: %s overdue by %s miles', rec.vehicle_label, what, -rec.miles_left)
          WHEN rec.days_left = 0 THEN format('%s: %s due today', rec.vehicle_label, what)
          WHEN rec.days_left IS NOT NULL AND rec.days_left <= rec.warn_days
            THEN format('%s: %s due in %s days', rec.vehicle_label, what, rec.days_left)
          ELSE format('%s: %s due in %s miles', rec.vehicle_label, what, rec.miles_left)
        END,
        CASE WHEN rec.due_on IS NOT NULL
             THEN format('Due %s.', to_char(rec.due_on, 'Mon DD, YYYY'))
             ELSE format('Due at %s miles.', rec.due_odometer) END,
        'vehicle_due:' || stage,
        rec.id,
        '/fleet/' || rec.vehicle_id,
        CASE WHEN stage = 'overdue' THEN 'high'::public.notification_priority
             ELSE 'normal'::public.notification_priority END
      );
      n := n + 1;
    END LOOP;
  END LOOP;
  RETURN n;
END;
$$;
REVOKE ALL ON FUNCTION public.run_vehicle_due_alerts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_vehicle_due_alerts() TO service_role;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron is not installed; vehicle-due-alerts remains unscheduled.';
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'vehicle-due-alerts') THEN
    PERFORM cron.unschedule('vehicle-due-alerts');
  END IF;
  -- 11:10 UTC: early on the East Coast, beside the other morning sweeps.
  PERFORM cron.schedule(
    'vehicle-due-alerts',
    '10 11 * * *',
    $cron$SELECT public.run_vehicle_due_alerts();$cron$
  );
END
$do$;
