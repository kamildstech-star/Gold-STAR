-- ---------------------------------------------------------------------------
-- Vehicle costs feed the overhead engine (5 Nov review, T9).
--
-- David: vehicle costs should flow into Settings › Billing & Costs › Engine
-- on their own — vehicle finance, vehicle insurance and vehicle maintenance —
-- instead of a value typed per hour.
--
-- 1. Three engine components, fleet-driven (key fleet_*), entered by the
--    Year unit like General liability can be:
--      fleet_finance      every financed or leased vehicle's payment, a year
--      fleet_insurance    every vehicle's insurance, a year
--      fleet_maintenance  maintenance spend over the last 12 months
--    The empty hand-typed "Vehicles" component they replace is archived when
--    it never held a value.
-- 2. fleet_overhead_sync(): totals each one from Fleet (vehicle_costs,
--    20261109140000, and vehicle_maintenance_records), converts a year to
--    $/hour the way the engine converts any yearly amount — round(year /
--    the Year unit's field hours, 2) — and, when it moved, publishes it the
--    way overhead_save does: a new dated money_values row for today (the
--    $/hour, and the yearly amount beside it), which the money_values audit
--    trigger writes to the change log with its note, then the auto-fill.
-- 3. It runs after any change to a vehicle's costs or maintenance records,
--    whoever makes it (SECURITY DEFINER: a fleet manager need not be able to
--    edit the engine), and once now.
-- 4. The engine refuses a typed value for a fleet_* component: it is read
--    only on the screen and in the database.
--
-- Company default only (office_id NULL): vehicles are summed company-wide.
-- Re-runnable.
-- ---------------------------------------------------------------------------

-- ============================================= 1. the components

INSERT INTO public.overhead_components (key, name, note, system, sort_order, unit_key)
SELECT x.key, x.name, x.note, true, x.sort_order, 'year'
  FROM (VALUES
    ('fleet_finance', 'Vehicle finance',
     'From Fleet: each financed or leased vehicle''s payment, a year.', 61),
    ('fleet_insurance', 'Vehicle insurance',
     'From Fleet: each vehicle''s insurance, a year.', 62),
    ('fleet_maintenance', 'Vehicle maintenance',
     'From Fleet: maintenance spend over the last 12 months.', 63)
  ) AS x(key, name, note, sort_order)
 WHERE EXISTS (SELECT 1 FROM public.overhead_units u WHERE u.key = 'year')
ON CONFLICT (key) DO NOTHING;

UPDATE public.overhead_components c
   SET archived_at = now()
 WHERE c.key = 'c_vehicles'
   AND c.archived_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM public.money_values mv
      WHERE mv.book = 'overhead' AND mv.item_key = c.key);

-- ============================================= 4. read only

CREATE OR REPLACE FUNCTION public.tg_money_values_fleet_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.book = 'overhead' AND NEW.item_key LIKE 'fleet\_%'
     AND coalesce(current_setting('gsr.fleet_sync', true), '') <> 'on' THEN
    RAISE EXCEPTION 'Vehicle costs come from Fleet — change them on each vehicle.'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_money_values_fleet_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS money_values_fleet_guard ON public.money_values;
CREATE TRIGGER money_values_fleet_guard BEFORE INSERT ON public.money_values
  FOR EACH ROW EXECUTE FUNCTION public.tg_money_values_fleet_guard();

-- ============================================= 2. the sync

CREATE OR REPLACE FUNCTION public.fleet_overhead_sync()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  yr_hours numeric;
  p record;
  cur_hr numeric;
  cur_amt numeric;
  total numeric;
  v numeric;
  why text;
  n integer := 0;
BEGIN
  SELECT u.hours INTO yr_hours FROM public.overhead_units u WHERE u.key = 'year';
  IF yr_hours IS NULL OR yr_hours <= 0 THEN
    RETURN 0;
  END IF;
  PERFORM set_config('gsr.fleet_sync', 'on', true);

  FOR p IN
    SELECT 'fleet_insurance'::text AS k,
           coalesce(sum(vc.insurance_amount
             * CASE WHEN vc.insurance_period = 'monthly' THEN 12 ELSE 1 END), 0) AS yearly,
           count(*) FILTER (WHERE coalesce(vc.insurance_amount, 0) > 0) AS cnt,
           'vehicle insurance'::text AS what
      FROM public.vehicle_costs vc
    UNION ALL
    SELECT 'fleet_finance',
           coalesce(sum(vc.finance_amount
             * CASE WHEN vc.finance_period = 'monthly' THEN 12 ELSE 1 END)
             FILTER (WHERE vc.ownership <> 'owned'), 0),
           count(*) FILTER (WHERE vc.ownership <> 'owned' AND coalesce(vc.finance_amount, 0) > 0),
           'vehicle finance and leases'
      FROM public.vehicle_costs vc
    UNION ALL
    SELECT 'fleet_maintenance',
           coalesce(sum(r.cost), 0),
           count(DISTINCT r.vehicle_id) FILTER (WHERE coalesce(r.cost, 0) > 0),
           'vehicle maintenance, last 12 months'
      FROM public.vehicle_maintenance_records r
     WHERE r.performed_on > current_date - 365 AND r.performed_on <= current_date
  LOOP
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM public.overhead_components c WHERE c.key = p.k AND c.archived_at IS NULL);
    total := round(p.yearly, 2);
    v := round(total / yr_hours, 2);
    SELECT r.value INTO cur_hr
      FROM public.resolve_money_value('overhead', p.k, 'cost_hr', NULL, current_date) r;
    SELECT r.value INTO cur_amt
      FROM public.resolve_money_value('overhead', p.k, 'amount_year', NULL, current_date) r;
    CONTINUE WHEN cur_hr IS NOT DISTINCT FROM v AND cur_amt IS NOT DISTINCT FROM total;

    why := format('From Fleet: %s %s a year across %s vehicle%s',
      p.what, to_char(total, 'FM$999,999,990.00'), p.cnt, CASE WHEN p.cnt = 1 THEN '' ELSE 's' END);
    DELETE FROM public.money_values mv
     WHERE mv.book = 'overhead' AND mv.item_key = p.k
       AND mv.measure IN ('cost_hr', 'amount_year')
       AND mv.office_id IS NULL AND mv.effective_from = current_date;
    INSERT INTO public.money_values (book, item_key, measure, office_id, effective_from, value, note)
    VALUES ('overhead', p.k, 'cost_hr', NULL, current_date, v, why),
           ('overhead', p.k, 'amount_year', NULL, current_date, total, why);
    n := n + 1;
  END LOOP;

  PERFORM set_config('gsr.fleet_sync', 'off', true);
  IF n > 0 THEN
    PERFORM public.overhead_refill_from(current_date);
  END IF;
  RETURN n;
END;
$$;
REVOKE ALL ON FUNCTION public.fleet_overhead_sync() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fleet_overhead_sync() TO service_role;

-- ============================================= 3. when Fleet changes

CREATE OR REPLACE FUNCTION public.tg_fleet_overhead_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.fleet_overhead_sync();
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_fleet_overhead_sync() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS vehicle_costs_overhead_sync ON public.vehicle_costs;
CREATE TRIGGER vehicle_costs_overhead_sync
  AFTER INSERT OR UPDATE OR DELETE ON public.vehicle_costs
  FOR EACH STATEMENT EXECUTE FUNCTION public.tg_fleet_overhead_sync();

DROP TRIGGER IF EXISTS vehicle_maintenance_overhead_sync ON public.vehicle_maintenance_records;
CREATE TRIGGER vehicle_maintenance_overhead_sync
  AFTER INSERT OR UPDATE OR DELETE ON public.vehicle_maintenance_records
  FOR EACH STATEMENT EXECUTE FUNCTION public.tg_fleet_overhead_sync();

SELECT public.fleet_overhead_sync();

-- VERIFY:
--   SELECT key, name, unit_key, archived_at FROM public.overhead_components ORDER BY sort_order;
--   SELECT item_key, measure, effective_from, value, note FROM public.money_values
--    WHERE book = 'overhead' AND item_key LIKE 'fleet\_%' ORDER BY effective_from;
-- ROLLBACK:
--   DROP TRIGGER vehicle_costs_overhead_sync ON public.vehicle_costs;
--   DROP TRIGGER vehicle_maintenance_overhead_sync ON public.vehicle_maintenance_records;
--   DROP TRIGGER money_values_fleet_guard ON public.money_values;
--   UPDATE public.overhead_components SET archived_at = now() WHERE key LIKE 'fleet\_%';
--   (money_values rows stay: they are history.)
