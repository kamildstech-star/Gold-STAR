-- Overhead engine units (30 Oct): a component can be entered per hour, day,
-- week, month, year or any unit an owner/admin adds. Insurance is billed by
-- the year, so "General liability $12,000 / year" is typed as that.
--
-- 1. overhead_units: a unit and how many field-labor hours it covers (hour 1,
--    day 8, week 40, month 173.33, year 2080). Owner/admin add more and change
--    the hours — a company-wide policy might be "Year (whole crew)" at the
--    crew's total hours. Changing a unit's hours reaches the next value typed
--    in it; values already published keep the $/hour they were saved at.
-- 2. overhead_components.unit_key: the unit a component is entered in.
-- 3. overhead_save gains three ops and takes an amount on 'value' and 'add':
--      { op: 'unit_add', name, hours }        → key u_<slug>
--      { op: 'unit_edit', unit, name?, hours? }
--      { op: 'set_unit', component, unit }
--      'value' / 'add' with { amount, unit }: the $/hour is worked out here,
--      round(amount / hours, 2), so the engine's sum, the auto-fill and the
--      history are exactly as before (book overhead, measure cost_hr). The
--      amount as typed is kept beside it (measure amount_<unit>, same office
--      and date) so the screen shows "$12,000 / year", not a re-multiplied
--      figure.
-- Nothing else changes: overhead_total() still sums cost_hr.

-- ===================================================== 1. overhead_units

CREATE TABLE IF NOT EXISTS public.overhead_units (
  key text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  name text NOT NULL CHECK (length(btrim(name)) > 0 AND length(name) <= 40),
  hours numeric(10,2) NOT NULL CHECK (hours > 0),
  system boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 1000,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid()
);
COMMENT ON TABLE public.overhead_units IS
  'Units an overhead component can be entered in, with the field-labor hours each covers. The $/hour is amount / hours. Owner/admin only. See 20261104120000.';

INSERT INTO public.overhead_units (key, name, hours, system, sort_order) VALUES
  ('hour', 'Hour', 1, true, 10),
  ('day', 'Day', 8, false, 20),
  ('week', 'Week', 40, false, 30),
  ('month', 'Month', 173.33, false, 40),
  ('year', 'Year', 2080, false, 50)
ON CONFLICT (key) DO NOTHING;

ALTER TABLE public.overhead_units ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.overhead_units FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.overhead_units TO authenticated;
GRANT ALL ON public.overhead_units TO service_role;
DROP POLICY IF EXISTS overhead_units_read ON public.overhead_units;
CREATE POLICY overhead_units_read ON public.overhead_units
  FOR SELECT TO authenticated USING (public.can_manage_overhead((SELECT auth.uid())));
DROP POLICY IF EXISTS active_profile_required ON public.overhead_units;
CREATE POLICY active_profile_required ON public.overhead_units
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT goldstar_private.profile_is_active(auth.uid())))
  WITH CHECK ((SELECT goldstar_private.profile_is_active(auth.uid())));
DROP POLICY IF EXISTS anonymous_business_access_denied ON public.overhead_units;
CREATE POLICY anonymous_business_access_denied ON public.overhead_units
  AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

-- ===================================================== 2. component unit

ALTER TABLE public.overhead_components
  ADD COLUMN IF NOT EXISTS unit_key text NOT NULL DEFAULT 'hour'
  REFERENCES public.overhead_units(key) ON DELETE RESTRICT;
COMMENT ON COLUMN public.overhead_components.unit_key IS
  'The unit the component is entered in (overhead_units). Its value is still stored per hour.';

-- ===================================================== 3. overhead_save

/*
 * _changes is an array of:
 *   { op: 'value', component, office_id, value, effective_from, amount?, unit? }
 *       value null on an office = reset; with amount + unit, value is worked
 *       out here as round(amount / hours, 2)
 *   { op: 'add', name, note?, value?, effective_from?, amount?, unit? }  → key c_<slug>
 *   { op: 'edit', component, name?, note? }
 *   { op: 'archive', component }  (added components only; publish 0 to switch a standard one off)
 *   { op: 'set_unit', component, unit }
 *   { op: 'unit_add', name, hours }  → key u_<slug>
 *   { op: 'unit_edit', unit, name?, hours? }  (Hour stays 1 hour)
 *   { op: 'temp_wage', office_id, value, effective_from }  → labour_rates temp, not the engine
 *   { op: 'apply' }  re-run the auto-fill from today (nothing else changes)
 * Every publish re-runs the auto-fill from its date.
 */
CREATE OR REPLACE FUNCTION public.overhead_save(_changes jsonb, _note text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c jsonb;
  n integer := 0;
  k text;
  office uuid;
  v numeric;
  amt numeric;
  u text;
  hrs numeric;
  eff date;
  refill date;
  nm text;
  old_unit text;
BEGIN
  IF NOT public.can_manage_overhead(auth.uid()) THEN
    RAISE EXCEPTION 'Only an owner or admin can change the overhead engine.' USING ERRCODE = '42501';
  END IF;
  IF nullif(btrim(_note), '') IS NULL THEN
    RAISE EXCEPTION 'Say why — every overhead change needs a note.' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(_changes) IS DISTINCT FROM 'array' OR jsonb_array_length(_changes) = 0 THEN
    RAISE EXCEPTION 'Nothing to save.' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('gsr.money_note', btrim(_note), true);

  FOR c IN SELECT * FROM jsonb_array_elements(_changes) LOOP
    office := nullif(c->>'office_id', '')::uuid;
    v := CASE WHEN jsonb_typeof(c->'value') = 'number' THEN (c->>'value')::numeric END;
    amt := CASE WHEN jsonb_typeof(c->'amount') = 'number' THEN (c->>'amount')::numeric END;
    u := nullif(c->>'unit', '');
    hrs := NULL;
    eff := coalesce(nullif(c->>'effective_from', '')::date, current_date);

    -- An amount in a unit: the $/hour is worked out here, never trusted from the screen.
    IF amt IS NOT NULL AND c->>'op' IN ('value', 'add') THEN
      SELECT ou.hours INTO hrs FROM public.overhead_units ou WHERE ou.key = coalesce(u, 'hour');
      IF hrs IS NULL THEN
        RAISE EXCEPTION 'No overhead unit %.', u USING ERRCODE = 'P0002';
      END IF;
      IF amt < 0 OR amt <> round(amt, 2) THEN
        RAISE EXCEPTION 'Dollars and cents, 0 or more (%).', amt USING ERRCODE = '22023';
      END IF;
      v := round(amt / hrs, 2);
    END IF;

    IF c->>'op' IN ('value', 'temp_wage', 'add') THEN
      IF eff < current_date THEN
        RAISE EXCEPTION 'A change can take effect today or later, not on %.', eff USING ERRCODE = '22023';
      END IF;
      IF v IS NOT NULL AND (v < 0 OR v <> round(v, 2)) THEN
        RAISE EXCEPTION 'Dollars and cents per hour, 0 or more (%).', v USING ERRCODE = '22023';
      END IF;
    END IF;

    IF c->>'op' = 'value' THEN
      k := c->>'component';
      IF NOT EXISTS (SELECT 1 FROM public.overhead_components WHERE key = k AND archived_at IS NULL) THEN
        RAISE EXCEPTION 'No overhead component %.', k USING ERRCODE = 'P0002';
      END IF;
      IF v IS NULL AND office IS NULL THEN
        RAISE EXCEPTION 'The company default for % needs a value.', k USING ERRCODE = '22023';
      END IF;
      DELETE FROM public.money_values mv
       WHERE mv.book = 'overhead' AND mv.item_key = k
         AND (mv.measure = 'cost_hr' OR mv.measure LIKE 'amount\_%')
         AND mv.office_id IS NOT DISTINCT FROM office AND mv.effective_from = eff;
      INSERT INTO public.money_values (book, item_key, measure, office_id, effective_from, value, note)
      VALUES ('overhead', k, 'cost_hr', office, eff, v, btrim(_note));
      IF amt IS NOT NULL AND coalesce(u, 'hour') <> 'hour' THEN
        INSERT INTO public.money_values (book, item_key, measure, office_id, effective_from, value, note)
        VALUES ('overhead', k, 'amount_' || u, office, eff, amt, btrim(_note));
      END IF;
      IF k = 'wage' THEN
        PERFORM public.overhead_publish_labour('gsr', office, v, eff, btrim(_note));
      END IF;
      refill := least(coalesce(refill, eff), eff);
    ELSIF c->>'op' = 'add' THEN
      nm := nullif(btrim(c->>'name'), '');
      IF nm IS NULL THEN
        RAISE EXCEPTION 'A component needs a name.' USING ERRCODE = '22023';
      END IF;
      IF EXISTS (SELECT 1 FROM public.overhead_components WHERE lower(name) = lower(nm)) THEN
        RAISE EXCEPTION 'There is already a component called %.', nm USING ERRCODE = '23505';
      END IF;
      IF u IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.overhead_units WHERE key = u) THEN
        RAISE EXCEPTION 'No overhead unit %.', u USING ERRCODE = 'P0002';
      END IF;
      k := left('c_' || btrim(regexp_replace(lower(nm), '[^a-z0-9]+', '_', 'g'), '_'), 40);
      IF EXISTS (SELECT 1 FROM public.overhead_components WHERE key = k) THEN
        k := left(k, 33) || '_' || substr(md5(random()::text), 1, 6);
      END IF;
      INSERT INTO public.overhead_components (key, name, note, sort_order, unit_key)
      VALUES (k, nm, nullif(btrim(c->>'note'), ''),
              coalesce((SELECT max(sort_order) FROM public.overhead_components), 0) + 10,
              coalesce(u, 'hour'));
      IF v IS NOT NULL THEN
        INSERT INTO public.money_values (book, item_key, measure, office_id, effective_from, value, note)
        VALUES ('overhead', k, 'cost_hr', NULL, eff, v, btrim(_note));
        IF amt IS NOT NULL AND coalesce(u, 'hour') <> 'hour' THEN
          INSERT INTO public.money_values (book, item_key, measure, office_id, effective_from, value, note)
          VALUES ('overhead', k, 'amount_' || u, NULL, eff, amt, btrim(_note));
        END IF;
        refill := least(coalesce(refill, eff), eff);
      END IF;
    ELSIF c->>'op' = 'edit' THEN
      UPDATE public.overhead_components SET
        name = coalesce(nullif(btrim(c->>'name'), ''), name),
        note = CASE WHEN c ? 'note' THEN nullif(btrim(c->>'note'), '') ELSE note END
       WHERE key = c->>'component';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'No overhead component %.', c->>'component' USING ERRCODE = 'P0002';
      END IF;
    ELSIF c->>'op' = 'archive' THEN
      UPDATE public.overhead_components SET archived_at = now()
       WHERE key = c->>'component' AND archived_at IS NULL;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'No overhead component %.', c->>'component' USING ERRCODE = 'P0002';
      END IF;
      refill := least(coalesce(refill, current_date), current_date);
    ELSIF c->>'op' = 'set_unit' THEN
      k := c->>'component';
      IF u IS NULL OR NOT EXISTS (SELECT 1 FROM public.overhead_units WHERE key = u) THEN
        RAISE EXCEPTION 'No overhead unit %.', coalesce(u, 'blank') USING ERRCODE = 'P0002';
      END IF;
      SELECT unit_key INTO old_unit FROM public.overhead_components WHERE key = k;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'No overhead component %.', k USING ERRCODE = 'P0002';
      END IF;
      IF old_unit IS DISTINCT FROM u THEN
        UPDATE public.overhead_components SET unit_key = u WHERE key = k;
        PERFORM public.money_audit_write('overhead', 'overhead_component', k, 'unit',
          to_jsonb(old_unit), to_jsonb(u));
      END IF;
    ELSIF c->>'op' = 'unit_add' THEN
      nm := nullif(btrim(c->>'name'), '');
      hrs := CASE WHEN jsonb_typeof(c->'hours') = 'number' THEN (c->>'hours')::numeric END;
      IF nm IS NULL THEN
        RAISE EXCEPTION 'A unit needs a name.' USING ERRCODE = '22023';
      END IF;
      IF hrs IS NULL OR hrs <= 0 OR hrs <> round(hrs, 2) THEN
        RAISE EXCEPTION 'Field hours in a %: more than 0, to two decimals.', nm USING ERRCODE = '22023';
      END IF;
      IF EXISTS (SELECT 1 FROM public.overhead_units WHERE lower(name) = lower(nm)) THEN
        RAISE EXCEPTION 'There is already a unit called %.', nm USING ERRCODE = '23505';
      END IF;
      k := left('u_' || btrim(regexp_replace(lower(nm), '[^a-z0-9]+', '_', 'g'), '_'), 40);
      IF EXISTS (SELECT 1 FROM public.overhead_units WHERE key = k) THEN
        k := left(k, 33) || '_' || substr(md5(random()::text), 1, 6);
      END IF;
      INSERT INTO public.overhead_units (key, name, hours, sort_order)
      VALUES (k, nm, hrs, coalesce((SELECT max(sort_order) FROM public.overhead_units), 0) + 10);
      PERFORM public.money_audit_write('overhead', 'overhead_unit', k, 'created', NULL,
        jsonb_build_object('name', nm, 'hours', hrs));
    ELSIF c->>'op' = 'unit_edit' THEN
      u := c->>'unit';
      nm := nullif(btrim(c->>'name'), '');
      hrs := CASE WHEN jsonb_typeof(c->'hours') = 'number' THEN (c->>'hours')::numeric END;
      IF u = 'hour' AND hrs IS NOT NULL AND hrs <> 1 THEN
        RAISE EXCEPTION 'An hour is one hour.' USING ERRCODE = '22023';
      END IF;
      IF hrs IS NOT NULL AND (hrs <= 0 OR hrs <> round(hrs, 2)) THEN
        RAISE EXCEPTION 'Field hours: more than 0, to two decimals.' USING ERRCODE = '22023';
      END IF;
      IF nm IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.overhead_units WHERE lower(name) = lower(nm) AND key <> u
      ) THEN
        RAISE EXCEPTION 'There is already a unit called %.', nm USING ERRCODE = '23505';
      END IF;
      FOR nm, hrs IN
        UPDATE public.overhead_units ou SET
          name = coalesce(nm, ou.name),
          hours = coalesce(hrs, ou.hours)
         WHERE ou.key = u
        RETURNING ou.name, ou.hours
      LOOP
        PERFORM public.money_audit_write('overhead', 'overhead_unit', u, 'edited', NULL,
          jsonb_build_object('name', nm, 'hours', hrs));
      END LOOP;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'No overhead unit %.', u USING ERRCODE = 'P0002';
      END IF;
    ELSIF c->>'op' = 'temp_wage' THEN
      IF v IS NULL AND office IS NULL THEN
        RAISE EXCEPTION 'The company-wide temp wage needs a value.' USING ERRCODE = '22023';
      END IF;
      PERFORM public.overhead_publish_labour('temp', office, v, eff, btrim(_note));
      PERFORM public.money_audit_write('overhead', 'labour_rate', 'temp', 'hourly_rate', NULL,
        jsonb_build_object('value', v, 'effective_from', eff), office, btrim(_note));
    ELSIF c->>'op' = 'apply' THEN
      refill := least(coalesce(refill, current_date), current_date);
    ELSE
      RAISE EXCEPTION 'Unknown overhead change %.', coalesce(c->>'op', 'blank') USING ERRCODE = '22023';
    END IF;
    n := n + 1;
  END LOOP;

  IF refill IS NOT NULL THEN
    PERFORM public.overhead_refill_from(refill);
  END IF;
  RETURN n;
END;
$$;
REVOKE ALL ON FUNCTION public.overhead_save(jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.overhead_save(jsonb, text) TO authenticated, service_role;
