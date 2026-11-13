-- Billing & Costs rebuild, prompt 2 of 5 (30 Oct 2026): General rules and
-- T&M Rates go live.
--
-- Nothing here changes what any bill comes to. Every value the T&M bill read
-- before is seeded into the new stores, the seed is checked row for row, and
-- the bill's resolution order is the old one with the new store in the old
-- store's place:
--
--   a code's rate     job_tm_rates (the job's own sheet, frozen at creation)
--                     → money_values: the job's office override, else the
--                       company default, as in force on the job's creation
--                       date (job office = billing_location_id, else
--                       location_id)
--   an equipment type a customer / branch / state price list, when one prices
--                     it (unchanged until Client Agreements, prompt 4)
--                     → money_values 'EQ:<type>' (seeded from the default
--                       catalog price the bill used to fall back to)
--                     → the built-in workbook constant (unchanged)
--   the rules         billing_general_rules + billing_charges (seeded from
--                     app_settings 'tm.bill_rules' and the GEN- code rates)
--                     → the job's override (job_tm_settings, unchanged)
--
-- 1. Catalog: gal and sqft units for General Consumables (the flagged
--    per-gallon / square-foot lines take them), and the "How it bills" note.
-- 2. T&M rates in money_values (book tm_rates, measure bill_rate), the save
--    RPC, the bill's resolver tm_bill_rates(), and new jobs snapshotting the
--    office-resolved rate.
-- 3. Equipment types as a table (the Equipment module's eight), the 47 T&M
--    equipment codes mapped onto them where the description is unambiguous —
--    the rest flagged, never guessed.
-- 4. General rules: one typed row of time rules, a table of charges (the five
--    standard ones plus any added), and the save RPC. Tax is carried over
--    untouched into legacy columns the screen never shows.
--
-- Re-runnable throughout.

-- ============================================================ 1. catalog

ALTER TABLE public.catalog_items DROP CONSTRAINT IF EXISTS catalog_items_unit_check;
ALTER TABLE public.catalog_items ADD CONSTRAINT catalog_items_unit_check
  CHECK (unit IN ('hr', 'day', 'piece', 'roll', 'box', 'pair', 'gal', 'sqft'));
ALTER TABLE public.catalog_items DROP CONSTRAINT IF EXISTS catalog_items_unit_fits_category;
ALTER TABLE public.catalog_items ADD CONSTRAINT catalog_items_unit_fits_category CHECK (
  unit IS NULL
  OR (category = 'labor' AND unit IN ('hr', 'day'))
  OR (category = 'consumable' AND unit IN ('piece', 'roll', 'box', 'pair', 'gal', 'sqft'))
  OR (category = 'ppe' AND unit IN ('piece', 'box', 'pair', 'day'))
  OR (category = 'vehicle' AND unit IN ('day', 'hr'))
);

ALTER TABLE public.catalog_items ADD COLUMN IF NOT EXISTS note text
  CHECK (note IS NULL OR length(note) <= 500);
COMMENT ON COLUMN public.catalog_items.note IS
  'How the item bills, in words ("Billed per roll"). Shown as the item''s description/tooltip. Mirrored with tm_rate_codes.unit_note.';
GRANT UPDATE (note) ON public.catalog_items TO authenticated;

-- The unit rule learns the two new units, so a code added on the old page
-- later lands with them too.
CREATE OR REPLACE FUNCTION public.catalog_unit_from_label(
  _category text, _label text, _note text, _old_unit text)
RETURNS TABLE (unit text, unit_review text)
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  t text := lower(coalesce(_label, '') || ' ' || coalesce(_note, ''));
  said text;
  allowed text[] := CASE _category
    WHEN 'labor' THEN ARRAY['hr', 'day']
    WHEN 'consumable' THEN ARRAY['piece', 'roll', 'box', 'pair', 'gal', 'sqft']
    WHEN 'ppe' THEN ARRAY['piece', 'box', 'pair', 'day']
    WHEN 'vehicle' THEN ARRAY['day', 'hr']
    ELSE ARRAY[]::text[] END;
BEGIN
  IF _category = 'labor' THEN
    IF _old_unit IN ('hr', 'day') THEN
      RETURN QUERY SELECT _old_unit, NULL::text;
    ELSE
      RETURN QUERY SELECT NULL::text,
        format('The old book had no hourly or daily unit for this labor line (%s). Choose hr or day.',
               coalesce(_old_unit, 'blank'));
    END IF;
    RETURN;
  END IF;

  said := CASE
    WHEN t ~ '\m(gal|gals|gallon|gallons)\M' THEN 'gal'
    WHEN t ~ '\msq\.? ?ft\M|\msquare f(ee|oo)t\M' THEN 'sqft'
    WHEN t ~ '\mper (hr|hour)\M' THEN 'hr'
    WHEN t ~ '\mper (day|24 hour)' THEN 'day'
    WHEN t ~ '\mper pair\M' THEN 'pair'
    WHEN t ~ '\mper box\M|\mbox of\M' THEN 'box'
    WHEN t ~ '\mper roll\M|\mroll\M' THEN 'roll'
    WHEN t ~ '\(each\)|- each\M|\mper (board|string|section|piece)\M' THEN 'piece'
    ELSE NULL END;

  IF said IS NOT NULL AND said = ANY (allowed) THEN
    RETURN QUERY SELECT said, NULL::text;
    RETURN;
  END IF;
  IF said IS NOT NULL THEN
    RETURN QUERY SELECT NULL::text,
      format('The description says per %s, which does not fit this category. Choose a unit.', said);
    RETURN;
  END IF;

  IF _old_unit = 'each' AND 'piece' = ANY (allowed) THEN
    RETURN QUERY SELECT 'piece'::text,
      'Carried over from the T&M sheet''s "each". Confirm piece, or choose roll, box or pair.'::text;
  ELSIF _old_unit IN ('hr', 'day') AND _old_unit = ANY (allowed) THEN
    RETURN QUERY SELECT _old_unit,
      format('Carried over from the T&M sheet''s section default (per %s). Confirm it.', _old_unit);
  ELSE
    RETURN QUERY SELECT NULL::text,
      format('The old book''s unit (%s) does not fit this category. Choose a unit.',
             coalesce(_old_unit, 'blank'));
  END IF;
END;
$$;

-- The per-gallon and square-foot lines flagged in prompt 1 take their unit.
DO $$
DECLARE n integer;
BEGIN
  PERFORM set_config('gsr.money_note', 'gal and sqft units added (20261030120000)', true);
  UPDATE public.catalog_items
     SET unit = 'gal', unit_review = NULL
   WHERE category = 'consumable' AND unit IS NULL
     AND unit_review LIKE 'The description says per gallon%';
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'Catalog: % per-gallon items set to gal', n;
  UPDATE public.catalog_items
     SET unit = 'sqft', unit_review = NULL
   WHERE category = 'consumable' AND unit IS NULL
     AND unit_review LIKE 'The description says per square foot%';
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'Catalog: % square-foot items set to sqft', n;
  PERFORM set_config('gsr.money_note', '', true);
END;
$$;

-- The note: seeded from the old book's "How it bills", then kept in step.
DO $$
BEGIN
  PERFORM set_config('gsr.catalog_mirror', 'on', true);
  UPDATE public.catalog_items c
     SET note = btrim(t.unit_note)
    FROM public.tm_rate_codes t
   WHERE t.code = c.code AND c.note IS NULL AND nullif(btrim(t.unit_note), '') IS NOT NULL;
  PERFORM set_config('gsr.catalog_mirror', 'off', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.tg_catalog_items_to_tm()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  live boolean := NEW.active AND NEW.archived_at IS NULL;
  other_section text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT t.section INTO other_section FROM public.tm_rate_codes t WHERE t.code = NEW.code;
    IF other_section IS NOT NULL AND other_section <> NEW.category THEN
      RAISE EXCEPTION '% is already a T&M rate code in another section (%).', NEW.code, other_section
        USING ERRCODE = '23505';
    END IF;
    PERFORM set_config('gsr.catalog_to_tm', 'on', true);
    INSERT INTO public.tm_rate_codes (code, label, section, sort_order, active, unit, unit_note)
    VALUES (NEW.code, NEW.name, NEW.category, NEW.sort_order, live,
            CASE WHEN NEW.unit IN ('hr', 'day') THEN NEW.unit
                 WHEN NEW.unit IS NOT NULL THEN 'each'
                 WHEN NEW.category = 'labor' THEN 'hr'
                 WHEN NEW.category = 'vehicle' THEN 'day'
                 ELSE 'each' END,
            NEW.note)
    ON CONFLICT (code) DO NOTHING;
    PERFORM set_config('gsr.catalog_to_tm', 'off', true);
    RETURN NEW;
  END IF;

  IF NEW.name IS DISTINCT FROM OLD.name
     OR NEW.note IS DISTINCT FROM OLD.note
     OR live IS DISTINCT FROM (OLD.active AND OLD.archived_at IS NULL) THEN
    PERFORM set_config('gsr.catalog_to_tm', 'on', true);
    UPDATE public.tm_rate_codes t
       SET label = NEW.name, active = live, unit_note = NEW.note
     WHERE t.code = NEW.code
       AND (t.label IS DISTINCT FROM NEW.name OR t.active IS DISTINCT FROM live
            OR t.unit_note IS DISTINCT FROM NEW.note);
    PERFORM set_config('gsr.catalog_to_tm', 'off', true);
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.tg_tm_rate_codes_to_catalog()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.section NOT IN ('labor', 'consumable', 'ppe', 'vehicle') THEN
    RETURN NEW;
  END IF;
  IF coalesce(current_setting('gsr.catalog_to_tm', true), '') = 'on' THEN
    RETURN NEW;
  END IF;
  PERFORM set_config('gsr.catalog_mirror', 'on', true);
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.catalog_items
      (code, name, category, unit, unit_review, active, sort_order, source_book, source_key, note)
    SELECT NEW.code, btrim(NEW.label), NEW.section, u.unit, u.unit_review, NEW.active,
           NEW.sort_order, 'tm_rate_codes', NEW.code, nullif(btrim(NEW.unit_note), '')
      FROM public.catalog_unit_from_label(NEW.section, NEW.label, NEW.unit_note, NEW.unit) u
    ON CONFLICT (code) DO NOTHING;
  ELSIF NEW.label IS DISTINCT FROM OLD.label OR NEW.active IS DISTINCT FROM OLD.active
        OR NEW.unit_note IS DISTINCT FROM OLD.unit_note THEN
    UPDATE public.catalog_items c
       SET name = btrim(NEW.label),
           note = nullif(btrim(NEW.unit_note), ''),
           active = CASE WHEN NEW.active IS DISTINCT FROM OLD.active THEN NEW.active
                         ELSE c.active END,
           archived_at = CASE WHEN NEW.active AND NOT OLD.active THEN NULL ELSE c.archived_at END
     WHERE c.code = NEW.code
       AND (c.name IS DISTINCT FROM btrim(NEW.label)
            OR c.note IS DISTINCT FROM nullif(btrim(NEW.unit_note), '')
            OR (NEW.active IS DISTINCT FROM OLD.active
                AND (c.active IS DISTINCT FROM NEW.active
                     OR (NEW.active AND c.archived_at IS NOT NULL))));
  END IF;
  PERFORM set_config('gsr.catalog_mirror', 'off', true);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.tg_catalog_items_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  via_old_page boolean := coalesce(current_setting('gsr.catalog_mirror', true), '') = 'on';
  note text := CASE WHEN via_old_page AND nullif(current_setting('gsr.money_note', true), '') IS NULL
                    THEN 'Changed on the T&M rate codes page' END;
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.money_audit_write('catalog', 'catalog_item', NEW.code, 'created', NULL,
      jsonb_build_object('name', NEW.name, 'category', NEW.category, 'unit', NEW.unit,
                         'active', NEW.active), NULL, note);
    RETURN NEW;
  END IF;
  IF NEW.name IS DISTINCT FROM OLD.name THEN
    PERFORM public.money_audit_write('catalog', 'catalog_item', NEW.code, 'name',
      to_jsonb(OLD.name), to_jsonb(NEW.name), NULL, note);
  END IF;
  IF NEW.unit IS DISTINCT FROM OLD.unit THEN
    PERFORM public.money_audit_write('catalog', 'catalog_item', NEW.code, 'unit',
      to_jsonb(OLD.unit), to_jsonb(NEW.unit), NULL, note);
  END IF;
  IF (NEW.unit_review IS NULL) IS DISTINCT FROM (OLD.unit_review IS NULL) THEN
    PERFORM public.money_audit_write('catalog', 'catalog_item', NEW.code, 'unit_confirmed',
      to_jsonb(OLD.unit_review IS NULL), to_jsonb(NEW.unit_review IS NULL), NULL, note);
  END IF;
  IF NEW.note IS DISTINCT FROM OLD.note THEN
    PERFORM public.money_audit_write('catalog', 'catalog_item', NEW.code, 'note',
      to_jsonb(OLD.note), to_jsonb(NEW.note), NULL, note);
  END IF;
  IF NEW.active IS DISTINCT FROM OLD.active THEN
    PERFORM public.money_audit_write('catalog', 'catalog_item', NEW.code, 'active',
      to_jsonb(OLD.active), to_jsonb(NEW.active), NULL, note);
  END IF;
  IF (NEW.archived_at IS NULL) IS DISTINCT FROM (OLD.archived_at IS NULL) THEN
    PERFORM public.money_audit_write('catalog', 'catalog_item', NEW.code, 'archived',
      to_jsonb(OLD.archived_at IS NOT NULL), to_jsonb(NEW.archived_at IS NOT NULL), NULL, note);
  END IF;
  RETURN NEW;
END;
$$;

-- catalog_save learns the note (an update may carry "note": text | null).
CREATE OR REPLACE FUNCTION public.catalog_save(_changes jsonb, _note text DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  c jsonb;
  n integer := 0;
  found_code text;
  next_sort integer;
BEGIN
  IF NOT public.is_privileged(auth.uid()) THEN
    RAISE EXCEPTION 'Only an administrator can change the catalog.' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(_changes) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Nothing to save.' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('gsr.money_note', coalesce(btrim(_note), ''), true);
  PERFORM set_config('gsr.catalog_mirror', 'off', true);

  FOR c IN SELECT * FROM jsonb_array_elements(_changes) LOOP
    IF c->>'op' = 'create' THEN
      SELECT coalesce(max(sort_order), 0) + 10 INTO next_sort
        FROM public.catalog_items WHERE category = c->>'category';
      INSERT INTO public.catalog_items (code, name, category, unit, sort_order, note)
      VALUES (upper(btrim(c->>'code')), c->>'name', c->>'category', nullif(c->>'unit', ''),
              next_sort, nullif(btrim(c->>'note'), ''));
    ELSIF c->>'op' = 'update' THEN
      UPDATE public.catalog_items i
         SET name = CASE WHEN c ? 'name' THEN c->>'name' ELSE i.name END,
             note = CASE WHEN c ? 'note' THEN nullif(btrim(c->>'note'), '') ELSE i.note END,
             unit = CASE WHEN c ? 'unit' THEN nullif(c->>'unit', '') ELSE i.unit END,
             unit_review = CASE WHEN c ? 'unit' AND nullif(c->>'unit', '') IS NOT NULL
                                THEN NULL ELSE i.unit_review END,
             active = CASE WHEN c ? 'active' THEN (c->>'active')::boolean ELSE i.active END,
             archived_at = CASE
               WHEN NOT (c ? 'archived') THEN i.archived_at
               WHEN (c->>'archived')::boolean THEN coalesce(i.archived_at, now())
               ELSE NULL END
       WHERE i.code = c->>'code'
      RETURNING i.code INTO found_code;
      IF found_code IS NULL THEN
        RAISE EXCEPTION 'No catalog item %.', c->>'code' USING ERRCODE = 'P0002';
      END IF;
      found_code := NULL;
    ELSE
      RAISE EXCEPTION 'Unknown catalog change %.', coalesce(c->>'op', 'blank') USING ERRCODE = '22023';
    END IF;
    n := n + 1;
  END LOOP;
  RETURN n;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_save(jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.catalog_save(jsonb, text) TO authenticated, service_role;

-- ================================================= 3. equipment types

CREATE TABLE IF NOT EXISTS public.equipment_types (
  key text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  label text NOT NULL CHECK (length(btrim(label)) > 0),
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 1000,
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.equipment_types IS
  'The Equipment module''s types (src/lib/equipment.ts EQUIPMENT_TYPES), as rows so money can hang off them: their T&M rate is money_values item EQ:<key>. See 20261030120000.';

INSERT INTO public.equipment_types (key, label, sort_order) VALUES
  ('air_mover', 'Air mover', 10),
  ('dehumidifier', 'Dehumidifier', 20),
  ('air_scrubber', 'Air scrubber', 30),
  ('hepa', 'HEPA', 40),
  ('heater', 'Heater', 50),
  ('generator', 'Generator', 60),
  ('moisture_meter', 'Moisture meter', 70),
  ('other', 'Other', 80)
ON CONFLICT (key) DO NOTHING;

ALTER TABLE public.equipment_types ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.equipment_types FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.equipment_types TO authenticated;
GRANT ALL ON public.equipment_types TO service_role;
DROP POLICY IF EXISTS equipment_types_read ON public.equipment_types;
CREATE POLICY equipment_types_read ON public.equipment_types
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS active_profile_required ON public.equipment_types;
CREATE POLICY active_profile_required ON public.equipment_types
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT goldstar_private.profile_is_active(auth.uid())))
  WITH CHECK ((SELECT goldstar_private.profile_is_active(auth.uid())));
DROP POLICY IF EXISTS anonymous_business_access_denied ON public.equipment_types;
CREATE POLICY anonymous_business_access_denied ON public.equipment_types
  AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

-- The T&M sheet's equipment codes, mapped onto a type where the words leave
-- no doubt. Each code keeps its own rate (a 70-pint and a 160-pint
-- dehumidifier bill differently on the Daily Supply List); the mapping only
-- says which module type it is.
ALTER TABLE public.tm_rate_codes
  ADD COLUMN IF NOT EXISTS equipment_type text REFERENCES public.equipment_types(key),
  ADD COLUMN IF NOT EXISTS equipment_type_review text;

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT code, label FROM public.tm_rate_codes
            WHERE section = 'equipment' AND equipment_type IS NULL AND equipment_type_review IS NULL
  LOOP
    UPDATE public.tm_rate_codes SET
      equipment_type = CASE
        WHEN r.label ~* '^(air mover|axial fan air mover)' THEN 'air_mover'
        WHEN r.label ~* '^dehumidifier' THEN 'dehumidifier'
        WHEN r.label ~* '^air scrubber - [0-9]' THEN 'air_scrubber'
        WHEN r.label ~* '^generator - ' THEN 'generator'
        END,
      equipment_type_review = CASE
        WHEN r.label ~* '^(air mover|axial fan air mover|dehumidifier|air scrubber - [0-9]|generator - )'
          THEN NULL
        WHEN r.label ~* '^air scrubber - hepa'
          THEN 'A HEPA air scrubber: the Air scrubber type or the HEPA type?'
        ELSE 'No matching type in the Equipment module.'
        END
     WHERE code = r.code;
  END LOOP;
  RAISE NOTICE 'Equipment codes: % mapped to a type, % flagged',
    (SELECT count(*) FROM public.tm_rate_codes WHERE section = 'equipment' AND equipment_type IS NOT NULL),
    (SELECT count(*) FROM public.tm_rate_codes WHERE section = 'equipment' AND equipment_type_review IS NOT NULL);
END;
$$;

-- tm_rate_codes reads column by column (cost_rate is withheld); add the new two.
GRANT SELECT (code, label, section, unit_note, sort_order, active, created_at, updated_at,
              updated_by, rate, unit, small_tools, equipment_type, equipment_type_review)
  ON public.tm_rate_codes TO authenticated;

-- ======================================================= 2. T&M rates

-- A charge rate is readable by every active staff member (an estimator who
-- cannot read the rate cannot write the bill); a cost measure stays with
-- finance, cost viewers and administrators.
DROP POLICY IF EXISTS money_values_read ON public.money_values;
CREATE POLICY money_values_read ON public.money_values
  FOR SELECT TO authenticated
  USING (
    measure NOT LIKE 'cost%'
    OR public.is_privileged((SELECT auth.uid()))
    OR public.can_view_finance((SELECT auth.uid()))
    OR public.has_permission((SELECT auth.uid()), 'job.view_costs', NULL)
  );

-- History is never removed. A row that has not taken effect yet (today's or
-- a future one) may be withdrawn by the save RPC, which replaces it; the
-- withdrawal is audited.
CREATE OR REPLACE FUNCTION public.tg_money_values_no_past_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF OLD.effective_from < current_date THEN
    RAISE EXCEPTION 'A money value already in force is history and cannot be removed; add a new dated value instead.'
      USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_money_values_no_past_delete() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS money_values_no_past_delete ON public.money_values;
CREATE TRIGGER money_values_no_past_delete BEFORE DELETE ON public.money_values
  FOR EACH ROW EXECUTE FUNCTION public.tg_money_values_no_past_delete();

CREATE OR REPLACE FUNCTION public.tg_money_values_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.money_audit_write(OLD.book, 'money_value', OLD.item_key, OLD.measure,
      jsonb_build_object('value', OLD.value, 'effective_from', OLD.effective_from),
      NULL, OLD.office_id);
    RETURN OLD;
  END IF;
  PERFORM public.money_audit_write(NEW.book, 'money_value', NEW.item_key, NEW.measure,
    NULL,
    jsonb_build_object('value', NEW.value, 'effective_from', NEW.effective_from),
    NEW.office_id, NEW.note);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS money_values_audit ON public.money_values;
CREATE TRIGGER money_values_audit AFTER INSERT OR DELETE ON public.money_values
  FOR EACH ROW EXECUTE FUNCTION public.tg_money_values_audit();

-- ---------------------------------------------------- the seed + check

DO $$
DECLARE
  missing integer;
  eq_seeded integer;
BEGIN
  PERFORM set_config('gsr.money_note', 'Carried over from T&M rate codes (20261030120000)', true);

  INSERT INTO public.money_values (book, item_key, measure, office_id, effective_from, value, note)
  SELECT 'tm_rates', t.code, 'bill_rate', NULL, DATE '2000-01-01', t.rate,
         'Carried over from T&M rate codes'
    FROM public.tm_rate_codes t
   WHERE t.rate IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.money_values v
                      WHERE v.book = 'tm_rates' AND v.item_key = t.code
                        AND v.measure = 'bill_rate' AND v.office_id IS NULL);

  -- Every priced code resolves, today and on the oldest day, to exactly its old rate.
  SELECT count(*) INTO missing
    FROM public.tm_rate_codes t
   WHERE t.rate IS NOT NULL
     AND (SELECT r.value FROM public.resolve_money_value('tm_rates', t.code, 'bill_rate', NULL, current_date) r)
         IS DISTINCT FROM t.rate;
  IF missing > 0 THEN
    RAISE EXCEPTION 'T&M rate seed mismatch: % codes do not resolve to their old rate.', missing;
  END IF;

  -- Equipment types: the default catalog price the bill fell back to.
  INSERT INTO public.money_values (book, item_key, measure, office_id, effective_from, value, note)
  SELECT 'tm_rates', 'EQ:' || m.type_key, 'bill_rate', NULL, DATE '2000-01-01',
         ci.default_unit_price, 'Carried over from the default catalog price (' || ci.code || ')'
    FROM (VALUES ('air_mover', 'GSC-EQ-AIR-MOVER'), ('dehumidifier', 'GSC-EQ-DEHUMIDIFIER'),
                 ('air_scrubber', 'GSC-EQ-SCRUBBER-XL'), ('hepa', 'GSC-EQ-SCRUBBER-XXL'),
                 ('generator', 'GSC-EQ-GENERATOR')) AS m(type_key, catalog_code)
    JOIN public.estimate_catalog_items ci
      ON lower(btrim(ci.code)) = lower(m.catalog_code) AND ci.is_active
   WHERE ci.default_unit_price IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.money_values v
                      WHERE v.book = 'tm_rates' AND v.item_key = 'EQ:' || m.type_key
                        AND v.measure = 'bill_rate' AND v.office_id IS NULL);
  SELECT count(*) INTO eq_seeded FROM public.money_values
   WHERE book = 'tm_rates' AND item_key LIKE 'EQ:%' AND office_id IS NULL;

  RAISE NOTICE 'T&M rate seed check passed: % priced codes, % equipment types priced.',
    (SELECT count(*) FROM public.tm_rate_codes WHERE rate IS NOT NULL), eq_seeded;
  PERFORM set_config('gsr.money_note', '', true);
END;
$$;

-- tm_rate_codes.rate is now history: kept, never written again by the app.
COMMENT ON COLUMN public.tm_rate_codes.rate IS
  'LEGACY since 20261030120000: the T&M rate lives in money_values (book tm_rates, measure bill_rate, item_key = code), office-aware and dated. Kept read-only as the seed''s source.';

/*
 * What each T&M code and equipment type bills at on one job: the job's own
 * rate sheet, else the office-aware store as it stood on the job's creation
 * date at the job's office. The one place the bill's rates are resolved.
 */
CREATE OR REPLACE FUNCTION public.tm_bill_rates(_job_id uuid)
RETURNS TABLE (item_key text, rate numeric, source text, effective_from date)
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
       AND public.can_view_job(auth.uid(), _job_id)
  ), keys AS (
    SELECT t.code AS item_key FROM public.tm_rate_codes t
    UNION ALL
    SELECT 'EQ:' || e.key FROM public.equipment_types e
  )
  SELECT k.item_key,
         coalesce(jr.rate, r.value),
         CASE WHEN jr.rate IS NOT NULL THEN 'job'
              WHEN r.value IS NOT NULL THEN r.source
              ELSE 'none' END,
         CASE WHEN jr.rate IS NULL THEN r.effective_from END
    FROM j
    CROSS JOIN keys k
    LEFT JOIN public.job_tm_rates jr ON jr.job_id = j.id AND jr.code = k.item_key
    LEFT JOIN LATERAL public.resolve_money_value('tm_rates', k.item_key, 'bill_rate', j.office, j.on_day) r
      ON true;
$$;
REVOKE ALL ON FUNCTION public.tm_bill_rates(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tm_bill_rates(uuid) TO authenticated, service_role;

-- New jobs freeze the rate in force at their office the day they are made.
CREATE OR REPLACE FUNCTION public.tg_jobs_snapshot_tm_rates()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.job_tm_rates (job_id, code, rate, cost_rate)
  SELECT NEW.id, t.code, r.value, t.cost_rate
    FROM public.tm_rate_codes t
    LEFT JOIN LATERAL public.resolve_money_value('tm_rates', t.code, 'bill_rate',
      coalesce(NEW.billing_location_id, NEW.location_id), current_date) r ON true
   WHERE t.active AND (r.value IS NOT NULL OR t.cost_rate IS NOT NULL)
  ON CONFLICT (job_id, code) DO NOTHING;
  RETURN NEW;
END;
$$;

/*
 * The T&M Rates tab's one Save. Every change in one transaction under one
 * note; any refusal rolls the whole save back.
 *   { "op": "rate", "item_key", "office_id": uuid|null, "value": number|null,
 *     "effective_from": "YYYY-MM-DD" }   value null on an office = back to default
 *   { "op": "small_tools", "code", "on": boolean }
 * A rate takes effect from today or a later day, never an earlier one. A
 * second change to the same cell on the same day replaces the first.
 */
CREATE OR REPLACE FUNCTION public.tm_rates_save(_changes jsonb, _note text DEFAULT NULL)
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
BEGIN
  IF NOT public.is_privileged(auth.uid()) THEN
    RAISE EXCEPTION 'Only an administrator can change T&M rates.' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(_changes) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Nothing to save.' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('gsr.money_note', coalesce(btrim(_note), ''), true);

  FOR c IN SELECT * FROM jsonb_array_elements(_changes) LOOP
    IF c->>'op' = 'rate' THEN
      k := c->>'item_key';
      office := nullif(c->>'office_id', '')::uuid;
      v := CASE WHEN jsonb_typeof(c->'value') = 'number' THEN (c->>'value')::numeric END;
      eff := coalesce(nullif(c->>'effective_from', '')::date, current_date);
      IF NOT EXISTS (SELECT 1 FROM public.tm_rate_codes WHERE code = k)
         AND NOT EXISTS (SELECT 1 FROM public.equipment_types WHERE 'EQ:' || key = k) THEN
        RAISE EXCEPTION 'No T&M item %.', k USING ERRCODE = 'P0002';
      END IF;
      IF eff < current_date THEN
        RAISE EXCEPTION 'A rate can take effect today or later, not on % (%).', eff, k
          USING ERRCODE = '22023';
      END IF;
      IF v IS NULL AND office IS NULL THEN
        RAISE EXCEPTION 'The company default for % needs a rate.', k USING ERRCODE = '22023';
      END IF;
      IF v IS NOT NULL AND (v < 0 OR v <> round(v, 2)) THEN
        RAISE EXCEPTION 'Rates are dollars and cents, 0 or more (% for %).', v, k
          USING ERRCODE = '22023';
      END IF;
      DELETE FROM public.money_values mv
       WHERE mv.book = 'tm_rates' AND mv.item_key = k AND mv.measure = 'bill_rate'
         AND mv.office_id IS NOT DISTINCT FROM office AND mv.effective_from = eff;
      INSERT INTO public.money_values (book, item_key, measure, office_id, effective_from, value, note)
      VALUES ('tm_rates', k, 'bill_rate', office, eff, v, nullif(btrim(_note), ''));
    ELSIF c->>'op' = 'small_tools' THEN
      UPDATE public.tm_rate_codes SET small_tools = (c->>'on')::boolean
       WHERE code = c->>'code' AND section = 'labor';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'No labor code %.', c->>'code' USING ERRCODE = 'P0002';
      END IF;
    ELSE
      RAISE EXCEPTION 'Unknown T&M rate change %.', coalesce(c->>'op', 'blank') USING ERRCODE = '22023';
    END IF;
    n := n + 1;
  END LOOP;
  RETURN n;
END;
$$;
REVOKE ALL ON FUNCTION public.tm_rates_save(jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tm_rates_save(jsonb, text) TO authenticated, service_role;

-- The tm_rates audit trigger writes rows without the note; carry it.
CREATE OR REPLACE FUNCTION public.tg_tm_rate_codes_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.rate IS NOT NULL OR NEW.cost_rate IS NOT NULL THEN
      PERFORM public.money_audit_write('tm_rates', 'tm_rate_code', NEW.code, 'created', NULL,
        jsonb_build_object('rate', NEW.rate, 'cost_rate', NEW.cost_rate, 'unit', NEW.unit));
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.rate IS DISTINCT FROM OLD.rate THEN
    PERFORM public.money_audit_write('tm_rates', 'tm_rate_code', NEW.code, 'rate',
      to_jsonb(OLD.rate), to_jsonb(NEW.rate));
  END IF;
  IF NEW.cost_rate IS DISTINCT FROM OLD.cost_rate THEN
    PERFORM public.money_audit_write('cost', 'tm_rate_code', NEW.code, 'cost_rate',
      to_jsonb(OLD.cost_rate), to_jsonb(NEW.cost_rate));
  END IF;
  IF NEW.unit IS DISTINCT FROM OLD.unit THEN
    PERFORM public.money_audit_write('tm_rates', 'tm_rate_code', NEW.code, 'unit',
      to_jsonb(OLD.unit), to_jsonb(NEW.unit));
  END IF;
  IF NEW.small_tools IS DISTINCT FROM OLD.small_tools THEN
    PERFORM public.money_audit_write('general_rules', 'tm_rate_code', NEW.code, 'small_tools',
      to_jsonb(OLD.small_tools), to_jsonb(NEW.small_tools));
  END IF;
  RETURN NEW;
END;
$$;

-- ===================================================== 4. General rules

CREATE TABLE IF NOT EXISTS public.billing_general_rules (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  standard_start text NOT NULL DEFAULT '' CHECK (standard_start ~ '^(|([01][0-9]|2[0-3]):[0-5][0-9])$'),
  standard_end text NOT NULL DEFAULT '' CHECK (standard_end ~ '^(|([01][0-9]|2[0-3]):[0-5][0-9])$'),
  -- daily: after N h/day · after_hours: outside the standard hours · weekly:
  -- after N h/week · none. legacy_both: carried from a Settings that had both
  -- a daily threshold and a window (the old rule applied both); the screen
  -- asks for one.
  overtime_mode text NOT NULL DEFAULT 'none'
    CHECK (overtime_mode IN ('daily', 'after_hours', 'weekly', 'none', 'legacy_both')),
  daily_ot_after_hours numeric(5,2) CHECK (daily_ot_after_hours IS NULL OR daily_ot_after_hours BETWEEN 0 AND 24),
  weekly_ot_after_hours numeric(6,2) NOT NULL DEFAULT 40
    CHECK (weekly_ot_after_hours > 0 AND weekly_ot_after_hours <= 168),
  weekend_days smallint[] NOT NULL DEFAULT '{0,6}'
    CHECK (weekend_days <@ ARRAY[0,1,2,3,4,5,6]::smallint[]),
  holidays date[] NOT NULL DEFAULT '{}',
  ot_multiplier numeric(4,2) NOT NULL DEFAULT 1.5 CHECK (ot_multiplier BETWEEN 1 AND 5),
  after_hours_multiplier numeric(4,2) NOT NULL DEFAULT 1.5 CHECK (after_hours_multiplier BETWEEN 1 AND 5),
  weekend_multiplier numeric(4,2) NOT NULL DEFAULT 1.5 CHECK (weekend_multiplier BETWEEN 1 AND 5),
  holiday_multiplier numeric(4,2) NOT NULL DEFAULT 2 CHECK (holiday_multiplier BETWEEN 1 AND 5),
  field_form_code text CHECK (field_form_code IS NULL OR field_form_code ~ '^[A-Z0-9][A-Z0-9-]{0,23}$'),
  -- Tax is out of this rebuild. Whatever Settings held is carried here,
  -- unchanged and never shown, so no bill's tax moves.
  legacy_tax_percent numeric(6,3),
  legacy_taxable_categories text[],
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid DEFAULT auth.uid(),
  CONSTRAINT billing_general_rules_daily_needs_hours
    CHECK (overtime_mode NOT IN ('daily', 'legacy_both') OR daily_ot_after_hours IS NOT NULL),
  CONSTRAINT billing_general_rules_after_hours_needs_window
    CHECK (overtime_mode NOT IN ('after_hours', 'legacy_both')
           OR (standard_start <> '' AND standard_end <> '' AND standard_end > standard_start))
);
COMMENT ON TABLE public.billing_general_rules IS
  'Billing & Costs › General rules: the time rules (one row). Seeded from app_settings tm.bill_rules; a job''s override (job_tm_settings) still wins key by key. See 20261030120000.';

CREATE TABLE IF NOT EXISTS public.billing_charges (
  key text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  name text NOT NULL CHECK (length(btrim(name)) > 0 AND length(name) <= 80),
  kind text NOT NULL CHECK (kind IN ('pct_labor', 'pct_subtotal', 'pct_third_party',
                                     'pct_pass_through', 'flat_person_day', 'flat_bill')),
  -- Percent for pct_*, dollars for flat_*. NULL = not set (billed $0 and named).
  value numeric(12,4) CHECK (value IS NULL OR value >= 0),
  -- A bill category key, 'other_fees' (under the Sub Total), 'oh_fee' (the
  -- standard OH line) or 'item' (pass-through: on the line it marks up).
  lands_on text NOT NULL,
  system boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  archived_at timestamptz,
  sort_order integer NOT NULL DEFAULT 1000,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid DEFAULT auth.uid(),
  CONSTRAINT billing_charges_pct_range CHECK (kind NOT LIKE 'pct%' OR value IS NULL OR value <= 100),
  CONSTRAINT billing_charges_money_cents CHECK (kind LIKE 'pct%' OR value IS NULL OR value = round(value, 2)),
  CONSTRAINT billing_charges_pass_through_is_standard CHECK (system OR kind <> 'pct_pass_through'),
  CONSTRAINT billing_charges_lands_on_known CHECK (lands_on IN (
    'billable_labor', 'assoc_labor_fees', 'prevailing_wage_benefits', 'lodging_hotel',
    'specialty_items', 'materials', 'equipment_tools', 'vehicles_mileage', 'subcontractors',
    'management_fee', 'reimbursables', 'other_fees', 'oh_fee', 'item')),
  CONSTRAINT billing_charges_subtotal_lands_below
    CHECK (kind <> 'pct_subtotal' OR lands_on IN ('other_fees', 'oh_fee'))
);
COMMENT ON TABLE public.billing_charges IS
  'Billing & Costs › General rules: charges on the T&M bill. Five standard rows (system) plus any added. Archived, never deleted. See 20261030120000.';

-- Standard rows keep their key, kind and landing; only their value and name move.
CREATE OR REPLACE FUNCTION public.tg_billing_charges_before()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.name := btrim(NEW.name);
  IF TG_OP = 'UPDATE' THEN
    NEW.key := OLD.key;
    NEW.system := OLD.system;
    NEW.created_at := OLD.created_at;
    NEW.created_by := OLD.created_by;
    NEW.updated_at := now();
    NEW.updated_by := auth.uid();
    IF OLD.system AND (NEW.kind IS DISTINCT FROM OLD.kind OR NEW.lands_on IS DISTINCT FROM OLD.lands_on) THEN
      RAISE EXCEPTION 'A standard charge keeps its type and where it lands (%).', OLD.name
        USING ERRCODE = '22023';
    END IF;
    IF OLD.system AND NEW.archived_at IS NOT NULL THEN
      RAISE EXCEPTION 'A standard charge cannot be archived; set it to 0 instead (%).', OLD.name
        USING ERRCODE = '22023';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_billing_charges_before() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS billing_charges_before ON public.billing_charges;
CREATE TRIGGER billing_charges_before BEFORE INSERT OR UPDATE ON public.billing_charges
  FOR EACH ROW EXECUTE FUNCTION public.tg_billing_charges_before();

CREATE OR REPLACE FUNCTION public.tg_billing_rules_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  o jsonb := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
  nw jsonb := to_jsonb(NEW);
  f text;
  entity text := CASE TG_TABLE_NAME WHEN 'billing_charges' THEN 'billing_charge' ELSE 'general_rules' END;
  k text := CASE TG_TABLE_NAME WHEN 'billing_charges' THEN nw->>'key' ELSE 'company' END;
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.money_audit_write('general_rules', entity, k, 'created', NULL,
      nw - 'created_at' - 'created_by' - 'updated_at' - 'updated_by');
    RETURN NEW;
  END IF;
  FOR f IN SELECT jsonb_object_keys(nw) LOOP
    CONTINUE WHEN f IN ('updated_at', 'updated_by', 'created_at', 'created_by');
    IF o->f IS DISTINCT FROM nw->f THEN
      PERFORM public.money_audit_write('general_rules', entity, k, f, o->f, nw->f);
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_billing_rules_audit() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS billing_general_rules_audit ON public.billing_general_rules;
CREATE TRIGGER billing_general_rules_audit AFTER INSERT OR UPDATE ON public.billing_general_rules
  FOR EACH ROW EXECUTE FUNCTION public.tg_billing_rules_audit();
DROP TRIGGER IF EXISTS billing_charges_audit ON public.billing_charges;
CREATE TRIGGER billing_charges_audit AFTER INSERT OR UPDATE ON public.billing_charges
  FOR EACH ROW EXECUTE FUNCTION public.tg_billing_rules_audit();

-- The minimum margin stays where every reader finds it (app_settings
-- 'finance'); its changes are recorded with the General rules.
CREATE OR REPLACE FUNCTION public.tg_app_settings_margin_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  old_v jsonb := CASE WHEN TG_OP = 'UPDATE' THEN OLD.value->'margin_threshold_pct' END;
BEGIN
  IF NEW.key = 'finance' AND old_v IS DISTINCT FROM NEW.value->'margin_threshold_pct' THEN
    PERFORM public.money_audit_write('general_rules', 'general_rules', 'company',
      'minimum_margin_percent', old_v, NEW.value->'margin_threshold_pct');
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_app_settings_margin_audit() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS app_settings_margin_audit ON public.app_settings;
CREATE TRIGGER app_settings_margin_audit AFTER INSERT OR UPDATE ON public.app_settings
  FOR EACH ROW EXECUTE FUNCTION public.tg_app_settings_margin_audit();

ALTER TABLE public.billing_general_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_charges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.billing_general_rules FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.billing_charges FROM PUBLIC, anon, authenticated;
-- Read by everyone who builds a bill; written only through billing_rules_save.
GRANT SELECT ON public.billing_general_rules, public.billing_charges TO authenticated;
GRANT ALL ON public.billing_general_rules, public.billing_charges TO service_role;
DROP POLICY IF EXISTS billing_general_rules_read ON public.billing_general_rules;
CREATE POLICY billing_general_rules_read ON public.billing_general_rules
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS billing_charges_read ON public.billing_charges;
CREATE POLICY billing_charges_read ON public.billing_charges
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS active_profile_required ON public.billing_general_rules;
CREATE POLICY active_profile_required ON public.billing_general_rules
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT goldstar_private.profile_is_active(auth.uid())))
  WITH CHECK ((SELECT goldstar_private.profile_is_active(auth.uid())));
DROP POLICY IF EXISTS active_profile_required ON public.billing_charges;
CREATE POLICY active_profile_required ON public.billing_charges
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT goldstar_private.profile_is_active(auth.uid())))
  WITH CHECK ((SELECT goldstar_private.profile_is_active(auth.uid())));
DROP POLICY IF EXISTS anonymous_business_access_denied ON public.billing_general_rules;
CREATE POLICY anonymous_business_access_denied ON public.billing_general_rules
  AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS anonymous_business_access_denied ON public.billing_charges;
CREATE POLICY anonymous_business_access_denied ON public.billing_charges
  AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

-- ---------------------------------------------------- the seed

DO $$
DECLARE
  s jsonb := coalesce((SELECT value FROM public.app_settings WHERE key = 'tm.bill_rules'), '{}'::jsonb);
  -- A stored number read the way cleanRules reads it: in range, else NULL.
  pct_of text;
  window_set boolean;
  daily numeric;
  small_tools numeric;
  per_diem numeric;
BEGIN
  PERFORM set_config('gsr.money_note', 'Seeded from the T&M bill rules (20261030120000)', true);

  window_set := coalesce(s->>'standardStart', '') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
            AND coalesce(s->>'standardEnd', '') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
            AND s->>'standardEnd' > s->>'standardStart';
  daily := CASE WHEN jsonb_typeof(s->'dailyOtAfterHours') = 'number'
                 AND (s->>'dailyOtAfterHours')::numeric BETWEEN 0 AND 24
                THEN (s->>'dailyOtAfterHours')::numeric END;

  INSERT INTO public.billing_general_rules (
    id, standard_start, standard_end, overtime_mode, daily_ot_after_hours,
    weekend_days, holidays, ot_multiplier, after_hours_multiplier, weekend_multiplier,
    holiday_multiplier, field_form_code, legacy_tax_percent, legacy_taxable_categories)
  SELECT true,
    CASE WHEN coalesce(s->>'standardStart', '') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN s->>'standardStart' ELSE '' END,
    CASE WHEN coalesce(s->>'standardEnd', '') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN s->>'standardEnd' ELSE '' END,
    CASE WHEN window_set AND daily IS NOT NULL THEN 'legacy_both'
         WHEN window_set THEN 'after_hours'
         WHEN daily IS NOT NULL THEN 'daily'
         ELSE 'none' END,
    daily,
    CASE WHEN jsonb_typeof(s->'weekendDays') = 'array'
         THEN ARRAY(SELECT DISTINCT d::smallint FROM jsonb_array_elements_text(s->'weekendDays') d
                     WHERE d ~ '^[0-6]$' ORDER BY 1)
         ELSE '{0,6}'::smallint[] END,
    CASE WHEN jsonb_typeof(s->'holidays') = 'array'
         THEN ARRAY(SELECT DISTINCT d::date FROM jsonb_array_elements_text(s->'holidays') d
                     WHERE d ~ '^\d{4}-\d{2}-\d{2}$' ORDER BY 1)
         ELSE '{}'::date[] END,
    CASE WHEN jsonb_typeof(s->'otMultiplier') = 'number' AND (s->>'otMultiplier')::numeric BETWEEN 1 AND 5
         THEN (s->>'otMultiplier')::numeric ELSE 1.5 END,
    CASE WHEN jsonb_typeof(s->'afterHoursMultiplier') = 'number' AND (s->>'afterHoursMultiplier')::numeric BETWEEN 1 AND 5
         THEN (s->>'afterHoursMultiplier')::numeric ELSE 1.5 END,
    CASE WHEN jsonb_typeof(s->'weekendMultiplier') = 'number' AND (s->>'weekendMultiplier')::numeric BETWEEN 1 AND 5
         THEN (s->>'weekendMultiplier')::numeric ELSE 1.5 END,
    CASE WHEN jsonb_typeof(s->'holidayMultiplier') = 'number' AND (s->>'holidayMultiplier')::numeric BETWEEN 1 AND 5
         THEN (s->>'holidayMultiplier')::numeric ELSE 2 END,
    CASE WHEN upper(btrim(coalesce(s->>'fieldFormCode', ''))) ~ '^[A-Z0-9][A-Z0-9-]{0,23}$'
         THEN upper(btrim(s->>'fieldFormCode')) END,
    CASE WHEN jsonb_typeof(s->'taxPercent') = 'number' AND (s->>'taxPercent')::numeric BETWEEN 0 AND 100
         THEN (s->>'taxPercent')::numeric END,
    CASE WHEN jsonb_typeof(s->'taxableCategories') = 'array'
         THEN ARRAY(SELECT jsonb_array_elements_text(s->'taxableCategories')) END
  ON CONFLICT (id) DO NOTHING;

  -- The bill read the rule, else the GEN- code's rate, else (Small Tools) 3%.
  small_tools := coalesce(
    CASE WHEN jsonb_typeof(s->'smallToolsPercent') = 'number'
              AND (s->>'smallToolsPercent')::numeric BETWEEN 0 AND 100
         THEN (s->>'smallToolsPercent')::numeric END,
    (SELECT rate FROM public.tm_rate_codes WHERE code = 'GEN-SMALLTOOLS'),
    3);
  per_diem := coalesce(
    CASE WHEN jsonb_typeof(s->'perDiemPerPersonDay') = 'number'
              AND (s->>'perDiemPerPersonDay')::numeric BETWEEN 0 AND 10000
         THEN (s->>'perDiemPerPersonDay')::numeric END,
    (SELECT rate FROM public.tm_rate_codes WHERE code = 'GEN-PERDIEM'));

  INSERT INTO public.billing_charges (key, name, kind, value, lands_on, system, sort_order) VALUES
    ('small_tools', 'Small Tools', 'pct_labor', small_tools, 'assoc_labor_fees', true, 10),
    ('per_diem', 'Per Diem', 'flat_person_day', per_diem, 'assoc_labor_fees', true, 20),
    ('op', 'O&P', 'pct_third_party',
      CASE WHEN jsonb_typeof(s->'opPercent') = 'number' AND (s->>'opPercent')::numeric BETWEEN 0 AND 100
           THEN (s->>'opPercent')::numeric ELSE 20 END, 'subcontractors', true, 30),
    ('pass_through', 'Debris / Hotel pass-through', 'pct_pass_through',
      CASE WHEN jsonb_typeof(s->'passThroughMarkupPercent') = 'number'
                AND (s->>'passThroughMarkupPercent')::numeric BETWEEN 0 AND 100
           THEN (s->>'passThroughMarkupPercent')::numeric ELSE 20 END, 'item', true, 40),
    ('oh_fee', 'Off-site Logistics / Support OH', 'pct_subtotal',
      CASE WHEN jsonb_typeof(s->'ohFeePercent') = 'number' AND (s->>'ohFeePercent')::numeric BETWEEN 0 AND 100
           THEN (s->>'ohFeePercent')::numeric ELSE 0 END, 'oh_fee', true, 50)
  ON CONFLICT (key) DO NOTHING;

  RAISE NOTICE 'General rules seeded: overtime %, Small Tools %%%, Per Diem %',
    (SELECT overtime_mode FROM public.billing_general_rules),
    (SELECT value FROM public.billing_charges WHERE key = 'small_tools'),
    coalesce((SELECT value FROM public.billing_charges WHERE key = 'per_diem')::text, 'not set');
  PERFORM set_config('gsr.money_note', '', true);
END;
$$;

COMMENT ON COLUMN public.app_settings.value IS
  'Free-form settings. tm.bill_rules is LEGACY since 20261030120000 (General rules live in billing_general_rules / billing_charges) and is no longer written.';

/*
 * The General rules tab's one Save.
 *   _rules:   any of the billing_general_rules columns, plus
 *             "minimum_margin_percent" (kept in app_settings 'finance')
 *   _charges: [{ "op": "create", "name", "kind", "value", "lands_on" }
 *              | { "op": "update", "key", "name"?, "value"?, "lands_on"?, "active"?, "archived"? }]
 * Tax columns are not accepted here.
 */
CREATE OR REPLACE FUNCTION public.billing_rules_save(
  _rules jsonb DEFAULT '{}'::jsonb, _charges jsonb DEFAULT '[]'::jsonb, _note text DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  r jsonb := coalesce(_rules, '{}'::jsonb);
  c jsonb;
  n integer := 0;
  new_key text;
  allowed text[] := ARRAY['standard_start', 'standard_end', 'overtime_mode', 'daily_ot_after_hours',
    'weekly_ot_after_hours', 'weekend_days', 'holidays', 'ot_multiplier', 'after_hours_multiplier',
    'weekend_multiplier', 'holiday_multiplier', 'field_form_code', 'minimum_margin_percent'];
  bad text;
BEGIN
  IF NOT public.is_privileged(auth.uid()) THEN
    RAISE EXCEPTION 'Only an administrator can change the billing rules.' USING ERRCODE = '42501';
  END IF;
  SELECT k INTO bad FROM jsonb_object_keys(r) k WHERE k <> ALL (allowed) LIMIT 1;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'General rules cannot change %.', bad USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('gsr.money_note', coalesce(btrim(_note), ''), true);

  IF r - 'minimum_margin_percent' <> '{}'::jsonb THEN
    UPDATE public.billing_general_rules g SET
      standard_start = CASE WHEN r ? 'standard_start' THEN coalesce(r->>'standard_start', '') ELSE g.standard_start END,
      standard_end = CASE WHEN r ? 'standard_end' THEN coalesce(r->>'standard_end', '') ELSE g.standard_end END,
      overtime_mode = CASE WHEN r ? 'overtime_mode' THEN r->>'overtime_mode' ELSE g.overtime_mode END,
      daily_ot_after_hours = CASE WHEN r ? 'daily_ot_after_hours' THEN (r->>'daily_ot_after_hours')::numeric ELSE g.daily_ot_after_hours END,
      weekly_ot_after_hours = CASE WHEN r ? 'weekly_ot_after_hours' THEN (r->>'weekly_ot_after_hours')::numeric ELSE g.weekly_ot_after_hours END,
      weekend_days = CASE WHEN r ? 'weekend_days'
        THEN ARRAY(SELECT DISTINCT d::smallint FROM jsonb_array_elements_text(r->'weekend_days') d ORDER BY 1)
        ELSE g.weekend_days END,
      holidays = CASE WHEN r ? 'holidays'
        THEN ARRAY(SELECT DISTINCT d::date FROM jsonb_array_elements_text(r->'holidays') d ORDER BY 1)
        ELSE g.holidays END,
      ot_multiplier = CASE WHEN r ? 'ot_multiplier' THEN (r->>'ot_multiplier')::numeric ELSE g.ot_multiplier END,
      after_hours_multiplier = CASE WHEN r ? 'after_hours_multiplier' THEN (r->>'after_hours_multiplier')::numeric ELSE g.after_hours_multiplier END,
      weekend_multiplier = CASE WHEN r ? 'weekend_multiplier' THEN (r->>'weekend_multiplier')::numeric ELSE g.weekend_multiplier END,
      holiday_multiplier = CASE WHEN r ? 'holiday_multiplier' THEN (r->>'holiday_multiplier')::numeric ELSE g.holiday_multiplier END,
      field_form_code = CASE WHEN r ? 'field_form_code' THEN nullif(upper(btrim(r->>'field_form_code')), '') ELSE g.field_form_code END
     WHERE g.id;
    n := n + 1;
  END IF;

  IF r ? 'minimum_margin_percent' THEN
    IF jsonb_typeof(r->'minimum_margin_percent') <> 'number'
       OR (r->>'minimum_margin_percent')::numeric NOT BETWEEN 0 AND 100 THEN
      RAISE EXCEPTION 'The minimum margin is a percentage from 0 to 100.' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.app_settings (key, value)
    VALUES ('finance', jsonb_build_object('margin_threshold_pct', r->'minimum_margin_percent'))
    ON CONFLICT (key) DO UPDATE
      SET value = public.app_settings.value
                  || jsonb_build_object('margin_threshold_pct', r->'minimum_margin_percent'),
          updated_at = now();
    n := n + 1;
  END IF;

  FOR c IN SELECT * FROM jsonb_array_elements(coalesce(_charges, '[]'::jsonb)) LOOP
    IF c->>'op' = 'create' THEN
      new_key := left(regexp_replace(lower(btrim(c->>'name')), '[^a-z0-9]+', '_', 'g'), 30);
      new_key := 'c_' || coalesce(nullif(btrim(new_key, '_'), ''), 'charge');
      WHILE EXISTS (SELECT 1 FROM public.billing_charges WHERE key = new_key) LOOP
        new_key := left(new_key, 32) || '_' || substr(md5(random()::text), 1, 4);
      END LOOP;
      IF EXISTS (SELECT 1 FROM public.billing_charges
                  WHERE lower(btrim(name)) = lower(btrim(c->>'name'))) THEN
        RAISE EXCEPTION '"%" already exists.', btrim(c->>'name') USING ERRCODE = '23505';
      END IF;
      INSERT INTO public.billing_charges (key, name, kind, value, lands_on, sort_order)
      VALUES (new_key, c->>'name', c->>'kind',
              CASE WHEN jsonb_typeof(c->'value') = 'number' THEN (c->>'value')::numeric END,
              c->>'lands_on',
              (SELECT coalesce(max(sort_order), 0) + 10 FROM public.billing_charges));
    ELSIF c->>'op' = 'update' THEN
      IF c ? 'name' AND EXISTS (SELECT 1 FROM public.billing_charges
                                 WHERE lower(btrim(name)) = lower(btrim(c->>'name'))
                                   AND key <> c->>'key') THEN
        RAISE EXCEPTION '"%" already exists.', btrim(c->>'name') USING ERRCODE = '23505';
      END IF;
      UPDATE public.billing_charges b SET
        name = CASE WHEN c ? 'name' THEN c->>'name' ELSE b.name END,
        value = CASE WHEN c ? 'value'
          THEN CASE WHEN jsonb_typeof(c->'value') = 'number' THEN (c->>'value')::numeric END
          ELSE b.value END,
        kind = CASE WHEN c ? 'kind' THEN c->>'kind' ELSE b.kind END,
        lands_on = CASE WHEN c ? 'lands_on' THEN c->>'lands_on' ELSE b.lands_on END,
        active = CASE WHEN c ? 'active' THEN (c->>'active')::boolean ELSE b.active END,
        archived_at = CASE WHEN NOT (c ? 'archived') THEN b.archived_at
                           WHEN (c->>'archived')::boolean THEN coalesce(b.archived_at, now())
                           ELSE NULL END
       WHERE b.key = c->>'key';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'No charge %.', c->>'key' USING ERRCODE = 'P0002';
      END IF;
    ELSE
      RAISE EXCEPTION 'Unknown charge change %.', coalesce(c->>'op', 'blank') USING ERRCODE = '22023';
    END IF;
    n := n + 1;
  END LOOP;
  RETURN n;
END;
$$;
REVOKE ALL ON FUNCTION public.billing_rules_save(jsonb, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.billing_rules_save(jsonb, jsonb, text) TO authenticated, service_role;
