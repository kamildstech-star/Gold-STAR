-- Billing & Costs, prompt 3: the Cost tab, the overhead cost engine, equipment
-- types as data, and the audit trail made readable.
--
-- 1. Two new books, 'overhead' (the engine; owner and admin only) beside
--    'cost'. Who reads what is spelled out once: a cost entry by the cost
--    roles (owner/admin/dev, finance, job.view_costs), an overhead entry by
--    owner and admin, everything else in the audit log by administrators.
-- 2. Costs move to money_values (book cost, measure cost_rate), office-aware
--    and dated like the T&M rates. Seeded from every cost on file:
--    tm_rate_codes.cost_rate per code, and per equipment type the day cost
--    most of its units carry (units keep their own, untouched). Ticket-only
--    machine classes (injector, ozone, hydroxyl) stay in app_settings
--    equipment_day_rates, which field-ticket costing still reads.
-- 3. The overhead engine: components (Wage, General liability, Workers'
--    comp, any added one) as money_values rows (book overhead, measure
--    cost_hr), per office or default, dated, never edited. Their sum is the
--    true cost of a field-labor hour. Every publish writes that sum onto
--    every FIELD labor code's cost (the auto-fill), from the publish date, so
--    a job's labor cost is a stored, dated value like any other cost.
--    Management and office titles keep hand-entered costs (catalog_items
--    labor_class).
--    Wage is seeded from, and keeps writing, labour_rates for the field
--    crew (crew_class gsr and the crew role), which the job ledger's running
--    cost and field-ticket costing read. Temp crew wage is published beside
--    it into labour_rates only (it is not part of the engine).
--    Seeding the engine changes no cost: auto-fill runs at the first publish
--    (or "Apply to labor costs"), never here.
-- 4. Job costing reads one resolver, tm_cost_rates(job): the job's frozen
--    sheet, else the cost store at the job's office as of its creation date.
--    New jobs freeze the store's cost.
-- 5. Equipment types become data: add (also a value of the equipment_type
--    enum, which cannot lose one), rename, default make/model, archive.
--    Audited in the catalog book.
--
-- Re-runnable. Seeds are NOT EXISTS-guarded; checks raise on a mismatch.

-- ============================================================ 1. books, access

ALTER TABLE public.money_audit_log DROP CONSTRAINT IF EXISTS money_audit_log_book_check;
ALTER TABLE public.money_audit_log DROP CONSTRAINT IF EXISTS money_audit_log_book_known;
ALTER TABLE public.money_audit_log ADD CONSTRAINT money_audit_log_book_known CHECK (book IN (
  'catalog', 'general_rules', 'tm_rates', 'cost', 'client_agreements', 'overhead'));
ALTER TABLE public.money_values DROP CONSTRAINT IF EXISTS money_values_book_check;
ALTER TABLE public.money_values DROP CONSTRAINT IF EXISTS money_values_book_known;
ALTER TABLE public.money_values ADD CONSTRAINT money_values_book_known CHECK (book IN (
  'general_rules', 'tm_rates', 'cost', 'client_agreements', 'overhead'));

-- The cost roles: administrators, finance, and job.view_costs holders. A
-- seller has none of these (20261027130000).
CREATE OR REPLACE FUNCTION public.can_see_costs(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT _user_id IS NOT NULL AND (
    public.is_privileged(_user_id)
    OR public.can_view_finance(_user_id)
    OR public.has_permission(_user_id, 'job.view_costs', NULL));
$$;
REVOKE ALL ON FUNCTION public.can_see_costs(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_see_costs(uuid) TO authenticated, service_role;

-- The overhead engine (what a field hour really costs, and why): owner and
-- admin only — not dev, not finance.
CREATE OR REPLACE FUNCTION public.can_manage_overhead(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles ur
                  WHERE ur.user_id = _user_id AND ur.role::text IN ('owner', 'admin'));
$$;
REVOKE ALL ON FUNCTION public.can_manage_overhead(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_manage_overhead(uuid) TO authenticated, service_role;

DROP POLICY IF EXISTS money_values_read ON public.money_values;
CREATE POLICY money_values_read ON public.money_values
  FOR SELECT TO authenticated
  USING (
    CASE
      WHEN book = 'overhead' THEN public.can_manage_overhead((SELECT auth.uid()))
      WHEN measure LIKE 'cost%' THEN public.can_see_costs((SELECT auth.uid()))
      ELSE true
    END
  );

DROP POLICY IF EXISTS money_audit_log_read ON public.money_audit_log;
CREATE POLICY money_audit_log_read ON public.money_audit_log
  FOR SELECT TO authenticated
  USING (
    CASE
      WHEN book = 'overhead' THEN public.can_manage_overhead((SELECT auth.uid()))
      WHEN book = 'cost' THEN public.can_see_costs((SELECT auth.uid()))
      ELSE public.is_privileged((SELECT auth.uid()))
    END
  );

-- ===================================================== 2. labor class

-- A field title's cost is the engine's; a management or office title's is
-- typed. Seeded from the Small Tools switch, which already told them apart.
ALTER TABLE public.catalog_items
  ADD COLUMN IF NOT EXISTS labor_class text;
DO $$ BEGIN
  ALTER TABLE public.catalog_items ADD CONSTRAINT catalog_items_labor_class_known
    CHECK (labor_class IS NULL OR (category = 'labor' AND labor_class IN ('field', 'management')));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
COMMENT ON COLUMN public.catalog_items.labor_class IS
  'Labor lines: field = cost computed by the overhead engine (auto-filled); management = cost typed in the Cost tab.';

UPDATE public.catalog_items c
   SET labor_class = CASE
     WHEN EXISTS (SELECT 1 FROM public.tm_rate_codes t
                   WHERE t.code = c.code AND t.small_tools = false) THEN 'management'
     ELSE 'field' END
 WHERE c.category = 'labor' AND c.labor_class IS NULL;

CREATE OR REPLACE FUNCTION public.tg_catalog_items_labor_class()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.category = 'labor' AND NEW.labor_class IS NULL THEN
    NEW.labor_class := 'field';
  ELSIF NEW.category <> 'labor' THEN
    NEW.labor_class := NULL;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_catalog_items_labor_class() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS catalog_items_labor_class ON public.catalog_items;
CREATE TRIGGER catalog_items_labor_class BEFORE INSERT OR UPDATE ON public.catalog_items
  FOR EACH ROW EXECUTE FUNCTION public.tg_catalog_items_labor_class();

-- ======================================================= 3. equipment types

ALTER TABLE public.equipment_types
  ADD COLUMN IF NOT EXISTS default_make text,
  ADD COLUMN IF NOT EXISTS default_model text,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS created_by uuid DEFAULT auth.uid();

CREATE OR REPLACE FUNCTION public.tg_equipment_types_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.money_audit_write('catalog', 'equipment_type', NEW.key, 'created', NULL,
      jsonb_build_object('label', NEW.label, 'default_make', NEW.default_make,
                         'default_model', NEW.default_model));
    RETURN NEW;
  END IF;
  IF NEW.label IS DISTINCT FROM OLD.label THEN
    PERFORM public.money_audit_write('catalog', 'equipment_type', NEW.key, 'label',
      to_jsonb(OLD.label), to_jsonb(NEW.label));
  END IF;
  IF NEW.default_make IS DISTINCT FROM OLD.default_make THEN
    PERFORM public.money_audit_write('catalog', 'equipment_type', NEW.key, 'default_make',
      to_jsonb(OLD.default_make), to_jsonb(NEW.default_make));
  END IF;
  IF NEW.default_model IS DISTINCT FROM OLD.default_model THEN
    PERFORM public.money_audit_write('catalog', 'equipment_type', NEW.key, 'default_model',
      to_jsonb(OLD.default_model), to_jsonb(NEW.default_model));
  END IF;
  IF (NEW.archived_at IS NULL) IS DISTINCT FROM (OLD.archived_at IS NULL) THEN
    PERFORM public.money_audit_write('catalog', 'equipment_type', NEW.key, 'archived',
      to_jsonb(OLD.archived_at IS NOT NULL), to_jsonb(NEW.archived_at IS NOT NULL));
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_equipment_types_audit() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS equipment_types_audit ON public.equipment_types;
CREATE TRIGGER equipment_types_audit AFTER INSERT OR UPDATE ON public.equipment_types
  FOR EACH ROW EXECUTE FUNCTION public.tg_equipment_types_audit();

/*
 * The Equipment module's "Types" admin. One call per action:
 *   add     { label, default_make?, default_model? }  → key from the label
 *   edit    { key, label?, default_make?, default_model? }
 *   archive / restore { key }
 * A new type is also added to the equipment_type enum the register column
 * uses (an enum never loses a value, which suits "archive, never delete").
 */
CREATE OR REPLACE FUNCTION public.equipment_type_save(_action text, _type jsonb, _note text DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  k text;
  lbl text := nullif(btrim(_type->>'label'), '');
BEGIN
  IF NOT public.is_privileged(auth.uid()) THEN
    RAISE EXCEPTION 'Only an administrator can change equipment types.' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('gsr.money_note', coalesce(btrim(_note), ''), true);
  IF _action = 'add' THEN
    IF lbl IS NULL THEN
      RAISE EXCEPTION 'A type needs a name.' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM public.equipment_types WHERE lower(label) = lower(lbl)) THEN
      RAISE EXCEPTION 'There is already a type called %.', lbl USING ERRCODE = '23505';
    END IF;
    k := left(btrim(regexp_replace(lower(lbl), '[^a-z0-9]+', '_', 'g'), '_'), 40);
    IF k !~ '^[a-z]' THEN k := left('t_' || k, 40); END IF;
    IF EXISTS (SELECT 1 FROM public.equipment_types WHERE key = k) THEN
      RAISE EXCEPTION 'The type key % is taken; choose another name.', k USING ERRCODE = '23505';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
                WHERE n.nspname = 'public' AND t.typname = 'equipment_type') THEN
      EXECUTE format('ALTER TYPE public.equipment_type ADD VALUE IF NOT EXISTS %L', k);
    END IF;
    INSERT INTO public.equipment_types (key, label, sort_order, default_make, default_model)
    VALUES (k, lbl,
            coalesce((SELECT max(sort_order) FROM public.equipment_types), 0) + 10,
            nullif(btrim(_type->>'default_make'), ''), nullif(btrim(_type->>'default_model'), ''));
    RETURN k;
  END IF;

  k := _type->>'key';
  IF NOT EXISTS (SELECT 1 FROM public.equipment_types WHERE key = k) THEN
    RAISE EXCEPTION 'No equipment type %.', k USING ERRCODE = 'P0002';
  END IF;
  IF _action = 'edit' THEN
    IF _type ? 'label' AND lbl IS NULL THEN
      RAISE EXCEPTION 'A type needs a name.' USING ERRCODE = '22023';
    END IF;
    IF lbl IS NOT NULL AND EXISTS (SELECT 1 FROM public.equipment_types
                                    WHERE lower(label) = lower(lbl) AND key <> k) THEN
      RAISE EXCEPTION 'There is already a type called %.', lbl USING ERRCODE = '23505';
    END IF;
    UPDATE public.equipment_types SET
      label = coalesce(lbl, label),
      default_make = CASE WHEN _type ? 'default_make'
                          THEN nullif(btrim(_type->>'default_make'), '') ELSE default_make END,
      default_model = CASE WHEN _type ? 'default_model'
                           THEN nullif(btrim(_type->>'default_model'), '') ELSE default_model END
     WHERE key = k;
  ELSIF _action = 'archive' THEN
    UPDATE public.equipment_types SET archived_at = coalesce(archived_at, now()), active = false
     WHERE key = k;
  ELSIF _action = 'restore' THEN
    UPDATE public.equipment_types SET archived_at = NULL, active = true WHERE key = k;
  ELSE
    RAISE EXCEPTION 'Unknown equipment type action %.', coalesce(_action, 'blank')
      USING ERRCODE = '22023';
  END IF;
  RETURN k;
END;
$$;
REVOKE ALL ON FUNCTION public.equipment_type_save(text, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.equipment_type_save(text, jsonb, text) TO authenticated, service_role;

-- 305/306 ("Air Scrubber - HEPA 500/700"): left flagged, with the evidence.
-- The register's `hepa` type is where big scrubbers live today — the Scrubber
-- XXL day cost was put on the `hepa` assets (20260918131000) and the HEPA type's
-- T&M rate is the Scrubber XXL catalog price (20261030120000) — so "HEPA is for
-- HEPA vacuums" does not match the register yet. The vacuum is code 329.
UPDATE public.tm_rate_codes
   SET equipment_type_review =
       'Flagged, not mapped: the register''s HEPA type holds the XXL scrubbers today '
       '(their day cost and T&M rate are Scrubber XXL), so Air scrubber vs HEPA needs a decision.'
 WHERE section = 'equipment' AND equipment_type IS NULL AND label ~* '^air scrubber - hepa';

-- ========================================================== 4. the cost seed

DO $$
DECLARE
  missing integer;
  codes integer;
  eq_types integer;
  eq_varied integer;
  eq_from_settings integer := 0;
  ticket_only integer := 0;
  day_rates jsonb;
BEGIN
  PERFORM set_config('gsr.money_note', 'Carried over from T&M rate codes (20261031120000)', true);

  INSERT INTO public.money_values (book, item_key, measure, office_id, effective_from, value, note)
  SELECT 'cost', t.code, 'cost_rate', NULL, DATE '2000-01-01', t.cost_rate,
         'Carried over from T&M rate codes'
    FROM public.tm_rate_codes t
   WHERE t.cost_rate IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.money_values v
                      WHERE v.book = 'cost' AND v.item_key = t.code
                        AND v.measure = 'cost_rate' AND v.office_id IS NULL);

  SELECT count(*) INTO missing
    FROM public.tm_rate_codes t
   WHERE t.cost_rate IS NOT NULL
     AND (SELECT r.value FROM public.resolve_money_value('cost', t.code, 'cost_rate', NULL, current_date) r)
         IS DISTINCT FROM t.cost_rate;
  IF missing > 0 THEN
    RAISE EXCEPTION 'Cost seed mismatch: % codes do not resolve to their old cost.', missing;
  END IF;
  SELECT count(*) INTO codes FROM public.tm_rate_codes WHERE cost_rate IS NOT NULL;

  -- Equipment types: the day cost most of the type's units carry.
  IF to_regclass('public.equipment') IS NOT NULL THEN
    PERFORM set_config('gsr.money_note', 'Carried over from the equipment register (20261031120000)', true);
    EXECUTE $q$
      INSERT INTO public.money_values (book, item_key, measure, office_id, effective_from, value, note)
      SELECT 'cost', 'EQ:' || m.t, 'cost_rate', NULL, DATE '2000-01-01', m.cents / 100.0,
             'Carried over from the equipment register (most units of this type)'
        FROM (
          SELECT DISTINCT ON (e.equipment_type::text) e.equipment_type::text AS t, e.daily_rate_cents AS cents
            FROM public.equipment e
           WHERE e.daily_rate_cents IS NOT NULL
           GROUP BY e.equipment_type::text, e.daily_rate_cents
           ORDER BY e.equipment_type::text, count(*) DESC, e.daily_rate_cents
        ) m
        JOIN public.equipment_types et ON et.key = m.t
       WHERE NOT EXISTS (SELECT 1 FROM public.money_values v
                          WHERE v.book = 'cost' AND v.item_key = 'EQ:' || m.t
                            AND v.measure = 'cost_rate' AND v.office_id IS NULL)
    $q$;
    EXECUTE $q$
      SELECT count(*) FROM (
        SELECT e.equipment_type::text FROM public.equipment e
         WHERE e.daily_rate_cents IS NOT NULL
         GROUP BY 1 HAVING count(DISTINCT e.daily_rate_cents) > 1) x
    $q$ INTO eq_varied;
  END IF;

  -- A type no unit is priced for: the field-ticket day card, where it names one.
  SELECT value->'day_rates' INTO day_rates FROM public.app_settings WHERE key = 'equipment_day_rates';
  IF day_rates IS NOT NULL THEN
    PERFORM set_config('gsr.money_note', 'Carried over from the field-ticket day card (20261031120000)', true);
    INSERT INTO public.money_values (book, item_key, measure, office_id, effective_from, value, note)
    SELECT 'cost', 'EQ:' || et.key, 'cost_rate', NULL, DATE '2000-01-01',
           (day_rates->>m.card_key)::numeric, 'Carried over from the field-ticket day card'
      FROM (VALUES ('air_mover', 'air_mover'), ('dehumidifier', 'dehumidifier'),
                   ('air_scrubber', 'scrubber'), ('generator', 'generator')) AS m(type_key, card_key)
      JOIN public.equipment_types et ON et.key = m.type_key
     WHERE day_rates ? m.card_key
       AND NOT EXISTS (SELECT 1 FROM public.money_values v
                        WHERE v.book = 'cost' AND v.item_key = 'EQ:' || et.key
                          AND v.measure = 'cost_rate' AND v.office_id IS NULL);
    GET DIAGNOSTICS eq_from_settings = ROW_COUNT;
    SELECT count(*) INTO ticket_only FROM jsonb_object_keys(day_rates) k
     WHERE k NOT IN ('air_mover', 'dehumidifier', 'scrubber', 'generator');
  END IF;

  SELECT count(*) INTO eq_types FROM public.money_values
   WHERE book = 'cost' AND item_key LIKE 'EQ:%' AND office_id IS NULL;
  RAISE NOTICE 'Cost seed: % code costs carried; % equipment types costed (% from the field-ticket card); % types whose units differ (units keep their own); % ticket-only classes left in equipment_day_rates.',
    codes, eq_types, eq_from_settings, coalesce(eq_varied, 0), ticket_only;
  PERFORM set_config('gsr.money_note', '', true);
END;
$$;

COMMENT ON COLUMN public.tm_rate_codes.cost_rate IS
  'LEGACY since 20261031120000: cost lives in money_values (book cost, measure cost_rate, item_key = code), office-aware and dated. Kept read-only as the seed''s source.';

-- ===================================================== 5. overhead engine

CREATE TABLE IF NOT EXISTS public.overhead_components (
  key text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  name text NOT NULL CHECK (length(btrim(name)) > 0 AND length(name) <= 80),
  note text,
  system boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 1000,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid()
);
COMMENT ON TABLE public.overhead_components IS
  'The overhead engine''s parts. Values are money_values (book overhead, measure cost_hr, item_key = key), per office or default, dated. Their sum is the true cost of a field-labor hour. Owner/admin only. See 20261031120000.';

INSERT INTO public.overhead_components (key, name, note, system, sort_order) VALUES
  ('wage', 'Wage — field crew (Gold Star)',
   'What a field-crew hour is paid. Also the field work ticket''s Gold Star crew cost and the crew role''s rate.', true, 10),
  ('general_liability', 'General liability', 'Insurance per field-labor hour.', true, 20),
  ('workers_comp', 'Workers'' comp', 'Insurance per field-labor hour.', true, 30)
ON CONFLICT (key) DO NOTHING;

ALTER TABLE public.overhead_components ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.overhead_components FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.overhead_components TO authenticated;
GRANT ALL ON public.overhead_components TO service_role;
DROP POLICY IF EXISTS overhead_components_read ON public.overhead_components;
CREATE POLICY overhead_components_read ON public.overhead_components
  FOR SELECT TO authenticated USING (public.can_manage_overhead((SELECT auth.uid())));
DROP POLICY IF EXISTS active_profile_required ON public.overhead_components;
CREATE POLICY active_profile_required ON public.overhead_components
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT goldstar_private.profile_is_active(auth.uid())))
  WITH CHECK ((SELECT goldstar_private.profile_is_active(auth.uid())));
DROP POLICY IF EXISTS anonymous_business_access_denied ON public.overhead_components;
CREATE POLICY anonymous_business_access_denied ON public.overhead_components
  AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

CREATE OR REPLACE FUNCTION public.tg_overhead_components_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.money_audit_write('overhead', 'overhead_component', NEW.key, 'created', NULL,
      jsonb_build_object('name', NEW.name, 'note', NEW.note));
    RETURN NEW;
  END IF;
  IF NEW.system AND NEW.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'A standard component is kept; publish 0 to switch it off.' USING ERRCODE = '22023';
  END IF;
  IF NEW.name IS DISTINCT FROM OLD.name THEN
    PERFORM public.money_audit_write('overhead', 'overhead_component', NEW.key, 'name',
      to_jsonb(OLD.name), to_jsonb(NEW.name));
  END IF;
  IF NEW.note IS DISTINCT FROM OLD.note THEN
    PERFORM public.money_audit_write('overhead', 'overhead_component', NEW.key, 'note',
      to_jsonb(OLD.note), to_jsonb(NEW.note));
  END IF;
  IF (NEW.archived_at IS NULL) IS DISTINCT FROM (OLD.archived_at IS NULL) THEN
    PERFORM public.money_audit_write('overhead', 'overhead_component', NEW.key, 'archived',
      to_jsonb(OLD.archived_at IS NOT NULL), to_jsonb(NEW.archived_at IS NOT NULL));
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_overhead_components_audit() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS overhead_components_audit ON public.overhead_components;
CREATE TRIGGER overhead_components_audit BEFORE INSERT OR UPDATE ON public.overhead_components
  FOR EACH ROW EXECUTE FUNCTION public.tg_overhead_components_audit();

-- The true cost of a field-labor hour at an office (NULL = default) on a day:
-- the sum of every component in use that day. A component with no value
-- counts 0 (the UI names it); one archived before the day is not counted.
CREATE OR REPLACE FUNCTION public.overhead_total(_office_id uuid, _on date)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce(sum(r.value), 0)
    FROM public.overhead_components c
    LEFT JOIN LATERAL public.resolve_money_value('overhead', c.key, 'cost_hr', _office_id, _on) r
      ON true
   WHERE c.archived_at IS NULL OR c.archived_at::date > _on;
$$;
REVOKE ALL ON FUNCTION public.overhead_total(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.overhead_total(uuid, date) TO service_role;

/*
 * The auto-fill: from _on, every field labor code costs the engine's total —
 * the company default row, and an office row wherever that office's total
 * differs (an office back in line is reset to the default). Rows already
 * saying the same thing are left alone, so a refill is quiet.
 */
CREATE OR REPLACE FUNCTION public.overhead_fill(_on date)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  dflt numeric := public.overhead_total(NULL, _on);
  code text;
  loc record;
  t numeric;
  cur record;
  n integer := 0;
BEGIN
  FOR code IN SELECT ci.code FROM public.catalog_items ci
               WHERE ci.category = 'labor' AND ci.labor_class = 'field' AND ci.archived_at IS NULL
  LOOP
    SELECT * INTO cur FROM public.resolve_money_value('cost', code, 'cost_rate', NULL, _on);
    IF cur.value IS DISTINCT FROM dflt THEN
      DELETE FROM public.money_values mv
       WHERE mv.book = 'cost' AND mv.item_key = code AND mv.measure = 'cost_rate'
         AND mv.office_id IS NULL AND mv.effective_from = _on;
      INSERT INTO public.money_values (book, item_key, measure, office_id, effective_from, value, note)
      VALUES ('cost', code, 'cost_rate', NULL, _on, dflt, 'Overhead engine');
      n := n + 1;
    END IF;
    FOR loc IN SELECT l.id FROM public.locations l LOOP
      t := public.overhead_total(loc.id, _on);
      SELECT * INTO cur FROM public.resolve_money_value('cost', code, 'cost_rate', loc.id, _on);
      IF t IS DISTINCT FROM dflt AND (cur.source IS DISTINCT FROM 'office' OR cur.value IS DISTINCT FROM t) THEN
        DELETE FROM public.money_values mv
         WHERE mv.book = 'cost' AND mv.item_key = code AND mv.measure = 'cost_rate'
           AND mv.office_id = loc.id AND mv.effective_from = _on;
        INSERT INTO public.money_values (book, item_key, measure, office_id, effective_from, value, note)
        VALUES ('cost', code, 'cost_rate', loc.id, _on, t, 'Overhead engine');
        n := n + 1;
      ELSIF t = dflt AND cur.source = 'office' THEN
        DELETE FROM public.money_values mv
         WHERE mv.book = 'cost' AND mv.item_key = code AND mv.measure = 'cost_rate'
           AND mv.office_id = loc.id AND mv.effective_from = _on;
        INSERT INTO public.money_values (book, item_key, measure, office_id, effective_from, value, note)
        VALUES ('cost', code, 'cost_rate', loc.id, _on, NULL, 'Overhead engine');
        n := n + 1;
      END IF;
    END LOOP;
  END LOOP;
  RETURN n;
END;
$$;
REVOKE ALL ON FUNCTION public.overhead_fill(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.overhead_fill(date) TO service_role;

-- Refill from a day: that day and every later day the engine changes on, so
-- a back-dated publish reaches fills made after it.
CREATE OR REPLACE FUNCTION public.overhead_refill_from(_from date)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  d date;
  n integer := 0;
BEGIN
  FOR d IN SELECT _from
           UNION
           SELECT DISTINCT mv.effective_from FROM public.money_values mv
            WHERE mv.book = 'overhead' AND mv.effective_from > _from
           ORDER BY 1
  LOOP
    n := n + public.overhead_fill(d);
  END LOOP;
  RETURN n;
END;
$$;
REVOKE ALL ON FUNCTION public.overhead_refill_from(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.overhead_refill_from(date) TO service_role;

/*
 * Publish a wage into labour_rates the way the old publisher did (close the
 * row in force the day before, never edit an old rate), for the field crew:
 * crew_class gsr and the crew role — or the temp crew box. A NULL value at an
 * office hands that office back to the company-wide rate.
 */
CREATE OR REPLACE FUNCTION public.overhead_publish_labour(
  _class text, _office_id uuid, _value numeric, _on date, _note text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  nxt date;
BEGIN
  IF _class = 'gsr' OR _class = 'temp' THEN
    DELETE FROM public.labour_rates lr
     WHERE lr.crew_class = _class AND lr.user_id IS NULL
       AND lr.location_id IS NOT DISTINCT FROM _office_id AND lr.effective_from = _on;
    UPDATE public.labour_rates lr SET effective_to = _on - 1
     WHERE lr.crew_class = _class AND lr.user_id IS NULL
       AND lr.location_id IS NOT DISTINCT FROM _office_id AND lr.effective_from < _on
       AND (lr.effective_to IS NULL OR lr.effective_to >= _on);
    SELECT min(lr.effective_from) INTO nxt FROM public.labour_rates lr
     WHERE lr.crew_class = _class AND lr.user_id IS NULL
       AND lr.location_id IS NOT DISTINCT FROM _office_id AND lr.effective_from > _on;
    IF _value IS NOT NULL THEN
      INSERT INTO public.labour_rates
        (crew_class, location_id, hourly_rate, effective_from, effective_to, note, created_by)
      VALUES (_class, _office_id, _value, _on, nxt - 1, _note, auth.uid());
    END IF;
  END IF;
  IF _class = 'gsr' THEN
    DELETE FROM public.labour_rates lr
     WHERE lr.role::text = 'crew' AND lr.crew_class IS NULL AND lr.user_id IS NULL
       AND lr.location_id IS NOT DISTINCT FROM _office_id AND lr.effective_from = _on;
    UPDATE public.labour_rates lr SET effective_to = _on - 1
     WHERE lr.role::text = 'crew' AND lr.crew_class IS NULL AND lr.user_id IS NULL
       AND lr.location_id IS NOT DISTINCT FROM _office_id AND lr.effective_from < _on
       AND (lr.effective_to IS NULL OR lr.effective_to >= _on);
    SELECT min(lr.effective_from) INTO nxt FROM public.labour_rates lr
     WHERE lr.role::text = 'crew' AND lr.crew_class IS NULL AND lr.user_id IS NULL
       AND lr.location_id IS NOT DISTINCT FROM _office_id AND lr.effective_from > _on;
    IF _value IS NOT NULL THEN
      INSERT INTO public.labour_rates
        (role, location_id, hourly_rate, effective_from, effective_to, note, created_by)
      VALUES ('crew', _office_id, _value, _on, nxt - 1, _note, auth.uid());
    END IF;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.overhead_publish_labour(text, uuid, numeric, date, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.overhead_publish_labour(text, uuid, numeric, date, text) TO service_role;

/*
 * The engine's one Save (owner/admin; a note is required). All or nothing.
 *   { op: 'value', component, office_id, value, effective_from }  value null on an office = reset
 *   { op: 'add', name, note?, value?, effective_from? }  → key c_<slug>
 *   { op: 'edit', component, name?, note? }
 *   { op: 'archive', component }  (added components only; publish 0 to switch a standard one off)
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
  eff date;
  refill date;
  nm text;
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
    eff := coalesce(nullif(c->>'effective_from', '')::date, current_date);
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
       WHERE mv.book = 'overhead' AND mv.item_key = k AND mv.measure = 'cost_hr'
         AND mv.office_id IS NOT DISTINCT FROM office AND mv.effective_from = eff;
      INSERT INTO public.money_values (book, item_key, measure, office_id, effective_from, value, note)
      VALUES ('overhead', k, 'cost_hr', office, eff, v, btrim(_note));
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
      k := left('c_' || btrim(regexp_replace(lower(nm), '[^a-z0-9]+', '_', 'g'), '_'), 40);
      IF EXISTS (SELECT 1 FROM public.overhead_components WHERE key = k) THEN
        k := left(k, 33) || '_' || substr(md5(random()::text), 1, 6);
      END IF;
      INSERT INTO public.overhead_components (key, name, note, sort_order)
      VALUES (k, nm, nullif(btrim(c->>'note'), ''),
              coalesce((SELECT max(sort_order) FROM public.overhead_components), 0) + 10);
      IF v IS NOT NULL THEN
        INSERT INTO public.money_values (book, item_key, measure, office_id, effective_from, value, note)
        VALUES ('overhead', k, 'cost_hr', NULL, eff, v, btrim(_note));
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

-- The engine's Wage, seeded from the field crew's labour_rates history (the
-- same rows the old "Cost rate — what the crew is paid" publisher wrote). A
-- row that was never in force (closed before it started — the old publisher
-- could do that when back-dating) is skipped.
DO $$
DECLARE
  o record;
  old_rate numeric;
  ours numeric;
  fixed integer := 0;
  gaps integer;
BEGIN
  IF to_regclass('public.labour_rates') IS NULL THEN RETURN; END IF;
  PERFORM set_config('gsr.money_note', 'Carried over from labor cost rates (20261031120000)', true);

  INSERT INTO public.money_values (book, item_key, measure, office_id, effective_from, value, note)
  SELECT DISTINCT ON (lr.location_id, lr.effective_from)
         'overhead', 'wage', 'cost_hr', lr.location_id, lr.effective_from, lr.hourly_rate,
         'Carried over from labor cost rates'
    FROM public.labour_rates lr
   WHERE lr.crew_class = 'gsr' AND lr.user_id IS NULL
     AND (lr.effective_to IS NULL OR lr.effective_to >= lr.effective_from)
     AND NOT EXISTS (SELECT 1 FROM public.money_values v
                      WHERE v.book = 'overhead' AND v.item_key = 'wage' AND v.measure = 'cost_hr'
                        AND v.office_id IS NOT DISTINCT FROM lr.location_id
                        AND v.effective_from = lr.effective_from)
   ORDER BY lr.location_id, lr.effective_from, lr.created_at DESC;

  -- An office rate closed with nothing after it: the office went back to
  -- the company-wide rate.
  INSERT INTO public.money_values (book, item_key, measure, office_id, effective_from, value, note)
  SELECT DISTINCT 'overhead', 'wage', 'cost_hr', lr.location_id, lr.effective_to + 1, NULL::numeric,
         'Carried over from labor cost rates (office rate ended)'
    FROM public.labour_rates lr
   WHERE lr.crew_class = 'gsr' AND lr.user_id IS NULL AND lr.location_id IS NOT NULL
     AND lr.effective_to IS NOT NULL AND lr.effective_to >= lr.effective_from
     AND NOT EXISTS (SELECT 1 FROM public.labour_rates l2
                      WHERE l2.crew_class = 'gsr' AND l2.user_id IS NULL
                        AND l2.location_id = lr.location_id
                        AND (l2.effective_to IS NULL OR l2.effective_to >= l2.effective_from)
                        AND l2.effective_from > lr.effective_from
                        AND l2.effective_from <= lr.effective_to + 1)
     AND NOT EXISTS (SELECT 1 FROM public.money_values v
                      WHERE v.book = 'overhead' AND v.item_key = 'wage' AND v.measure = 'cost_hr'
                        AND v.office_id = lr.location_id AND v.effective_from = lr.effective_to + 1);

  -- Today, at the default and every office, the engine's wage must be the
  -- rate the old resolver (crew_rate_for) answers. Where tangled history
  -- makes them differ, today's old rate is written from today — the old
  -- rate wins, and the count is reported.
  FOR o IN SELECT NULL::uuid AS id UNION ALL SELECT l.id FROM public.locations l LOOP
    SELECT lr.hourly_rate INTO old_rate FROM public.labour_rates lr
     WHERE lr.crew_class = 'gsr' AND lr.user_id IS NULL
       AND (lr.location_id = o.id OR lr.location_id IS NULL)
       AND lr.effective_from <= current_date
       AND (lr.effective_to IS NULL OR lr.effective_to >= current_date)
     ORDER BY (lr.location_id IS NULL), lr.effective_from DESC
     LIMIT 1;
    SELECT r.value INTO ours
      FROM public.resolve_money_value('overhead', 'wage', 'cost_hr', o.id, current_date) r;
    IF old_rate IS NOT NULL AND ours IS DISTINCT FROM old_rate THEN
      DELETE FROM public.money_values mv
       WHERE mv.book = 'overhead' AND mv.item_key = 'wage' AND mv.measure = 'cost_hr'
         AND mv.office_id IS NOT DISTINCT FROM o.id AND mv.effective_from = current_date;
      INSERT INTO public.money_values (book, item_key, measure, office_id, effective_from, value, note)
      VALUES ('overhead', 'wage', 'cost_hr', o.id, current_date, old_rate,
              'Carried over from labor cost rates (today''s rate)');
      fixed := fixed + 1;
    END IF;
    old_rate := NULL;
    ours := NULL;
  END LOOP;
  SELECT count(*) INTO gaps
    FROM public.labour_rates lr
   WHERE lr.crew_class = 'gsr' AND lr.user_id IS NULL AND lr.location_id IS NULL
     AND lr.effective_to IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.labour_rates l2
                      WHERE l2.crew_class = 'gsr' AND l2.user_id IS NULL AND l2.location_id IS NULL
                        AND l2.effective_from > lr.effective_from
                        AND l2.effective_from <= lr.effective_to + 1);
  RAISE NOTICE 'Wage seed: % rows carried; % scope(s) set to today''s old rate; % company-wide gap(s) carried as the earlier rate.',
    (SELECT count(*) FROM public.money_values WHERE book = 'overhead' AND item_key = 'wage'), fixed, gaps;
  PERFORM set_config('gsr.money_note', '', true);
END;
$$;

-- ======================================================== 6. the Cost save

/*
 * The Cost tab's one Save. Administrators; one note; all or nothing.
 *   { op: 'cost', item_key, office_id, value, effective_from }  value null on an office = reset
 *   { op: 'labor_class', code, class: 'field' | 'management' }
 * A field labor code's cost is the engine's, never typed. An equipment type's
 * day cost takes effect today and is also copied onto that type's units (the
 * job ledger's running cost reads units), as Cost rates' "rate by type" did.
 */
CREATE OR REPLACE FUNCTION public.cost_save(_changes jsonb, _note text DEFAULT NULL)
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
  eff date;
  dflt numeric;
  refill boolean := false;
BEGIN
  IF NOT public.is_privileged(auth.uid()) THEN
    RAISE EXCEPTION 'Only an administrator can change costs.' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(_changes) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Nothing to save.' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('gsr.money_note', coalesce(btrim(_note), ''), true);

  FOR c IN SELECT * FROM jsonb_array_elements(_changes) LOOP
    IF c->>'op' = 'cost' THEN
      k := c->>'item_key';
      office := nullif(c->>'office_id', '')::uuid;
      v := CASE WHEN jsonb_typeof(c->'value') = 'number' THEN (c->>'value')::numeric END;
      eff := coalesce(nullif(c->>'effective_from', '')::date, current_date);
      IF NOT EXISTS (SELECT 1 FROM public.tm_rate_codes WHERE code = k)
         AND NOT EXISTS (SELECT 1 FROM public.equipment_types WHERE 'EQ:' || key = k) THEN
        RAISE EXCEPTION 'No costed item %.', k USING ERRCODE = 'P0002';
      END IF;
      IF EXISTS (SELECT 1 FROM public.catalog_items
                  WHERE code = k AND category = 'labor' AND labor_class = 'field') THEN
        RAISE EXCEPTION '%: a field labor cost is computed by the overhead engine.', k
          USING ERRCODE = '42501';
      END IF;
      IF eff < current_date THEN
        RAISE EXCEPTION 'A cost can take effect today or later, not on % (%).', eff, k
          USING ERRCODE = '22023';
      END IF;
      IF k LIKE 'EQ:%' AND eff > current_date THEN
        RAISE EXCEPTION '%: an equipment day cost takes effect today (the units carry no dates).', k
          USING ERRCODE = '22023';
      END IF;
      IF v IS NULL AND office IS NULL THEN
        RAISE EXCEPTION 'The company default for % needs a cost.', k USING ERRCODE = '22023';
      END IF;
      IF v IS NOT NULL AND (v < 0 OR v <> round(v, 2)) THEN
        RAISE EXCEPTION 'Costs are dollars and cents, 0 or more (% for %).', v, k
          USING ERRCODE = '22023';
      END IF;
      DELETE FROM public.money_values mv
       WHERE mv.book = 'cost' AND mv.item_key = k AND mv.measure = 'cost_rate'
         AND mv.office_id IS NOT DISTINCT FROM office AND mv.effective_from = eff;
      INSERT INTO public.money_values (book, item_key, measure, office_id, effective_from, value, note)
      VALUES ('cost', k, 'cost_rate', office, eff, v, nullif(btrim(_note), ''));

      IF k LIKE 'EQ:%' AND to_regclass('public.equipment') IS NOT NULL THEN
        IF office IS NULL THEN
          EXECUTE $q$
            UPDATE public.equipment e SET daily_rate_cents = round($1 * 100)::integer
             WHERE e.equipment_type::text = $2
               AND (SELECT r.source FROM public.resolve_money_value('cost', 'EQ:' || $2, 'cost_rate',
                      e.location_id, current_date) r) IS DISTINCT FROM 'office'
          $q$ USING v, substr(k, 4);
        ELSE
          SELECT r.value INTO dflt FROM public.resolve_money_value('cost', k, 'cost_rate', office, current_date) r;
          EXECUTE $q$
            UPDATE public.equipment e SET daily_rate_cents = round($1 * 100)::integer
             WHERE e.equipment_type::text = $2 AND e.location_id = $3 AND $1 IS NOT NULL
          $q$ USING dflt, substr(k, 4), office;
        END IF;
      END IF;
    ELSIF c->>'op' = 'labor_class' THEN
      IF c->>'class' NOT IN ('field', 'management') THEN
        RAISE EXCEPTION 'A labor title is field or management.' USING ERRCODE = '22023';
      END IF;
      UPDATE public.catalog_items SET labor_class = c->>'class'
       WHERE code = c->>'code' AND category = 'labor' AND labor_class IS DISTINCT FROM c->>'class';
      IF FOUND AND c->>'class' = 'field' THEN refill := true; END IF;
    ELSE
      RAISE EXCEPTION 'Unknown cost change %.', coalesce(c->>'op', 'blank') USING ERRCODE = '22023';
    END IF;
    n := n + 1;
  END LOOP;
  IF refill THEN
    PERFORM public.overhead_refill_from(current_date);
  END IF;
  RETURN n;
END;
$$;
REVOKE ALL ON FUNCTION public.cost_save(jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cost_save(jsonb, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.tg_catalog_items_labor_class_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.labor_class IS DISTINCT FROM OLD.labor_class AND OLD.labor_class IS NOT NULL THEN
    PERFORM public.money_audit_write('cost', 'catalog_item', NEW.code, 'labor_class',
      to_jsonb(OLD.labor_class), to_jsonb(NEW.labor_class));
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_catalog_items_labor_class_audit() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS catalog_items_labor_class_audit ON public.catalog_items;
CREATE TRIGGER catalog_items_labor_class_audit AFTER UPDATE ON public.catalog_items
  FOR EACH ROW EXECUTE FUNCTION public.tg_catalog_items_labor_class_audit();

-- ===================================================== 7. job costing

/*
 * What each T&M code costs on one job: the job's frozen sheet, else the cost
 * store at the job's office as it stood the day the job was made. Only for a
 * caller who may see that job's costs.
 */
CREATE OR REPLACE FUNCTION public.tm_cost_rates(_job_id uuid)
RETURNS TABLE (item_key text, cost_rate numeric, source text, effective_from date)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH j AS (
    SELECT jb.id,
           coalesce(jb.billing_location_id, jb.location_id) AS office,
           jb.created_at::date AS on_day
      FROM public.jobs jb
     WHERE jb.id = _job_id
       AND public.can_view_job_costs(_job_id)
  )
  SELECT t.code,
         coalesce(jr.cost_rate, r.value),
         CASE WHEN jr.cost_rate IS NOT NULL THEN 'job'
              WHEN r.value IS NOT NULL THEN r.source
              ELSE 'none' END,
         CASE WHEN jr.cost_rate IS NULL THEN r.effective_from END
    FROM j
    CROSS JOIN public.tm_rate_codes t
    LEFT JOIN public.job_tm_rates jr ON jr.job_id = j.id AND jr.code = t.code
    LEFT JOIN LATERAL public.resolve_money_value('cost', t.code, 'cost_rate', j.office, j.on_day) r
      ON true;
$$;
REVOKE ALL ON FUNCTION public.tm_cost_rates(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tm_cost_rates(uuid) TO authenticated, service_role;

-- New jobs freeze the office's rate AND cost in force the day they are made.
CREATE OR REPLACE FUNCTION public.tg_jobs_snapshot_tm_rates()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.job_tm_rates (job_id, code, rate, cost_rate)
  SELECT NEW.id, t.code, r.value, cr.value
    FROM public.tm_rate_codes t
    LEFT JOIN LATERAL public.resolve_money_value('tm_rates', t.code, 'bill_rate',
      coalesce(NEW.billing_location_id, NEW.location_id), current_date) r ON true
    LEFT JOIN LATERAL public.resolve_money_value('cost', t.code, 'cost_rate',
      coalesce(NEW.billing_location_id, NEW.location_id), current_date) cr ON true
   WHERE t.active AND (r.value IS NOT NULL OR cr.value IS NOT NULL)
  ON CONFLICT (job_id, code) DO NOTHING;
  RETURN NEW;
END;
$$;
