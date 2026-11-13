-- Billing & Costs rebuild, prompt 1 of 5 (29 Oct 2026): the foundation.
--
-- Three things, none of which changes a price or a cost anywhere today:
--
-- 1. money_audit_log — an append-only record of every money change: who,
--    what (old → new), when, which book, which office, and a note. Nobody can
--    update or delete a row, service_role included (a trigger refuses it), and
--    no client role may insert one directly: rows are written by the triggers
--    below, from inside the change itself, so a change cannot skip its record.
--    Wired now to the Catalogs book and to the T&M rate code money columns;
--    the later books are wired as their tabs land.
--
-- 2. catalog_items — the single home for the item catalog (Labor, General
--    Consumables, PPE, Vehicle lines), seeded from tm_rate_codes line for line
--    with a count check that aborts the migration if one row is missed.
--    Equipment and General Charges are NOT seeded: equipment types live in the
--    Equipment module, and the General Charges are rules (General rules tab).
--    Until the T&M Rates tab ships (prompt 2) tm_rate_codes stays the book the
--    T&M forms and bill read, so the two are kept in step by mirror triggers:
--    an item added, renamed, switched off or archived here reaches the T&M
--    pickers at once, and an edit on the old T&M rate codes page reaches the
--    catalog. Prices and costs are not mirrored — the catalog holds none. A
--    unit change is not mirrored either: the T&M bill reads tm_rate_codes.unit
--    to price a line, and a catalog edit must not re-price a running job.
--
-- 3. money_values — the office-aware value shape the T&M and Cost tabs fill
--    in prompts 2 and 3: one value per item × measure × office × effective
--    date, where office NULL is the company default. Resolution, in
--    resolve_money_value(): the office's latest row on or before the date,
--    else the default's latest row. An office row with a NULL value ends that
--    office's override from its date. No rows and no UI yet.
--
-- Units. The catalog speaks hr / day / piece / roll / box / pair, validated
-- per category. A unit is taken from the line's own words where it says one
-- ("Billed per roll", "per box of 50", "(per pair)"); otherwise the old
-- book's unit is carried AND flagged for review (unit_review) — the old book's
-- consumable/PPE "each" and vehicle "day" were section defaults set by
-- 20261027160000, not decisions. A line whose words name a unit the catalog
-- does not have (per gallon, square feet) gets no unit and a flag. Nothing is
-- defaulted silently.
--
-- Re-runnable: IF NOT EXISTS / CREATE OR REPLACE / DROP … IF EXISTS, and the
-- seed is ON CONFLICT DO NOTHING, so a second run neither duplicates nor
-- undoes an edit.

-- ===================================================== 1. money_audit_log

CREATE TABLE IF NOT EXISTS public.money_audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  changed_at timestamptz NOT NULL DEFAULT now(),
  changed_by uuid DEFAULT auth.uid(),
  book text NOT NULL CHECK (book IN (
    'catalog', 'general_rules', 'tm_rates', 'cost', 'client_agreements')),
  entity text NOT NULL CHECK (length(btrim(entity)) > 0),
  entity_key text NOT NULL CHECK (length(btrim(entity_key)) > 0),
  field text NOT NULL CHECK (length(btrim(field)) > 0),
  old_value jsonb,
  new_value jsonb,
  office_id uuid REFERENCES public.locations(id) ON DELETE RESTRICT,
  note text
);

CREATE INDEX IF NOT EXISTS money_audit_log_entity_idx
  ON public.money_audit_log (book, entity, entity_key, changed_at DESC);
CREATE INDEX IF NOT EXISTS money_audit_log_changed_at_idx
  ON public.money_audit_log (changed_at DESC);

COMMENT ON TABLE public.money_audit_log IS
  'Append-only record of every money change (who, what old→new, when, book, office, note). Written only by triggers; never updated or deleted. See 20261029120000_billing_costs_foundation.sql.';

CREATE OR REPLACE FUNCTION public.tg_money_audit_log_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'The money audit log is append-only: % is not allowed.', TG_OP
    USING ERRCODE = '42501';
END;
$$;
REVOKE ALL ON FUNCTION public.tg_money_audit_log_append_only() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS money_audit_log_no_update ON public.money_audit_log;
CREATE TRIGGER money_audit_log_no_update BEFORE UPDATE OR DELETE ON public.money_audit_log
  FOR EACH ROW EXECUTE FUNCTION public.tg_money_audit_log_append_only();
DROP TRIGGER IF EXISTS money_audit_log_no_truncate ON public.money_audit_log;
CREATE TRIGGER money_audit_log_no_truncate BEFORE TRUNCATE ON public.money_audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION public.tg_money_audit_log_append_only();

ALTER TABLE public.money_audit_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.money_audit_log FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.money_audit_log TO authenticated;
GRANT SELECT, INSERT ON public.money_audit_log TO service_role;

-- Cost values are in here, so it reads like the cost columns do: finance,
-- a cost viewer, or an administrator.
DROP POLICY IF EXISTS money_audit_log_read ON public.money_audit_log;
CREATE POLICY money_audit_log_read ON public.money_audit_log
  FOR SELECT TO authenticated
  USING (
    public.is_privileged((SELECT auth.uid()))
    OR public.can_view_finance((SELECT auth.uid()))
    OR public.has_permission((SELECT auth.uid()), 'job.view_costs', NULL)
  );
DROP POLICY IF EXISTS active_profile_required ON public.money_audit_log;
CREATE POLICY active_profile_required ON public.money_audit_log
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT goldstar_private.profile_is_active(auth.uid())))
  WITH CHECK ((SELECT goldstar_private.profile_is_active(auth.uid())));
DROP POLICY IF EXISTS anonymous_business_access_denied ON public.money_audit_log;
CREATE POLICY anonymous_business_access_denied ON public.money_audit_log
  AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

-- The one writer. A save passes its note in the transaction-local setting
-- gsr.money_note (catalog_save does); a change with none records NULL.
CREATE OR REPLACE FUNCTION public.money_audit_write(
  _book text, _entity text, _key text, _field text,
  _old jsonb, _new jsonb, _office_id uuid DEFAULT NULL, _note text DEFAULT NULL)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  INSERT INTO public.money_audit_log
    (book, entity, entity_key, field, old_value, new_value, office_id, note)
  VALUES (_book, _entity, _key, _field, _old, _new, _office_id,
          COALESCE(_note, nullif(current_setting('gsr.money_note', true), '')));
$$;
REVOKE ALL ON FUNCTION public.money_audit_write(text, text, text, text, jsonb, jsonb, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.money_audit_write(text, text, text, text, jsonb, jsonb, uuid, text)
  TO service_role;

-- ======================================================= 2. catalog_items

CREATE TABLE IF NOT EXISTS public.catalog_items (
  code text PRIMARY KEY CHECK (code ~ '^[A-Z0-9][A-Z0-9-]{0,23}$'),
  name text NOT NULL CHECK (length(btrim(name)) > 0 AND length(name) <= 200),
  category text NOT NULL CHECK (category IN ('labor', 'consumable', 'ppe', 'vehicle')),
  unit text CHECK (unit IN ('hr', 'day', 'piece', 'roll', 'box', 'pair')),
  -- Why the unit needs a person to look at it; NULL = confirmed.
  unit_review text CHECK (unit_review IS NULL OR length(btrim(unit_review)) > 0),
  active boolean NOT NULL DEFAULT true,
  archived_at timestamptz,
  archived_by uuid,
  sort_order integer NOT NULL DEFAULT 1000,
  -- Where the row came from: the old book and its key (tm_rate_codes / code).
  source_book text,
  source_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid DEFAULT auth.uid(),
  CONSTRAINT catalog_items_unit_or_review CHECK (unit IS NOT NULL OR unit_review IS NOT NULL),
  CONSTRAINT catalog_items_unit_fits_category CHECK (
    unit IS NULL
    OR (category = 'labor' AND unit IN ('hr', 'day'))
    OR (category = 'consumable' AND unit IN ('piece', 'roll', 'box', 'pair'))
    OR (category = 'ppe' AND unit IN ('piece', 'box', 'pair', 'day'))
    OR (category = 'vehicle' AND unit IN ('day', 'hr'))
  )
);

CREATE INDEX IF NOT EXISTS catalog_items_category_order_idx
  ON public.catalog_items (category, sort_order);
CREATE INDEX IF NOT EXISTS catalog_items_name_key_idx
  ON public.catalog_items (lower(regexp_replace(btrim(name), '\s+', ' ', 'g')));

COMMENT ON TABLE public.catalog_items IS
  'Billing & Costs › Catalogs: Labor, General Consumables, PPE and Vehicle lines. Code is immutable; items are archived, never deleted. Mirrored into tm_rate_codes until the T&M Rates tab ships. See 20261029120000_billing_costs_foundation.sql.';

/*
 * The unit a line's own words give it, else the old book's unit with a flag.
 * Shared by the seed and by the mirror from tm_rate_codes, so a code added on
 * the old page lands in the catalog by the same rule.
 */
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
    WHEN 'consumable' THEN ARRAY['piece', 'roll', 'box', 'pair']
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

  -- Units the catalog does not have: no unit, and say what the words said.
  IF t ~ '\m(gal|gals|gallon|gallons)\M' THEN
    RETURN QUERY SELECT NULL::text,
      'The description says per gallon, which is not a catalog unit yet. Choose a unit or ask for gallon to be added.'::text;
    RETURN;
  END IF;
  IF t ~ '\msq\.? ?ft\M|\msquare f(ee|oo)t\M' THEN
    RETURN QUERY SELECT NULL::text,
      'The description says per square foot, which is not a catalog unit yet. Choose a unit or ask for square foot to be added.'::text;
    RETURN;
  END IF;

  said := CASE
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

  -- Nothing in the words: carry the old book's unit, flagged.
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
REVOKE ALL ON FUNCTION public.catalog_unit_from_label(text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.catalog_unit_from_label(text, text, text, text)
  TO authenticated, service_role;

-- Before a write: trim the name, pin the code and category, stamp who/when,
-- and refuse a name another item already has (case and spacing ignored).
-- The mirror from the old page sets gsr.catalog_mirror around its own write
-- and skips the name guard, so the old page keeps working exactly as it did.
-- (gsr.catalog_to_tm marks the other direction, so neither echoes back.)
CREATE OR REPLACE FUNCTION public.tg_catalog_items_before()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  clash text;
BEGIN
  NEW.name := btrim(NEW.name);
  IF TG_OP = 'UPDATE' THEN
    IF NEW.code IS DISTINCT FROM OLD.code THEN
      RAISE EXCEPTION 'A catalog code cannot be changed (%).', OLD.code USING ERRCODE = '22023';
    END IF;
    IF NEW.category IS DISTINCT FROM OLD.category THEN
      RAISE EXCEPTION 'A catalog item cannot move category (%).', OLD.code USING ERRCODE = '22023';
    END IF;
    NEW.created_at := OLD.created_at;
    NEW.created_by := OLD.created_by;
    NEW.source_book := OLD.source_book;
    NEW.source_key := OLD.source_key;
    NEW.updated_at := now();
    NEW.updated_by := auth.uid();
    IF NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL THEN
      NEW.archived_by := auth.uid();
    ELSIF NEW.archived_at IS NULL THEN
      NEW.archived_by := NULL;
    END IF;
  END IF;

  IF coalesce(current_setting('gsr.catalog_mirror', true), '') <> 'on'
     AND (TG_OP = 'INSERT' OR NEW.name IS DISTINCT FROM OLD.name) THEN
    PERFORM pg_advisory_xact_lock(hashtext('catalog_items.name'));
    SELECT c.code INTO clash
      FROM public.catalog_items c
     WHERE lower(regexp_replace(btrim(c.name), '\s+', ' ', 'g'))
           = lower(regexp_replace(NEW.name, '\s+', ' ', 'g'))
       AND c.code <> NEW.code
     LIMIT 1;
    IF clash IS NOT NULL THEN
      RAISE EXCEPTION '"%" already exists.', NEW.name
        USING ERRCODE = '23505', DETAIL = 'catalog_duplicate_name:' || clash;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_catalog_items_before() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS catalog_items_before ON public.catalog_items;
CREATE TRIGGER catalog_items_before BEFORE INSERT OR UPDATE ON public.catalog_items
  FOR EACH ROW EXECUTE FUNCTION public.tg_catalog_items_before();

ALTER TABLE public.catalog_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.catalog_items FROM PUBLIC, anon, authenticated;
-- No DELETE for anyone but service_role: items are archived.
GRANT SELECT, INSERT ON public.catalog_items TO authenticated;
GRANT UPDATE (name, unit, unit_review, active, archived_at, sort_order)
  ON public.catalog_items TO authenticated;
GRANT ALL ON public.catalog_items TO service_role;

DROP POLICY IF EXISTS catalog_items_read ON public.catalog_items;
CREATE POLICY catalog_items_read ON public.catalog_items
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS catalog_items_insert ON public.catalog_items;
CREATE POLICY catalog_items_insert ON public.catalog_items
  FOR INSERT TO authenticated
  WITH CHECK (public.is_privileged((SELECT auth.uid())));
DROP POLICY IF EXISTS catalog_items_update ON public.catalog_items;
CREATE POLICY catalog_items_update ON public.catalog_items
  FOR UPDATE TO authenticated
  USING (public.is_privileged((SELECT auth.uid())))
  WITH CHECK (public.is_privileged((SELECT auth.uid())));
DROP POLICY IF EXISTS active_profile_required ON public.catalog_items;
CREATE POLICY active_profile_required ON public.catalog_items
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT goldstar_private.profile_is_active(auth.uid())))
  WITH CHECK ((SELECT goldstar_private.profile_is_active(auth.uid())));
DROP POLICY IF EXISTS anonymous_business_access_denied ON public.catalog_items;
CREATE POLICY anonymous_business_access_denied ON public.catalog_items
  AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

-- ------------------------------------------------- audit (catalog book)

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
REVOKE ALL ON FUNCTION public.tg_catalog_items_audit() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS catalog_items_audit ON public.catalog_items;
CREATE TRIGGER catalog_items_audit AFTER INSERT OR UPDATE ON public.catalog_items
  FOR EACH ROW EXECUTE FUNCTION public.tg_catalog_items_audit();

-- ------------------------------------- mirror: catalog → tm_rate_codes

/*
 * The T&M forms and bill read tm_rate_codes until prompt 2. A new catalog
 * item gets its code there (unit hr/day as chosen, any count unit as "each",
 * the line's per-unit rate left blank — the bill names an unpriced code); a
 * rename, Active switch or archive is copied. A code the old book already
 * uses in ANOTHER section is refused rather than silently shared.
 */
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
    INSERT INTO public.tm_rate_codes (code, label, section, sort_order, active, unit)
    VALUES (NEW.code, NEW.name, NEW.category, NEW.sort_order, live,
            CASE WHEN NEW.unit IN ('hr', 'day') THEN NEW.unit
                 WHEN NEW.unit IS NOT NULL THEN 'each'
                 WHEN NEW.category = 'labor' THEN 'hr'
                 WHEN NEW.category = 'vehicle' THEN 'day'
                 ELSE 'each' END)
    ON CONFLICT (code) DO NOTHING;
    PERFORM set_config('gsr.catalog_to_tm', 'off', true);
    RETURN NEW;
  END IF;

  IF NEW.name IS DISTINCT FROM OLD.name
     OR live IS DISTINCT FROM (OLD.active AND OLD.archived_at IS NULL) THEN
    PERFORM set_config('gsr.catalog_to_tm', 'on', true);
    UPDATE public.tm_rate_codes t
       SET label = NEW.name, active = live
     WHERE t.code = NEW.code
       AND (t.label IS DISTINCT FROM NEW.name OR t.active IS DISTINCT FROM live);
    PERFORM set_config('gsr.catalog_to_tm', 'off', true);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_catalog_items_to_tm() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS catalog_items_to_tm ON public.catalog_items;
CREATE TRIGGER catalog_items_to_tm AFTER INSERT OR UPDATE ON public.catalog_items
  FOR EACH ROW EXECUTE FUNCTION public.tg_catalog_items_to_tm();

-- ------------------------------------- mirror: tm_rate_codes → catalog

/*
 * The old T&M rate codes page keeps working exactly as before; what it does
 * to a Labor / Consumable / PPE / Vehicle code lands in the catalog. Switching
 * an archived item back on there restores it (the old page has no archive, so
 * "on" is the only thing it can mean).
 */
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
  -- Only when this change did not itself come from the catalog.
  IF coalesce(current_setting('gsr.catalog_to_tm', true), '') = 'on' THEN
    RETURN NEW;
  END IF;
  PERFORM set_config('gsr.catalog_mirror', 'on', true);
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.catalog_items
      (code, name, category, unit, unit_review, active, sort_order, source_book, source_key)
    SELECT NEW.code, btrim(NEW.label), NEW.section, u.unit, u.unit_review, NEW.active,
           NEW.sort_order, 'tm_rate_codes', NEW.code
      FROM public.catalog_unit_from_label(NEW.section, NEW.label, NEW.unit_note, NEW.unit) u
    ON CONFLICT (code) DO NOTHING;
  ELSIF NEW.label IS DISTINCT FROM OLD.label OR NEW.active IS DISTINCT FROM OLD.active THEN
    UPDATE public.catalog_items c
       SET name = btrim(NEW.label),
           active = CASE WHEN NEW.active IS DISTINCT FROM OLD.active THEN NEW.active
                         ELSE c.active END,
           archived_at = CASE WHEN NEW.active AND NOT OLD.active THEN NULL ELSE c.archived_at END
     WHERE c.code = NEW.code
       AND (c.name IS DISTINCT FROM btrim(NEW.label)
            OR (NEW.active IS DISTINCT FROM OLD.active
                AND (c.active IS DISTINCT FROM NEW.active
                     OR (NEW.active AND c.archived_at IS NOT NULL))));
  END IF;
  PERFORM set_config('gsr.catalog_mirror', 'off', true);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_tm_rate_codes_to_catalog() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS tm_rate_codes_to_catalog ON public.tm_rate_codes;
CREATE TRIGGER tm_rate_codes_to_catalog AFTER INSERT OR UPDATE ON public.tm_rate_codes
  FOR EACH ROW EXECUTE FUNCTION public.tg_tm_rate_codes_to_catalog();

-- ------------------------------------- audit (tm_rates book: money columns)

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
    PERFORM public.money_audit_write('tm_rates', 'tm_rate_code', NEW.code, 'cost_rate',
      to_jsonb(OLD.cost_rate), to_jsonb(NEW.cost_rate));
  END IF;
  IF NEW.unit IS DISTINCT FROM OLD.unit THEN
    PERFORM public.money_audit_write('tm_rates', 'tm_rate_code', NEW.code, 'unit',
      to_jsonb(OLD.unit), to_jsonb(NEW.unit));
  END IF;
  IF NEW.small_tools IS DISTINCT FROM OLD.small_tools THEN
    PERFORM public.money_audit_write('tm_rates', 'tm_rate_code', NEW.code, 'small_tools',
      to_jsonb(OLD.small_tools), to_jsonb(NEW.small_tools));
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_tm_rate_codes_audit() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS tm_rate_codes_audit ON public.tm_rate_codes;
CREATE TRIGGER tm_rate_codes_audit AFTER INSERT OR UPDATE ON public.tm_rate_codes
  FOR EACH ROW EXECUTE FUNCTION public.tg_tm_rate_codes_audit();

-- ------------------------------------------------- seed + count check

DO $$
DECLARE
  r record;
  old_n integer;
  new_n integer;
  report text := '';
BEGIN
  PERFORM set_config('gsr.catalog_mirror', 'on', true);
  PERFORM set_config('gsr.money_note', 'Seeded from T&M rate codes (20261029120000)', true);

  INSERT INTO public.catalog_items
    (code, name, category, unit, unit_review, active, sort_order, source_book, source_key,
     created_at, created_by, updated_at, updated_by)
  SELECT t.code, btrim(t.label), t.section, u.unit, u.unit_review, t.active, t.sort_order,
         'tm_rate_codes', t.code, t.created_at, t.updated_by, t.updated_at, t.updated_by
    FROM public.tm_rate_codes t
    CROSS JOIN LATERAL public.catalog_unit_from_label(t.section, t.label, t.unit_note, t.unit) u
   WHERE t.section IN ('labor', 'consumable', 'ppe', 'vehicle')
  ON CONFLICT (code) DO NOTHING;

  -- Old book vs new, per category and per Active flag: must be identical.
  FOR r IN
    SELECT s.section,
           (SELECT count(*) FROM public.tm_rate_codes t WHERE t.section = s.section) AS old_all,
           (SELECT count(*) FROM public.tm_rate_codes t
             WHERE t.section = s.section AND t.active) AS old_active,
           (SELECT count(*) FROM public.catalog_items c
             WHERE c.category = s.section
               AND EXISTS (SELECT 1 FROM public.tm_rate_codes t
                            WHERE t.code = c.code AND t.section = c.category)) AS new_all,
           (SELECT count(*) FROM public.catalog_items c
              JOIN public.tm_rate_codes t ON t.code = c.code
             WHERE c.category = s.section AND c.active = t.active AND t.active) AS new_active,
           (SELECT count(*) FROM public.catalog_items c
              JOIN public.tm_rate_codes t ON t.code = c.code
             WHERE c.category = s.section AND c.name <> btrim(t.label)) AS name_drift
      FROM unnest(ARRAY['labor', 'consumable', 'ppe', 'vehicle']) AS s(section)
  LOOP
    IF r.old_all <> r.new_all OR r.old_active <> r.new_active THEN
      RAISE EXCEPTION 'Catalog seed count mismatch in %: old % (% active), new % (% active).',
        r.section, r.old_all, r.old_active, r.new_all, r.new_active;
    END IF;
    report := report || format('%s %s/%s active (names differing from the old book: %s); ',
      r.section, r.new_active, r.new_all, r.name_drift);
  END LOOP;

  SELECT count(*) INTO old_n FROM public.tm_rate_codes
   WHERE section IN ('labor', 'consumable', 'ppe', 'vehicle');
  SELECT count(*) INTO new_n FROM public.catalog_items c
   WHERE EXISTS (SELECT 1 FROM public.tm_rate_codes t WHERE t.code = c.code);
  IF old_n <> new_n THEN
    RAISE EXCEPTION 'Catalog seed count mismatch: old book % rows, catalog % rows.', old_n, new_n;
  END IF;
  RAISE NOTICE 'Catalog seed check passed: % rows. %', new_n, report;
  RAISE NOTICE 'Catalog units flagged for review: %',
    (SELECT count(*) FROM public.catalog_items WHERE unit_review IS NOT NULL);
  PERFORM set_config('gsr.catalog_mirror', 'off', true);
  PERFORM set_config('gsr.money_note', '', true);
END;
$$;

-- ------------------------------------------------- the Catalogs save

/*
 * One explicit Save from the Catalogs tab: every pending change, in one
 * transaction, under one note. Any refusal (a duplicate name, a unit that
 * does not fit, a code already taken) rolls the whole save back, and the
 * message names the item. Invoker rights: RLS decides who may write
 * (is_privileged, the same writers as tm_rate_codes).
 *
 * _changes: [{ "op": "create", "code", "name", "category", "unit" }
 *            | { "op": "update", "code", "name"?, "unit"?, "active"?, "archived"? }]
 * An update that sets a unit confirms it (clears unit_review).
 */
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
      INSERT INTO public.catalog_items (code, name, category, unit, sort_order)
      VALUES (upper(btrim(c->>'code')), c->>'name', c->>'category', nullif(c->>'unit', ''),
              next_sort);
    ELSIF c->>'op' = 'update' THEN
      UPDATE public.catalog_items i
         SET name = CASE WHEN c ? 'name' THEN c->>'name' ELSE i.name END,
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

/*
 * "Used on N jobs", shown before archiving: distinct jobs whose T&M sheets
 * carry the code — a Daily Supply List line or a sign-in row's rate code.
 * Counted across every office (archiving is company-wide), administrators only.
 */
CREATE OR REPLACE FUNCTION public.catalog_item_usage(_codes text[])
RETURNS TABLE (code text, jobs bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT k.code, count(DISTINCT f.job_id)
    FROM unnest(_codes) AS k(code)
    LEFT JOIN public.job_tm_forms f
      ON (f.kind = 'supply_list'
          AND f.payload->'lines' @> jsonb_build_array(jsonb_build_object('code', k.code)))
      OR (f.kind = 'sign_in'
          AND f.payload->'rows' @> jsonb_build_array(jsonb_build_object('rateCode', k.code)))
   WHERE public.is_privileged(auth.uid())
   GROUP BY k.code;
$$;
REVOKE ALL ON FUNCTION public.catalog_item_usage(text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.catalog_item_usage(text[]) TO authenticated, service_role;

-- ======================================================== 3. money_values

CREATE TABLE IF NOT EXISTS public.money_values (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book text NOT NULL CHECK (book IN ('general_rules', 'tm_rates', 'cost', 'client_agreements')),
  item_key text NOT NULL CHECK (length(btrim(item_key)) > 0),
  measure text NOT NULL CHECK (measure ~ '^[a-z][a-z0-9_]{0,39}$'),
  -- NULL = the company default; an office row overrides it for that office.
  office_id uuid REFERENCES public.locations(id) ON DELETE RESTRICT,
  effective_from date NOT NULL,
  -- NULL only on an office row: that office stops overriding from this date.
  value numeric(14,4) CHECK (value IS NULL OR value >= 0),
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid(),
  CONSTRAINT money_values_default_has_value CHECK (value IS NOT NULL OR office_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS money_values_one_per_day
  ON public.money_values (book, item_key, measure,
    coalesce(office_id, '00000000-0000-0000-0000-000000000000'::uuid), effective_from);

COMMENT ON TABLE public.money_values IS
  'Office-aware, effective-dated money values: item × measure × office (NULL = default) × date. Rows are never edited — a change is a new dated row. Resolved by resolve_money_value(). Filled from prompt 2 on. See 20261029120000_billing_costs_foundation.sql.';

-- Rows are history: a correction is a new dated row, never an edit.
CREATE OR REPLACE FUNCTION public.tg_money_values_no_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'A money value is never edited; add a new dated value instead.'
    USING ERRCODE = '42501';
END;
$$;
REVOKE ALL ON FUNCTION public.tg_money_values_no_update() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS money_values_no_update ON public.money_values;
CREATE TRIGGER money_values_no_update BEFORE UPDATE ON public.money_values
  FOR EACH ROW EXECUTE FUNCTION public.tg_money_values_no_update();

CREATE OR REPLACE FUNCTION public.tg_money_values_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.money_audit_write(NEW.book, 'money_value', NEW.item_key, NEW.measure,
    NULL,
    jsonb_build_object('value', NEW.value, 'effective_from', NEW.effective_from),
    NEW.office_id, NEW.note);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_money_values_audit() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS money_values_audit ON public.money_values;
CREATE TRIGGER money_values_audit AFTER INSERT ON public.money_values
  FOR EACH ROW EXECUTE FUNCTION public.tg_money_values_audit();

ALTER TABLE public.money_values ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.money_values FROM PUBLIC, anon, authenticated;
-- Read-only to clients until the T&M and Cost tabs bring their own writers.
GRANT SELECT ON public.money_values TO authenticated;
GRANT ALL ON public.money_values TO service_role;

DROP POLICY IF EXISTS money_values_read ON public.money_values;
CREATE POLICY money_values_read ON public.money_values
  FOR SELECT TO authenticated
  USING (
    public.is_privileged((SELECT auth.uid()))
    OR public.can_view_finance((SELECT auth.uid()))
    OR public.has_permission((SELECT auth.uid()), 'job.view_costs', NULL)
  );
DROP POLICY IF EXISTS active_profile_required ON public.money_values;
CREATE POLICY active_profile_required ON public.money_values
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT goldstar_private.profile_is_active(auth.uid())))
  WITH CHECK ((SELECT goldstar_private.profile_is_active(auth.uid())));
DROP POLICY IF EXISTS anonymous_business_access_denied ON public.money_values;
CREATE POLICY anonymous_business_access_denied ON public.money_values
  AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

/*
 * The value in force for an office on a date: the office's own latest row on
 * or before the date, else the company default's. An office row with a NULL
 * value means "back to the default" from its date. Mirrored, case for case,
 * by resolveOfficeValue in src/lib/office-values.ts.
 */
CREATE OR REPLACE FUNCTION public.resolve_money_value(
  _book text, _item_key text, _measure text, _office_id uuid, _on date)
RETURNS TABLE (value numeric, source text, effective_from date)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH own AS (
    SELECT v.value, v.effective_from
      FROM public.money_values v
     WHERE _office_id IS NOT NULL
       AND v.book = _book AND v.item_key = _item_key AND v.measure = _measure
       AND v.office_id = _office_id AND v.effective_from <= _on
     ORDER BY v.effective_from DESC
     LIMIT 1
  ), dflt AS (
    SELECT v.value, v.effective_from
      FROM public.money_values v
     WHERE v.book = _book AND v.item_key = _item_key AND v.measure = _measure
       AND v.office_id IS NULL AND v.effective_from <= _on
     ORDER BY v.effective_from DESC
     LIMIT 1
  )
  SELECT o.value, 'office'::text, o.effective_from FROM own o WHERE o.value IS NOT NULL
  UNION ALL
  SELECT d.value, 'default'::text, d.effective_from FROM dflt d
   WHERE NOT EXISTS (SELECT 1 FROM own o WHERE o.value IS NOT NULL);
$$;
REVOKE ALL ON FUNCTION public.resolve_money_value(text, text, text, uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_money_value(text, text, text, uuid, date)
  TO authenticated, service_role;
