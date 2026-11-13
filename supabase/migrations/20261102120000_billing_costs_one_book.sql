-- Billing & Costs, prompt 5: the T&M sheet's codes live in Catalogs (the
-- mirror retired both ways), every new job freezes its rules, and the P4
-- answers.
--
-- 1. CATALOGS IS THE T&M SHEET. The Daily Supply List's Equipment codes and
--    supply-list charges (General) join catalog_items (in_tm), with the
--    columns the sheet needs (its unit, Small Tools, equipment type). The
--    forms and the bill read the view tm_sheet_codes; every resolver reads
--    catalog_items. The Catalogs ↔ tm_rate_codes mirror is dropped both ways
--    and tm_rate_codes is kept, read-only, as history (series rule 2).
-- 2. FREEZE. Every new job keeps the General rules, charges and minimum
--    margin in force the day it is made (job_frozen_rules); the bill reads
--    them under the job's own override. With P2–P4 (T&M rates, costs, regular
--    rates) no later publish of any book reaches a job made after this.
--    Existing jobs are untouched and read as before.
-- 3. P4 answers: T&M bills ignore client agreements on jobs made from now
--    (billing_version 5); a T&M job's estimate prices T&M items from T&M
--    Rates; "Strip lines equal to Standard".
--
-- Re-runnable.

-- ============================================== 1. the T&M sheet in Catalogs

ALTER TABLE public.catalog_items DROP CONSTRAINT IF EXISTS catalog_items_category_known;
ALTER TABLE public.catalog_items ADD CONSTRAINT catalog_items_category_known
  CHECK (category IN ('labor', 'consumable', 'ppe', 'vehicle', 'equipment', 'service', 'general'));
ALTER TABLE public.catalog_items DROP CONSTRAINT IF EXISTS catalog_items_unit_fits_category;
ALTER TABLE public.catalog_items ADD CONSTRAINT catalog_items_unit_fits_category CHECK (
  unit IS NULL
  OR (category = 'labor' AND unit IN ('hr', 'day'))
  OR (category = 'consumable' AND unit IN ('piece', 'roll', 'box', 'pair', 'gal', 'sqft'))
  OR (category = 'ppe' AND unit IN ('piece', 'box', 'pair', 'day'))
  OR (category = 'vehicle' AND unit IN ('day', 'hr'))
  OR category IN ('equipment', 'service', 'general')
);

ALTER TABLE public.catalog_items
  ADD COLUMN IF NOT EXISTS tm_unit text,
  ADD COLUMN IF NOT EXISTS small_tools boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS equipment_type text REFERENCES public.equipment_types(key),
  ADD COLUMN IF NOT EXISTS equipment_type_review text;
DO $$ BEGIN
  ALTER TABLE public.catalog_items ADD CONSTRAINT catalog_items_tm_unit_known
    CHECK (tm_unit IS NULL OR tm_unit IN ('hr', 'day', 'each', 'pct', 'person_day'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
COMMENT ON COLUMN public.catalog_items.tm_unit IS
  'How the T&M sheet reads the rate (hr / day / each / pct / person_day), carried from tm_rate_codes.unit.';

-- The mirror stops first, so the copy below writes nothing back.
DROP TRIGGER IF EXISTS catalog_items_to_tm ON public.catalog_items;
DROP TRIGGER IF EXISTS tm_rate_codes_to_catalog ON public.tm_rate_codes;

-- A T&M item may be in any category now; General charges are always T&M.
CREATE OR REPLACE FUNCTION public.tg_catalog_items_books()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.in_tm := coalesce(NEW.in_tm, NEW.category IN ('labor', 'consumable', 'ppe', 'vehicle', 'general'));
    NEW.in_regular := coalesce(NEW.in_regular, NEW.category IN ('equipment', 'service')
                                               OR NEW.estimate_item_id IS NOT NULL);
  END IF;
  IF NEW.category = 'general' THEN NEW.in_tm := true; END IF;
  IF NEW.category = 'service' THEN NEW.in_tm := false; END IF;
  IF NEW.estimate_item_id IS NOT NULL THEN NEW.in_regular := true; END IF;
  IF NEW.in_tm AND NEW.tm_unit IS NULL THEN
    NEW.tm_unit := CASE WHEN NEW.unit IN ('hr', 'day') THEN NEW.unit
                        WHEN NEW.category = 'labor' THEN 'hr'
                        WHEN NEW.category IN ('vehicle', 'equipment') THEN 'day'
                        ELSE 'each' END;
  END IF;
  RETURN NEW;
END;
$$;

-- Copy every code the Catalogs did not yet hold (Equipment, General).
DO $$
DECLARE
  copied integer;
  before integer;
  missing integer;
BEGIN
  SELECT count(*) INTO before FROM public.catalog_items WHERE in_tm;
  PERFORM set_config('gsr.catalog_mirror', 'on', true);  -- skip the name guard: these names are the sheet's
  PERFORM set_config('gsr.catalog_from_estimate', 'on', true);
  PERFORM set_config('gsr.money_note', 'T&M sheet codes moved into Catalogs (20261102120000)', true);
  INSERT INTO public.catalog_items (code, name, category, unit, unit_review, note, active, sort_order,
                                    source_book, source_key, in_tm, in_regular, tm_unit, small_tools,
                                    equipment_type, equipment_type_review)
  SELECT t.code, t.label, t.section,
         CASE WHEN t.unit IN ('hr', 'day') THEN t.unit END,
         CASE WHEN t.unit NOT IN ('hr', 'day') OR t.unit IS NULL
              THEN 'Carried from the Daily Supply List — choose a catalog unit if it has one.' END,
         t.unit_note, t.active, t.sort_order, 'tm_rate_codes', t.code, true, false,
         t.unit, coalesce(t.small_tools, true), t.equipment_type, t.equipment_type_review
    FROM public.tm_rate_codes t
   WHERE t.section IN ('equipment', 'general')
     AND NOT EXISTS (SELECT 1 FROM public.catalog_items c WHERE c.code = t.code);
  GET DIAGNOSTICS copied = ROW_COUNT;
  -- The sheet columns for the codes already in Catalogs.
  UPDATE public.catalog_items c
     SET tm_unit = coalesce(t.unit, c.tm_unit),
         small_tools = coalesce(t.small_tools, c.small_tools),
         equipment_type = coalesce(c.equipment_type, t.equipment_type),
         equipment_type_review = coalesce(c.equipment_type_review, t.equipment_type_review)
    FROM public.tm_rate_codes t
   WHERE t.code = c.code;
  UPDATE public.catalog_items c SET in_tm = true
    FROM public.tm_rate_codes t WHERE t.code = c.code AND NOT c.in_tm;
  PERFORM set_config('gsr.catalog_mirror', 'off', true);
  PERFORM set_config('gsr.catalog_from_estimate', 'off', true);

  -- Every code on the old sheet is on the new one, with the same section,
  -- label and on/off.
  SELECT count(*) INTO missing FROM public.tm_rate_codes t
   WHERE NOT EXISTS (SELECT 1 FROM public.catalog_items c
                      WHERE c.code = t.code AND c.in_tm AND c.category = t.section
                        AND (c.active AND c.archived_at IS NULL) = t.active);
  IF missing > 0 THEN
    RAISE EXCEPTION 'T&M sheet move mismatch: % code(s) differ between tm_rate_codes and Catalogs.', missing;
  END IF;
  RAISE NOTICE 'T&M sheet: % codes were in Catalogs, % copied in (Equipment, General); % on the sheet now.',
    before, copied, (SELECT count(*) FROM public.catalog_items WHERE in_tm);
  PERFORM set_config('gsr.money_note', '', true);
END;
$$;

-- What the forms and the bill read: the sheet, from Catalogs.
CREATE OR REPLACE VIEW public.tm_sheet_codes
WITH (security_invoker = true) AS
SELECT c.code, c.name AS label, c.category AS section, c.note AS unit_note, c.sort_order,
       (c.active AND c.archived_at IS NULL) AS active, c.tm_unit AS unit, c.small_tools,
       c.equipment_type, c.equipment_type_review
  FROM public.catalog_items c
 WHERE c.in_tm;
COMMENT ON VIEW public.tm_sheet_codes IS
  'The T&M Daily Supply List and sign-in codes, read from Catalogs (20261102120000). Rates: money_values tm_rates; costs: money_values cost.';
REVOKE ALL ON public.tm_sheet_codes FROM PUBLIC, anon;
GRANT SELECT ON public.tm_sheet_codes TO authenticated, service_role;

-- A job's T&M sheet points at Catalogs now.
ALTER TABLE public.job_tm_rates DROP CONSTRAINT IF EXISTS job_tm_rates_code_fkey;
DO $$ BEGIN
  ALTER TABLE public.job_tm_rates ADD CONSTRAINT job_tm_rates_code_catalog_fkey
    FOREIGN KEY (code) REFERENCES public.catalog_items(code);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- tm_rate_codes: history, read only.
REVOKE INSERT, UPDATE, DELETE ON public.tm_rate_codes FROM authenticated, anon;
COMMENT ON TABLE public.tm_rate_codes IS
  'RETIRED 20261102120000 — read-only history. The T&M sheet''s codes are catalog_items (in_tm; view tm_sheet_codes), rates money_values tm_rates, costs money_values cost, Small Tools catalog_items.small_tools.';

-- The audit of a sheet column now follows Catalogs.
CREATE OR REPLACE FUNCTION public.tg_catalog_items_sheet_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.small_tools IS DISTINCT FROM OLD.small_tools THEN
    PERFORM public.money_audit_write('general_rules', 'catalog_item', NEW.code, 'small_tools',
      to_jsonb(OLD.small_tools), to_jsonb(NEW.small_tools));
  END IF;
  IF NEW.in_tm IS DISTINCT FROM OLD.in_tm THEN
    PERFORM public.money_audit_write('catalog', 'catalog_item', NEW.code, 'in_tm',
      to_jsonb(OLD.in_tm), to_jsonb(NEW.in_tm));
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_catalog_items_sheet_audit() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS catalog_items_sheet_audit ON public.catalog_items;
CREATE TRIGGER catalog_items_sheet_audit AFTER UPDATE ON public.catalog_items
  FOR EACH ROW EXECUTE FUNCTION public.tg_catalog_items_sheet_audit();

-- catalog_save runs as the caller: the sheet flag is editable like the rest.
GRANT UPDATE (in_tm) ON public.catalog_items TO authenticated;

-- catalog_save: a new item can be put on the T&M sheet ("in_tm").
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
      INSERT INTO public.catalog_items (code, name, category, unit, sort_order, note, in_tm)
      VALUES (upper(btrim(c->>'code')), c->>'name', c->>'category', nullif(c->>'unit', ''),
              next_sort, nullif(btrim(c->>'note'), ''),
              CASE WHEN c ? 'in_tm' THEN (c->>'in_tm')::boolean END);
    ELSIF c->>'op' = 'update' THEN
      UPDATE public.catalog_items i
         SET name = CASE WHEN c ? 'name' THEN c->>'name' ELSE i.name END,
             note = CASE WHEN c ? 'note' THEN nullif(btrim(c->>'note'), '') ELSE i.note END,
             unit = CASE WHEN c ? 'unit' THEN nullif(c->>'unit', '') ELSE i.unit END,
             unit_review = CASE WHEN c ? 'unit' AND nullif(c->>'unit', '') IS NOT NULL
                                THEN NULL ELSE i.unit_review END,
             active = CASE WHEN c ? 'active' THEN (c->>'active')::boolean ELSE i.active END,
             in_tm = CASE WHEN c ? 'in_tm' THEN (c->>'in_tm')::boolean ELSE i.in_tm END,
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

-- ======================================================= 2. the freeze

ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS billing_version smallint;
COMMENT ON COLUMN public.jobs.billing_version IS
  'The Billing & Costs rules a job was made under: 5 = T&M bills ignore client agreements and the job froze its rules (20261102120000). NULL = made before: grandfathered.';

CREATE TABLE IF NOT EXISTS public.job_frozen_rules (
  job_id uuid PRIMARY KEY REFERENCES public.jobs(id) ON DELETE CASCADE,
  rules jsonb NOT NULL,
  charges jsonb NOT NULL,
  minimum_margin_percent numeric,
  frozen_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.job_frozen_rules IS
  'The General rules row, charges and minimum margin in force the day the job was made. The T&M bill reads these under the job''s own override; later edits to General rules never reach the job.';
ALTER TABLE public.job_frozen_rules ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.job_frozen_rules FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.job_frozen_rules TO authenticated;
GRANT ALL ON public.job_frozen_rules TO service_role;
DROP POLICY IF EXISTS job_frozen_rules_read ON public.job_frozen_rules;
CREATE POLICY job_frozen_rules_read ON public.job_frozen_rules
  FOR SELECT TO authenticated USING (public.can_view_job((SELECT auth.uid()), job_id));
DROP POLICY IF EXISTS active_profile_required ON public.job_frozen_rules;
CREATE POLICY active_profile_required ON public.job_frozen_rules
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT goldstar_private.profile_is_active(auth.uid())))
  WITH CHECK ((SELECT goldstar_private.profile_is_active(auth.uid())));

CREATE OR REPLACE FUNCTION public.tg_jobs_freeze_rules()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.job_frozen_rules (job_id, rules, charges, minimum_margin_percent)
  SELECT NEW.id,
         coalesce((SELECT to_jsonb(r) FROM public.billing_general_rules r LIMIT 1), '{}'::jsonb),
         coalesce((SELECT jsonb_agg(to_jsonb(ch) ORDER BY ch.sort_order) FROM public.billing_charges ch), '[]'::jsonb),
         (SELECT nullif(s.value->>'margin_threshold_pct', '')::numeric FROM public.app_settings s WHERE s.key = 'finance')
  ON CONFLICT (job_id) DO NOTHING;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_jobs_freeze_rules() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS jobs_freeze_rules ON public.jobs;
CREATE TRIGGER jobs_freeze_rules AFTER INSERT ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.tg_jobs_freeze_rules();

CREATE OR REPLACE FUNCTION public.tg_jobs_billing_version()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.billing_version := coalesce(NEW.billing_version, 5);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_jobs_billing_version() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS jobs_billing_version ON public.jobs;
CREATE TRIGGER jobs_billing_version BEFORE INSERT ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.tg_jobs_billing_version();

-- Who relied on an agreement for scanned equipment on a T&M bill (P5 answer 1):
-- agreements with equipment lines whose clients have T&M jobs.
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(DISTINCT pl.id) INTO n
    FROM public.price_lists pl
    JOIN public.price_list_items i ON i.price_list_id = pl.id
    JOIN public.estimate_catalog_items e ON e.id = i.catalog_item_id AND e.code ILIKE 'GSC-EQ-%'
    JOIN public.price_list_assignments a ON a.price_list_id = pl.id AND a.account_id IS NOT NULL
    JOIN public.jobs j ON j.account_id = a.account_id AND j.job_type = 't_m'
   WHERE pl.kind = 'agreement';
  RAISE NOTICE 'Agreements with equipment lines whose clients have T&M jobs: % (their existing jobs keep that pricing; new T&M jobs bill T&M Rates).', n;
END;
$$;

-- ======================================================= 3. resolvers on Catalogs

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
    SELECT ci.code AS item_key FROM public.catalog_items ci WHERE ci.in_tm
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

CREATE OR REPLACE FUNCTION public.tg_jobs_snapshot_tm_rates()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.job_tm_rates (job_id, code, rate, cost_rate)
  SELECT NEW.id, t.code, r.value, cr.value
    FROM public.catalog_items t
    LEFT JOIN LATERAL public.resolve_money_value('tm_rates', t.code, 'bill_rate',
      coalesce(NEW.billing_location_id, NEW.location_id), current_date) r ON true
    LEFT JOIN LATERAL public.resolve_money_value('cost', t.code, 'cost_rate',
      coalesce(NEW.billing_location_id, NEW.location_id), current_date) cr ON true
   WHERE t.in_tm AND t.active AND t.archived_at IS NULL AND (r.value IS NOT NULL OR cr.value IS NOT NULL)
  ON CONFLICT (job_id, code) DO NOTHING;
  RETURN NEW;
END;
$$;


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
      IF NOT EXISTS (SELECT 1 FROM public.catalog_items WHERE code = k AND in_tm)
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
      UPDATE public.catalog_items SET small_tools = (c->>'on')::boolean
       WHERE code = c->>'code' AND category = 'labor' AND in_tm;
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
      IF NOT EXISTS (SELECT 1 FROM public.catalog_items WHERE code = k AND in_tm)
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
      -- An equipment day cost may carry fractions of a cent (a multi-day
      -- price divided by its days, P4 answer 4); everything else is cents.
      IF v IS NOT NULL AND (v < 0 OR v <> round(v, CASE WHEN k LIKE 'EQ:%' THEN 4 ELSE 2 END)) THEN
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
    CROSS JOIN (SELECT ci.code FROM public.catalog_items ci WHERE ci.in_tm) t
    LEFT JOIN public.job_tm_rates jr ON jr.job_id = j.id AND jr.code = t.code
    LEFT JOIN LATERAL public.resolve_money_value('cost', t.code, 'cost_rate', j.office, j.on_day) r
      ON true;
$$;
REVOKE ALL ON FUNCTION public.tm_cost_rates(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tm_cost_rates(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.regular_price_book(
  _job_id uuid, _account_id uuid, _location_id uuid, _state text, _on date,
  _agreement_id uuid DEFAULT NULL, _standard boolean DEFAULT false)
RETURNS TABLE (catalog_item_id uuid, code text, unit_price numeric, source text, price_list_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  agr uuid;
  st uuid;
  job_source text;
  job_agreement uuid;
  job_tm boolean := false;
  job_office uuid;
  job_day date;
BEGIN
  IF _job_id IS NOT NULL THEN
    SELECT jb.rate_source, jb.rate_agreement_id, coalesce(jb.job_type, '') = 't_m',
           coalesce(jb.billing_location_id, jb.location_id), jb.created_at::date
      INTO job_source, job_agreement, job_tm, job_office, job_day
      FROM public.jobs jb
     WHERE jb.id = _job_id AND public.can_view_job(auth.uid(), _job_id);
  END IF;
  IF NOT _standard AND coalesce(job_source, 'agreement') <> 'standard' THEN
    agr := coalesce(_agreement_id, job_agreement);
    IF agr IS NULL AND _account_id IS NOT NULL THEN
      SELECT a.price_list_id INTO agr
        FROM public.price_list_assignments a
        JOIN public.price_lists pl ON pl.id = a.price_list_id
       WHERE a.account_id = _account_id AND pl.kind = 'agreement' AND pl.archived_at IS NULL
         AND pl.is_active AND a.effective_from <= _on
         AND (a.effective_to IS NULL OR a.effective_to >= _on)
       ORDER BY a.is_primary DESC, a.effective_from DESC, a.created_at DESC, a.id DESC
       LIMIT 1;
    END IF;
  END IF;
  IF nullif(btrim(_state), '') IS NOT NULL THEN
    EXECUTE $q$
      SELECT a.price_list_id FROM public.price_list_assignments a
        JOIN public.price_lists pl ON pl.id = a.price_list_id
       WHERE upper(a.state_code) = upper(btrim($1)) AND pl.is_active AND pl.archived_at IS NULL
         AND a.effective_from <= $2 AND (a.effective_to IS NULL OR a.effective_to >= $2)
       ORDER BY a.effective_from DESC, a.created_at DESC, a.id DESC LIMIT 1
    $q$ INTO st USING _state, _on;
  END IF;
  -- A T&M job's estimate predicts its bill (P5 answer 3): an item that is a
  -- T&M code prices from the job's T&M sheet, else T&M Rates at the job's
  -- office as of its creation; every other item falls through the chain.
  RETURN QUERY
  SELECT c.id, c.code,
         CASE WHEN tm.rate IS NOT NULL THEN tm.rate
              WHEN jr.unit_price IS NOT NULL THEN jr.unit_price
              WHEN ai.unit_price IS NOT NULL THEN ai.unit_price
              WHEN so.source = 'office' THEN so.value
              WHEN si.unit_price IS NOT NULL THEN si.unit_price
              ELSE so.value END,
         CASE WHEN tm.rate IS NOT NULL THEN 'tm'
              WHEN jr.unit_price IS NOT NULL THEN CASE WHEN jr.source = 'custom' THEN 'custom' ELSE 'job' END
              WHEN ai.unit_price IS NOT NULL THEN 'account'
              WHEN so.source = 'office' THEN 'location'
              WHEN si.unit_price IS NOT NULL THEN 'state'
              WHEN so.value IS NOT NULL THEN 'default'
              ELSE 'none' END,
         CASE WHEN tm.rate IS NOT NULL THEN NULL
              WHEN jr.unit_price IS NOT NULL THEN jr.price_list_id
              WHEN ai.unit_price IS NOT NULL THEN agr
              WHEN so.source = 'office' THEN NULL
              WHEN si.unit_price IS NOT NULL THEN st END
    FROM public.estimate_catalog_items c
    LEFT JOIN LATERAL (
      SELECT coalesce(jt.rate, r.value) AS rate
        FROM public.catalog_items ci
        LEFT JOIN public.job_tm_rates jt ON jt.job_id = _job_id AND jt.code = ci.code
        LEFT JOIN LATERAL public.resolve_money_value('tm_rates', ci.code, 'bill_rate', job_office, job_day) r
          ON true
       WHERE job_tm AND ci.estimate_item_id = c.id AND ci.in_tm
       LIMIT 1
    ) tm ON true
    LEFT JOIN public.job_regular_rates jr ON jr.job_id = _job_id AND jr.catalog_item_id = c.id
    LEFT JOIN public.price_list_items ai ON ai.price_list_id = agr AND ai.catalog_item_id = c.id
    LEFT JOIN public.price_list_items si ON si.price_list_id = st AND si.catalog_item_id = c.id
    LEFT JOIN LATERAL public.resolve_money_value('client_agreements', c.code, 'unit_price', _location_id, _on) so
      ON true;
END;
$$;
REVOKE ALL ON FUNCTION public.regular_price_book(uuid, uuid, uuid, text, date, uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.regular_price_book(uuid, uuid, uuid, text, date, uuid, boolean)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.agreements_save(_changes jsonb, _note text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c jsonb;
  created uuid;
  agr uuid;
  item uuid;
  v numeric;
  j record;
BEGIN
  IF NOT public.can_manage_agreements(auth.uid()) THEN
    RAISE EXCEPTION 'Only an owner or admin can change client agreements.' USING ERRCODE = '42501';
  END IF;
  IF nullif(btrim(_note), '') IS NULL THEN
    RAISE EXCEPTION 'Say why — every agreement change needs a note.' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(_changes) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Nothing to save.' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('gsr.money_note', btrim(_note), true);
  FOR c IN SELECT * FROM jsonb_array_elements(_changes) LOOP
    agr := CASE WHEN c->>'agreement_id' = 'new' THEN created ELSE nullif(c->>'agreement_id', '')::uuid END;
    IF c->>'op' = 'create' THEN
      INSERT INTO public.price_lists (name, description, kind, effective_from, note, created_by)
      VALUES (btrim(c->>'name'), NULL, 'agreement',
              coalesce(nullif(c->>'effective_from', '')::date, current_date), nullif(btrim(c->>'note'), ''), auth.uid())
      RETURNING id INTO created;
    ELSIF c->>'op' = 'rename' THEN
      UPDATE public.price_lists SET name = btrim(c->>'name') WHERE id = agr AND kind = 'agreement';
    ELSIF c->>'op' = 'archive' THEN
      UPDATE public.price_lists SET archived_at = now(), is_active = false WHERE id = agr;
      UPDATE public.price_list_assignments SET effective_to = current_date - 1
       WHERE price_list_id = agr AND (effective_to IS NULL OR effective_to >= current_date)
         AND effective_from < current_date;
    ELSIF c->>'op' = 'line' THEN
      SELECT id INTO item FROM public.estimate_catalog_items WHERE code = c->>'code';
      IF item IS NULL THEN
        RAISE EXCEPTION 'No catalog item %.', c->>'code' USING ERRCODE = 'P0002';
      END IF;
      v := CASE WHEN jsonb_typeof(c->'value') = 'number' THEN (c->>'value')::numeric END;
      IF v IS NOT NULL AND (v < 0 OR v <> round(v, 2)) THEN
        RAISE EXCEPTION 'Prices are dollars and cents, 0 or more (% for %).', v, c->>'code' USING ERRCODE = '22023';
      END IF;
      IF v IS NULL THEN
        DELETE FROM public.price_list_items WHERE price_list_id = agr AND catalog_item_id = item;
      ELSE
        INSERT INTO public.price_list_items (price_list_id, catalog_item_id, unit_price)
        VALUES (agr, item, v)
        ON CONFLICT (price_list_id, catalog_item_id) DO UPDATE SET unit_price = EXCLUDED.unit_price, updated_at = now();
      END IF;
    ELSIF c->>'op' = 'link' THEN
      IF coalesce((c->>'primary')::boolean, false) THEN
        UPDATE public.price_list_assignments SET is_primary = false
         WHERE account_id = (c->>'account_id')::uuid AND is_primary;
      END IF;
      INSERT INTO public.price_list_assignments (price_list_id, account_id, effective_from, is_primary, created_by)
      VALUES (agr, (c->>'account_id')::uuid, coalesce(nullif(c->>'effective_from', '')::date, current_date),
              coalesce((c->>'primary')::boolean, false)
                OR NOT EXISTS (SELECT 1 FROM public.price_list_assignments p
                                WHERE p.account_id = (c->>'account_id')::uuid
                                  AND (p.effective_to IS NULL OR p.effective_to >= current_date)),
              auth.uid());
    ELSIF c->>'op' = 'unlink' THEN
      UPDATE public.price_list_assignments
         SET effective_to = greatest(effective_from, coalesce(nullif(c->>'effective_to', '')::date, current_date - 1)),
             is_primary = false
       WHERE id = (c->>'assignment_id')::uuid;
    ELSIF c->>'op' = 'strip_standard' THEN
      -- A full copy made lean (P5 answer 4): drop every line equal to the
      -- company Standard today; each removal is audited with the note.
      DELETE FROM public.price_list_items i
       USING public.estimate_catalog_items e
       WHERE i.price_list_id = agr AND e.id = i.catalog_item_id
         AND i.unit_price = (SELECT r.value FROM public.resolve_money_value(
               'client_agreements', e.code, 'unit_price', NULL, current_date) r);
      UPDATE public.price_lists SET full_copy = false WHERE id = agr;
    ELSIF c->>'op' = 'from_job' THEN
      SELECT id, account_id INTO j FROM public.jobs WHERE id = (c->>'job_id')::uuid;
      INSERT INTO public.price_lists (name, kind, effective_from, note, created_by)
      VALUES (btrim(c->>'name'), 'agreement', current_date, 'Made from a job''s custom rates', auth.uid())
      RETURNING id INTO created;
      INSERT INTO public.price_list_items (price_list_id, catalog_item_id, unit_price)
      SELECT created, r.catalog_item_id, r.unit_price FROM public.job_regular_rates r
       WHERE r.job_id = j.id AND r.source = 'custom';
      IF j.account_id IS NOT NULL THEN
        INSERT INTO public.price_list_assignments (price_list_id, account_id, effective_from, is_primary, created_by)
        VALUES (created, j.account_id, current_date,
                NOT EXISTS (SELECT 1 FROM public.price_list_assignments p WHERE p.account_id = j.account_id
                              AND (p.effective_to IS NULL OR p.effective_to >= current_date)),
                auth.uid());
      END IF;
    ELSE
      RAISE EXCEPTION 'Unknown agreement change %.', coalesce(c->>'op', 'blank') USING ERRCODE = '22023';
    END IF;
  END LOOP;
  RETURN created;
END;
$$;
REVOKE ALL ON FUNCTION public.agreements_save(jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agreements_save(jsonb, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.tg_jobs_snapshot_tm_rates() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tg_catalog_items_books() FROM PUBLIC, anon, authenticated;
