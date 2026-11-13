-- Billing & Costs, prompt 4: Client Agreements, Standard rates, the regular
-- price chain, job rate sources, and the Estimate catalog merged into Catalogs.
--
-- 0. P3 follow-ups: 305/306 map to Air scrubber; the register's HEPA units
--    move onto Air scrubber ONLY where that changes no money (else flagged
--    with the evidence); injector / ozone / hydroxyl become equipment types
--    and take their day costs from the field-ticket card (kept); an
--    equipment day cost may carry fractions of a cent.
-- 1. STANDARD RATES — the price every customer without an agreement pays —
--    move onto the office-aware store: money_values book client_agreements,
--    measure unit_price, item_key = the catalog item's code. The company
--    default is each item's catalog default price; an office's own price
--    comes from the branch price lists (GSC-LABOR-REG's office labor charge
--    among them). Seeded so every office resolves today to exactly what it
--    paid before; checked, and the migration stops on a mismatch.
-- 2. CLIENT AGREEMENTS are the price lists, unchanged in shape: a list of
--    exceptions (silence inherits Standard, live) assigned to one or many
--    clients, dated. Branch-only lists become kind 'office' (their prices
--    now live in Standard; the list is kept read-only as history); state
--    lists keep working as kind 'state'. New: kind, effective date, note,
--    archive, a primary flag per client, duplicate names refused, writes
--    for owner/admin only, every change audited.
-- 3. ONE RESOLVER, regular_price_book(): job's own line → client agreement
--    → office Standard → state list → company Standard. An item nothing
--    prices comes back with no price ('none'), never a silent zero.
-- 4. JOBS choose a rate source (agreement / Standard / custom) and freeze
--    their resolved regular rates at creation, like the T&M sheet. Existing
--    jobs are untouched (no snapshot: they resolve live, as today).
-- 5. The Estimate catalog merges into Catalogs: duplicates linked, the rest
--    added (Equipment / Services categories for what the T&M book has no
--    place for), ambiguous ones flagged. A merged item edited in Catalogs is
--    mirrored back onto its estimate row, which estimate and invoice lines
--    still point at. Counts are checked old vs merged.
--
-- Re-runnable: guarded inserts, CREATE OR REPLACE, DROP … IF EXISTS.

-- ============================================== 0. prompt-3 follow-ups

-- 305/306 are air scrubbers with HEPA filtration (P4 answer 2).
UPDATE public.tm_rate_codes
   SET equipment_type = 'air_scrubber', equipment_type_review = NULL
 WHERE section = 'equipment' AND label ~* '^air scrubber - hepa'
   AND equipment_type IS NULL;

-- The register's HEPA units onto Air scrubber — an audited correction, done
-- only where the two types bill and cost the same at every office. Where
-- they differ the units stay and the evidence is printed: moving them would
-- re-price every T&M bill and running cost those units are on.
DO $$
DECLARE
  diffs text;
  moved integer := 0;
BEGIN
  IF to_regclass('public.equipment') IS NULL THEN RETURN; END IF;
  SELECT string_agg(format('%s %s: HEPA %s vs Air scrubber %s',
                           coalesce(o.name, 'default'), b.book,
                           coalesce(h.value::text, 'none'), coalesce(a.value::text, 'none')), '; ')
    INTO diffs
    FROM (SELECT NULL::uuid AS id, NULL::text AS name UNION ALL SELECT l.id, l.name FROM public.locations l) o
    CROSS JOIN (VALUES ('tm_rates', 'bill_rate'), ('cost', 'cost_rate')) AS b(book, measure)
    LEFT JOIN LATERAL public.resolve_money_value(b.book, 'EQ:hepa', b.measure, o.id, current_date) h ON true
    LEFT JOIN LATERAL public.resolve_money_value(b.book, 'EQ:air_scrubber', b.measure, o.id, current_date) a ON true
   WHERE h.value IS DISTINCT FROM a.value;
  IF diffs IS NOT NULL THEN
    RAISE NOTICE 'HEPA units NOT moved to Air scrubber — the two types are priced differently (%). Decide the price first.', diffs;
    RETURN;
  END IF;
  PERFORM set_config('gsr.money_note', 'HEPA units are air scrubbers (P4 answer 2)', true);
  EXECUTE $q$
    WITH m AS (
      UPDATE public.equipment e
         SET equipment_type = 'air_scrubber',
             notes = concat_ws(E'\n', nullif(e.notes, ''),
                     'Type corrected HEPA → Air scrubber (Billing & Costs, P4): HEPA is for HEPA vacuums.')
       WHERE e.equipment_type::text = 'hepa'
      RETURNING e.id, e.asset_tag)
    SELECT count(public.money_audit_write('catalog', 'equipment', m.asset_tag, 'equipment_type',
                   to_jsonb('hepa'::text), to_jsonb('air_scrubber'::text)))::int FROM m
  $q$ INTO moved;
  RAISE NOTICE 'HEPA units moved to Air scrubber: %.', moved;
  PERFORM set_config('gsr.money_note', '', true);
END;
$$;

-- Injector, ozone and hydroxyl become types (P4 answer 3).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
              WHERE n.nspname = 'public' AND t.typname = 'equipment_type') THEN
    ALTER TYPE public.equipment_type ADD VALUE IF NOT EXISTS 'injector';
    ALTER TYPE public.equipment_type ADD VALUE IF NOT EXISTS 'ozone';
    ALTER TYPE public.equipment_type ADD VALUE IF NOT EXISTS 'hydroxyl';
  END IF;
END;
$$;
INSERT INTO public.equipment_types (key, label, sort_order) VALUES
  ('injector', 'Injector', 90),
  ('ozone', 'Ozone machine', 100),
  ('hydroxyl', 'Hydroxyl generator', 110)
ON CONFLICT (key) DO NOTHING;

DO $$
DECLARE
  day_rates jsonb;
BEGIN
  SELECT value->'day_rates' INTO day_rates FROM public.app_settings WHERE key = 'equipment_day_rates';
  IF day_rates IS NULL THEN RETURN; END IF;
  PERFORM set_config('gsr.money_note', 'Carried over from the field-ticket day card (20261101120000)', true);
  INSERT INTO public.money_values (book, item_key, measure, office_id, effective_from, value, note)
  SELECT 'cost', 'EQ:' || k, 'cost_rate', NULL, DATE '2000-01-01', (day_rates->>k)::numeric,
         'Carried over from the field-ticket day card'
    FROM unnest(ARRAY['injector', 'ozone', 'hydroxyl']) AS k
   WHERE day_rates ? k AND (day_rates->>k) ~ '^[0-9]+(\.[0-9]+)?$'
     AND NOT EXISTS (SELECT 1 FROM public.money_values v
                      WHERE v.book = 'cost' AND v.item_key = 'EQ:' || k
                        AND v.measure = 'cost_rate' AND v.office_id IS NULL);
  PERFORM set_config('gsr.money_note', '', true);
END;
$$;


-- ======================================================= 1. agreements' shape

-- Writing agreements and Standard: owner and admin only (P4 spec).
CREATE OR REPLACE FUNCTION public.can_manage_agreements(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles ur
                  WHERE ur.user_id = _user_id AND ur.role::text IN ('owner', 'admin'));
$$;
REVOKE ALL ON FUNCTION public.can_manage_agreements(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_manage_agreements(uuid) TO authenticated, service_role;

-- Who sets a job's rate source and its own lines: the office, never sales.
CREATE OR REPLACE FUNCTION public.can_set_job_rates(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles ur
                  WHERE ur.user_id = _user_id
                    AND ur.role::text IN ('owner', 'admin', 'dev', 'regional', 'location_manager', 'office'));
$$;
REVOKE ALL ON FUNCTION public.can_set_job_rates(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_set_job_rates(uuid) TO authenticated, service_role;

ALTER TABLE public.price_lists
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'agreement',
  ADD COLUMN IF NOT EXISTS effective_from date,
  ADD COLUMN IF NOT EXISTS note text,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS full_copy boolean NOT NULL DEFAULT false;
DO $$ BEGIN
  ALTER TABLE public.price_lists ADD CONSTRAINT price_lists_kind_known
    CHECK (kind IN ('agreement', 'office', 'state'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
COMMENT ON COLUMN public.price_lists.kind IS
  'agreement = a client agreement (exceptions over Standard); office = a former branch list, its prices moved into Standard (20261101120000), kept read-only; state = a state rate list.';

ALTER TABLE public.price_list_assignments
  ADD COLUMN IF NOT EXISTS is_primary boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.price_list_assignments.is_primary IS
  'A client on several agreements: the one a new job starts on.';

-- Classify the lists that exist.
UPDATE public.price_lists pl SET kind = 'office'
 WHERE kind = 'agreement'
   AND EXISTS (SELECT 1 FROM public.price_list_assignments a WHERE a.price_list_id = pl.id AND a.location_id IS NOT NULL)
   AND NOT EXISTS (SELECT 1 FROM public.price_list_assignments a WHERE a.price_list_id = pl.id AND a.account_id IS NOT NULL);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'price_list_assignments'
                AND column_name = 'state_code') THEN
    EXECUTE $q$
      UPDATE public.price_lists pl SET kind = 'state'
       WHERE kind = 'agreement'
         AND EXISTS (SELECT 1 FROM public.price_list_assignments a WHERE a.price_list_id = pl.id AND a.state_code IS NOT NULL)
         AND NOT EXISTS (SELECT 1 FROM public.price_list_assignments a WHERE a.price_list_id = pl.id AND a.account_id IS NOT NULL)
    $q$;
  END IF;
END $$;
UPDATE public.price_lists pl
   SET effective_from = coalesce(
         (SELECT min(a.effective_from) FROM public.price_list_assignments a WHERE a.price_list_id = pl.id),
         pl.created_at::date)
 WHERE effective_from IS NULL;
-- A list that restates (nearly) the whole catalog: it stays full until edited.
UPDATE public.price_lists pl SET full_copy = true
 WHERE (SELECT count(*) FROM public.price_list_items i WHERE i.price_list_id = pl.id)
       >= greatest(1, 0.9 * (SELECT count(*) FROM public.estimate_catalog_items c WHERE c.is_active));
-- Each client's newest agreement is its primary.
UPDATE public.price_list_assignments a SET is_primary = true
 WHERE a.account_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.price_list_assignments p
                    WHERE p.account_id = a.account_id AND p.is_primary)
   AND a.id = (SELECT a2.id FROM public.price_list_assignments a2
                WHERE a2.account_id = a.account_id
                ORDER BY a2.effective_from DESC, a2.created_at DESC, a2.id DESC LIMIT 1);

-- Duplicate names are refused from now on (existing ones are reported).
CREATE OR REPLACE FUNCTION public.tg_price_lists_before()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.archived_at IS NULL AND (TG_OP = 'INSERT' OR NEW.name IS DISTINCT FROM OLD.name
                                   OR OLD.archived_at IS NOT NULL)
     AND EXISTS (SELECT 1 FROM public.price_lists p
                  WHERE p.id <> NEW.id AND p.archived_at IS NULL
                    AND lower(btrim(p.name)) = lower(btrim(NEW.name))) THEN
    RAISE EXCEPTION 'There is already an agreement called %.', btrim(NEW.name) USING ERRCODE = '23505';
  END IF;
  NEW.effective_from := coalesce(NEW.effective_from, current_date);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_price_lists_before() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS price_lists_before ON public.price_lists;
CREATE TRIGGER price_lists_before BEFORE INSERT OR UPDATE ON public.price_lists
  FOR EACH ROW EXECUTE FUNCTION public.tg_price_lists_before();

-- Writes: owner and admin only, on top of the existing policies.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['price_lists', 'price_list_items', 'price_list_assignments'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS agreements_owner_admin_insert ON public.%I', t);
    EXECUTE format('CREATE POLICY agreements_owner_admin_insert ON public.%I AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (public.can_manage_agreements((SELECT auth.uid())))', t);
    EXECUTE format('DROP POLICY IF EXISTS agreements_owner_admin_update ON public.%I', t);
    EXECUTE format('CREATE POLICY agreements_owner_admin_update ON public.%I AS RESTRICTIVE FOR UPDATE TO authenticated USING (public.can_manage_agreements((SELECT auth.uid())))', t);
    EXECUTE format('DROP POLICY IF EXISTS agreements_owner_admin_delete ON public.%I', t);
    EXECUTE format('CREATE POLICY agreements_owner_admin_delete ON public.%I AS RESTRICTIVE FOR DELETE TO authenticated USING (public.can_manage_agreements((SELECT auth.uid())))', t);
  END LOOP;
END $$;

-- Every agreement change is in the money audit log (book client_agreements).
CREATE OR REPLACE FUNCTION public.tg_agreements_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  code text;
BEGIN
  IF TG_TABLE_NAME = 'price_list_items' THEN
    SELECT c.code INTO code FROM public.estimate_catalog_items c
     WHERE c.id = coalesce(NEW.catalog_item_id, OLD.catalog_item_id);
    PERFORM public.money_audit_write('client_agreements', 'agreement_line',
      coalesce(NEW.price_list_id, OLD.price_list_id)::text || ':' || coalesce(code, '?'), 'unit_price',
      CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD.unit_price) END,
      CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW.unit_price) END);
  ELSIF TG_TABLE_NAME = 'price_list_assignments' THEN
    PERFORM public.money_audit_write('client_agreements', 'agreement_client',
      coalesce(NEW.price_list_id, OLD.price_list_id)::text, 'applies_to',
      CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE jsonb_build_object(
        'account_id', OLD.account_id, 'location_id', OLD.location_id,
        'effective_from', OLD.effective_from, 'effective_to', OLD.effective_to, 'primary', OLD.is_primary) END,
      CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE jsonb_build_object(
        'account_id', NEW.account_id, 'location_id', NEW.location_id,
        'effective_from', NEW.effective_from, 'effective_to', NEW.effective_to, 'primary', NEW.is_primary) END);
  ELSE
    IF TG_OP = 'INSERT' THEN
      PERFORM public.money_audit_write('client_agreements', 'agreement', NEW.id::text, 'created', NULL,
        jsonb_build_object('name', NEW.name, 'kind', NEW.kind, 'effective_from', NEW.effective_from));
    ELSIF TG_OP = 'UPDATE' THEN
      IF NEW.name IS DISTINCT FROM OLD.name THEN
        PERFORM public.money_audit_write('client_agreements', 'agreement', NEW.id::text, 'name',
          to_jsonb(OLD.name), to_jsonb(NEW.name));
      END IF;
      IF NEW.effective_from IS DISTINCT FROM OLD.effective_from THEN
        PERFORM public.money_audit_write('client_agreements', 'agreement', NEW.id::text, 'effective_from',
          to_jsonb(OLD.effective_from), to_jsonb(NEW.effective_from));
      END IF;
      IF (NEW.archived_at IS NULL) IS DISTINCT FROM (OLD.archived_at IS NULL)
         OR NEW.is_active IS DISTINCT FROM OLD.is_active THEN
        PERFORM public.money_audit_write('client_agreements', 'agreement', NEW.id::text, 'archived',
          to_jsonb(OLD.archived_at IS NOT NULL OR NOT OLD.is_active),
          to_jsonb(NEW.archived_at IS NOT NULL OR NOT NEW.is_active));
      END IF;
    END IF;
  END IF;
  RETURN coalesce(NEW, OLD);
END;
$$;
REVOKE ALL ON FUNCTION public.tg_agreements_audit() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS price_lists_audit ON public.price_lists;
CREATE TRIGGER price_lists_audit AFTER INSERT OR UPDATE ON public.price_lists
  FOR EACH ROW EXECUTE FUNCTION public.tg_agreements_audit();
DROP TRIGGER IF EXISTS price_list_items_audit ON public.price_list_items;
CREATE TRIGGER price_list_items_audit AFTER INSERT OR UPDATE OR DELETE ON public.price_list_items
  FOR EACH ROW EXECUTE FUNCTION public.tg_agreements_audit();
DROP TRIGGER IF EXISTS price_list_assignments_audit ON public.price_list_assignments;
CREATE TRIGGER price_list_assignments_audit AFTER INSERT OR UPDATE OR DELETE ON public.price_list_assignments
  FOR EACH ROW EXECUTE FUNCTION public.tg_agreements_audit();

-- ======================================================= 2. Standard rates

-- A client agreement's audit entries and Standard values are charge prices:
-- administrators read the log (P3 policy); every staff member reads the values.

DO $$
DECLARE
  bad integer;
  offices integer;
  dups integer;
BEGIN
  PERFORM set_config('gsr.money_note', 'Standard rates carried over (20261101120000)', true);

  -- The company default: each item's catalog default price.
  INSERT INTO public.money_values (book, item_key, measure, office_id, effective_from, value, note)
  SELECT 'client_agreements', c.code, 'unit_price', NULL, DATE '2000-01-01', c.default_unit_price,
         'Carried over from the catalog default price'
    FROM public.estimate_catalog_items c
   WHERE NOT EXISTS (SELECT 1 FROM public.money_values v
                      WHERE v.book = 'client_agreements' AND v.item_key = c.code
                        AND v.measure = 'unit_price' AND v.office_id IS NULL);

  -- Each office's own prices: the branch list in force for it today, from
  -- the day it took effect, and any branch list that starts later.
  INSERT INTO public.money_values (book, item_key, measure, office_id, effective_from, value, note)
  SELECT DISTINCT ON (w.location_id, c.code, w.effective_from)
         'client_agreements', c.code, 'unit_price', w.location_id, w.effective_from, i.unit_price,
         'Carried over from the branch price list "' || pl.name || '"'
    FROM (
      SELECT a.* FROM public.price_list_assignments a
       WHERE a.location_id IS NOT NULL
         AND (a.effective_to IS NULL OR a.effective_to >= current_date)
         AND (a.effective_from > current_date
              OR a.id = (SELECT a2.id FROM public.price_list_assignments a2
                          WHERE a2.location_id = a.location_id
                            AND a2.effective_from <= current_date
                            AND (a2.effective_to IS NULL OR a2.effective_to >= current_date)
                          ORDER BY a2.effective_from DESC, a2.created_at DESC, a2.id DESC LIMIT 1))
    ) w
    JOIN public.price_lists pl ON pl.id = w.price_list_id
    JOIN public.price_list_items i ON i.price_list_id = w.price_list_id
    JOIN public.estimate_catalog_items c ON c.id = i.catalog_item_id
   WHERE NOT EXISTS (SELECT 1 FROM public.money_values v
                      WHERE v.book = 'client_agreements' AND v.item_key = c.code
                        AND v.measure = 'unit_price' AND v.office_id = w.location_id
                        AND v.effective_from = w.effective_from)
   ORDER BY w.location_id, c.code, w.effective_from, w.created_at DESC;
  -- A branch list that ends: the office goes back to the company default.
  INSERT INTO public.money_values (book, item_key, measure, office_id, effective_from, value, note)
  SELECT DISTINCT 'client_agreements', c.code, 'unit_price', a.location_id, a.effective_to + 1, NULL::numeric,
         'Carried over: branch price list ended'
    FROM public.price_list_assignments a
    JOIN public.price_list_items i ON i.price_list_id = a.price_list_id
    JOIN public.estimate_catalog_items c ON c.id = i.catalog_item_id
   WHERE a.location_id IS NOT NULL AND a.effective_to IS NOT NULL AND a.effective_to >= current_date
     AND NOT EXISTS (SELECT 1 FROM public.price_list_assignments a2
                      WHERE a2.location_id = a.location_id AND a2.id <> a.id
                        AND a2.effective_from > a.effective_from AND a2.effective_from <= a.effective_to + 1)
     AND NOT EXISTS (SELECT 1 FROM public.money_values v
                      WHERE v.book = 'client_agreements' AND v.item_key = c.code
                        AND v.measure = 'unit_price' AND v.office_id = a.location_id
                        AND v.effective_from = a.effective_to + 1);

  -- Today every office resolves every item to what it paid before: its
  -- branch list's price, else the catalog default.
  SELECT count(*) INTO bad
    FROM public.locations l
    CROSS JOIN public.estimate_catalog_items c
    LEFT JOIN LATERAL (
      SELECT i.unit_price FROM public.price_list_assignments a
        JOIN public.price_list_items i ON i.price_list_id = a.price_list_id AND i.catalog_item_id = c.id
       WHERE a.location_id = l.id AND a.effective_from <= current_date
         AND (a.effective_to IS NULL OR a.effective_to >= current_date)
         AND a.id = (SELECT a2.id FROM public.price_list_assignments a2
                      WHERE a2.location_id = l.id AND a2.effective_from <= current_date
                        AND (a2.effective_to IS NULL OR a2.effective_to >= current_date)
                      ORDER BY a2.effective_from DESC, a2.created_at DESC, a2.id DESC LIMIT 1)
    ) old ON true
   WHERE (SELECT r.value FROM public.resolve_money_value('client_agreements', c.code, 'unit_price', l.id, current_date) r)
         IS DISTINCT FROM coalesce(old.unit_price, c.default_unit_price);
  IF bad > 0 THEN
    RAISE EXCEPTION 'Standard rates seed mismatch: % office × item prices differ from before.', bad;
  END IF;
  SELECT count(DISTINCT office_id) INTO offices FROM public.money_values
   WHERE book = 'client_agreements' AND office_id IS NOT NULL;
  SELECT count(*) INTO dups FROM (
    SELECT lower(btrim(name)) FROM public.price_lists WHERE archived_at IS NULL GROUP BY 1 HAVING count(*) > 1) d;
  RAISE NOTICE 'Standard rates: % items at the company default; % office(s) with their own prices. Lists: % agreements, % office (now Standard), % state. % duplicate agreement name(s) on file.',
    (SELECT count(*) FROM public.estimate_catalog_items), offices,
    (SELECT count(*) FROM public.price_lists WHERE kind = 'agreement'),
    (SELECT count(*) FROM public.price_lists WHERE kind = 'office'),
    (SELECT count(*) FROM public.price_lists WHERE kind = 'state'), dups;
  PERFORM set_config('gsr.money_note', '', true);
END;
$$;

COMMENT ON COLUMN public.estimate_catalog_items.default_unit_price IS
  'Mirror of the Standard company default (money_values book client_agreements, office NULL) since 20261101120000; written by standard_save, never edited directly.';

/*
 * Standard's one Save (owner/admin): { code, office_id, value } — value null
 * on an office = back to the company default. Takes effect today (documents
 * and the catalog default read today's Standard). A company-default change
 * also updates the catalog item's default price, which other readers use.
 */
CREATE OR REPLACE FUNCTION public.standard_save(_changes jsonb, _note text DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c jsonb;
  n integer := 0;
  office uuid;
  v numeric;
BEGIN
  IF NOT public.can_manage_agreements(auth.uid()) THEN
    RAISE EXCEPTION 'Only an owner or admin can change Standard rates.' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(_changes) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Nothing to save.' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('gsr.money_note', coalesce(btrim(_note), ''), true);
  FOR c IN SELECT * FROM jsonb_array_elements(_changes) LOOP
    office := nullif(c->>'office_id', '')::uuid;
    v := CASE WHEN jsonb_typeof(c->'value') = 'number' THEN (c->>'value')::numeric END;
    IF NOT EXISTS (SELECT 1 FROM public.estimate_catalog_items WHERE code = c->>'code') THEN
      RAISE EXCEPTION 'No catalog item %.', c->>'code' USING ERRCODE = 'P0002';
    END IF;
    IF v IS NULL AND office IS NULL THEN
      RAISE EXCEPTION 'The Standard price of % needs a value.', c->>'code' USING ERRCODE = '22023';
    END IF;
    IF v IS NOT NULL AND (v < 0 OR v <> round(v, 2)) THEN
      RAISE EXCEPTION 'Prices are dollars and cents, 0 or more (% for %).', v, c->>'code' USING ERRCODE = '22023';
    END IF;
    DELETE FROM public.money_values mv
     WHERE mv.book = 'client_agreements' AND mv.item_key = c->>'code' AND mv.measure = 'unit_price'
       AND mv.office_id IS NOT DISTINCT FROM office AND mv.effective_from = current_date;
    INSERT INTO public.money_values (book, item_key, measure, office_id, effective_from, value, note)
    VALUES ('client_agreements', c->>'code', 'unit_price', office, current_date, v, nullif(btrim(_note), ''));
    IF office IS NULL THEN
      UPDATE public.estimate_catalog_items SET default_unit_price = v WHERE code = c->>'code';
    END IF;
    n := n + 1;
  END LOOP;
  RETURN n;
END;
$$;
REVOKE ALL ON FUNCTION public.standard_save(jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.standard_save(jsonb, text) TO authenticated, service_role;

-- ======================================================= 3. jobs' rates

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS rate_source text,
  ADD COLUMN IF NOT EXISTS rate_agreement_id uuid REFERENCES public.price_lists(id) ON DELETE RESTRICT;
DO $$ BEGIN
  ALTER TABLE public.jobs ADD CONSTRAINT jobs_rate_source_known
    CHECK (rate_source IS NULL OR rate_source IN ('agreement', 'standard', 'custom'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
COMMENT ON COLUMN public.jobs.rate_source IS
  'Regular pricing for this job: agreement (the client''s, or rate_agreement_id), standard, or custom (its own lines in job_regular_rates). NULL = the client''s default.';

CREATE TABLE IF NOT EXISTS public.job_regular_rates (
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  catalog_item_id uuid NOT NULL REFERENCES public.estimate_catalog_items(id) ON DELETE CASCADE,
  unit_price numeric(12,2) NOT NULL CHECK (unit_price >= 0),
  -- Where the frozen price came from: account / location / state / default; custom = typed for this job.
  source text NOT NULL,
  price_list_id uuid REFERENCES public.price_lists(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid DEFAULT auth.uid(),
  PRIMARY KEY (job_id, catalog_item_id)
);
COMMENT ON TABLE public.job_regular_rates IS
  'A regular job''s rate sheet: frozen at creation from regular_price_book(), plus its own custom lines. Jobs made before 20261101120000 have none and resolve live.';
ALTER TABLE public.job_regular_rates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.job_regular_rates FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.job_regular_rates TO authenticated;
GRANT ALL ON public.job_regular_rates TO service_role;
DROP POLICY IF EXISTS job_regular_rates_read ON public.job_regular_rates;
CREATE POLICY job_regular_rates_read ON public.job_regular_rates
  FOR SELECT TO authenticated USING (public.can_view_job((SELECT auth.uid()), job_id));
DROP POLICY IF EXISTS active_profile_required ON public.job_regular_rates;
CREATE POLICY active_profile_required ON public.job_regular_rates
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT goldstar_private.profile_is_active(auth.uid())))
  WITH CHECK ((SELECT goldstar_private.profile_is_active(auth.uid())));

-- ======================================================= 4. the resolver

/*
 * What every catalog item is charged on one regular document, most specific
 * first: the job's own line (frozen or custom) → the client agreement (the
 * job's chosen one, else the client's primary/newest in force) → the
 * office's Standard price → a state list → the company Standard price.
 * Nothing at all → price NULL, source 'none' (the screen says "set rate").
 * _standard skips the agreement (a job on Standard).
 */
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
BEGIN
  IF _job_id IS NOT NULL THEN
    SELECT jb.rate_source, jb.rate_agreement_id INTO job_source, job_agreement FROM public.jobs jb
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
  RETURN QUERY
  SELECT c.id, c.code,
         CASE WHEN jr.unit_price IS NOT NULL THEN jr.unit_price
              WHEN ai.unit_price IS NOT NULL THEN ai.unit_price
              WHEN so.source = 'office' THEN so.value
              WHEN si.unit_price IS NOT NULL THEN si.unit_price
              ELSE so.value END,
         CASE WHEN jr.unit_price IS NOT NULL THEN CASE WHEN jr.source = 'custom' THEN 'custom' ELSE 'job' END
              WHEN ai.unit_price IS NOT NULL THEN 'account'
              WHEN so.source = 'office' THEN 'location'
              WHEN si.unit_price IS NOT NULL THEN 'state'
              WHEN so.value IS NOT NULL THEN 'default'
              ELSE 'none' END,
         CASE WHEN jr.unit_price IS NOT NULL THEN jr.price_list_id
              WHEN ai.unit_price IS NOT NULL THEN agr
              WHEN so.source = 'office' THEN NULL
              WHEN si.unit_price IS NOT NULL THEN st END
    FROM public.estimate_catalog_items c
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

-- A job's frozen sheet, (re)built from a source at a date. Internal.
CREATE OR REPLACE FUNCTION public.job_regular_rates_snapshot(_job_id uuid, _on date)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  j record;
  n integer;
BEGIN
  SELECT * INTO j FROM public.jobs WHERE id = _job_id;
  DELETE FROM public.job_regular_rates WHERE job_id = _job_id AND source <> 'custom';
  INSERT INTO public.job_regular_rates (job_id, catalog_item_id, unit_price, source, price_list_id)
  SELECT _job_id, b.catalog_item_id, b.unit_price, b.source, b.price_list_id
    FROM public.regular_price_book(NULL, j.account_id, coalesce(j.billing_location_id, j.location_id),
           j.region, _on, j.rate_agreement_id, coalesce(j.rate_source, '') = 'standard') b
   WHERE b.unit_price IS NOT NULL
  ON CONFLICT (job_id, catalog_item_id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;
REVOKE ALL ON FUNCTION public.job_regular_rates_snapshot(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_regular_rates_snapshot(uuid, date) TO service_role;

-- New regular jobs freeze their rates the day they are made (T&M jobs bill
-- at T&M rates; their regular sheet is never read).
CREATE OR REPLACE FUNCTION public.tg_jobs_snapshot_regular_rates()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF coalesce(NEW.job_type, '') <> 't_m' THEN
    PERFORM public.job_regular_rates_snapshot(NEW.id, current_date);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_jobs_snapshot_regular_rates() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS jobs_snapshot_regular_rates ON public.jobs;
CREATE TRIGGER jobs_snapshot_regular_rates AFTER INSERT ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.tg_jobs_snapshot_regular_rates();

/*
 * The job's rate source (office and managers; never sales):
 *   { source: 'agreement', agreement_id? } | { source: 'standard' } | { source: 'custom' }
 * Choosing agreement or Standard rebuilds the job's sheet from it as of today
 * (its custom lines go: the job now follows that source). Custom keeps the
 * sheet and lets lines be typed.
 */
CREATE OR REPLACE FUNCTION public.job_rate_source_set(_job_id uuid, _source text, _agreement_id uuid DEFAULT NULL, _note text DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  old record;
  n integer := 0;
BEGIN
  IF NOT public.can_set_job_rates(auth.uid()) OR NOT public.can_view_job(auth.uid(), _job_id) THEN
    RAISE EXCEPTION 'Only the office or a manager sets a job''s rates.' USING ERRCODE = '42501';
  END IF;
  IF _source NOT IN ('agreement', 'standard', 'custom') THEN
    RAISE EXCEPTION 'A job''s rates come from an agreement, Standard, or custom.' USING ERRCODE = '22023';
  END IF;
  SELECT rate_source, rate_agreement_id, account_id INTO old FROM public.jobs WHERE id = _job_id;
  IF _source = 'agreement' AND _agreement_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.price_list_assignments a JOIN public.price_lists pl ON pl.id = a.price_list_id
        WHERE a.price_list_id = _agreement_id AND a.account_id = old.account_id AND pl.kind = 'agreement') THEN
    RAISE EXCEPTION 'That agreement is not one of this client''s.' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('gsr.money_note', coalesce(btrim(_note), ''), true);
  UPDATE public.jobs SET rate_source = _source,
         rate_agreement_id = CASE WHEN _source = 'agreement' THEN _agreement_id END
   WHERE id = _job_id;
  IF _source <> 'custom' THEN
    DELETE FROM public.job_regular_rates WHERE job_id = _job_id;
    n := public.job_regular_rates_snapshot(_job_id, current_date);
  END IF;
  PERFORM public.money_audit_write('client_agreements', 'job_rates', _job_id::text, 'rate_source',
    jsonb_build_object('source', old.rate_source, 'agreement_id', old.rate_agreement_id),
    jsonb_build_object('source', _source, 'agreement_id', _agreement_id));
  RETURN n;
END;
$$;
REVOKE ALL ON FUNCTION public.job_rate_source_set(uuid, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.job_rate_source_set(uuid, text, uuid, text) TO authenticated, service_role;

-- One custom line for this job only (null = drop it; the job's source prices it again).
CREATE OR REPLACE FUNCTION public.job_rate_line_set(_job_id uuid, _catalog_item_id uuid, _price numeric, _note text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  before numeric;
  code text;
BEGIN
  IF NOT public.can_set_job_rates(auth.uid()) OR NOT public.can_view_job(auth.uid(), _job_id) THEN
    RAISE EXCEPTION 'Only the office or a manager sets a job''s rates.' USING ERRCODE = '42501';
  END IF;
  IF _price IS NOT NULL AND (_price < 0 OR _price <> round(_price, 2)) THEN
    RAISE EXCEPTION 'Prices are dollars and cents, 0 or more.' USING ERRCODE = '22023';
  END IF;
  SELECT unit_price INTO before FROM public.job_regular_rates
   WHERE job_id = _job_id AND catalog_item_id = _catalog_item_id;
  SELECT c.code INTO code FROM public.estimate_catalog_items c WHERE c.id = _catalog_item_id;
  PERFORM set_config('gsr.money_note', coalesce(btrim(_note), ''), true);
  IF _price IS NULL THEN
    DELETE FROM public.job_regular_rates WHERE job_id = _job_id AND catalog_item_id = _catalog_item_id;
  ELSE
    INSERT INTO public.job_regular_rates (job_id, catalog_item_id, unit_price, source)
    VALUES (_job_id, _catalog_item_id, _price, 'custom')
    ON CONFLICT (job_id, catalog_item_id)
      DO UPDATE SET unit_price = EXCLUDED.unit_price, source = 'custom', price_list_id = NULL,
                    updated_at = now(), updated_by = auth.uid();
    UPDATE public.jobs SET rate_source = 'custom' WHERE id = _job_id;
  END IF;
  PERFORM public.money_audit_write('client_agreements', 'job_rates', _job_id::text || ':' || coalesce(code, '?'),
    'unit_price', to_jsonb(before), to_jsonb(_price));
END;
$$;
REVOKE ALL ON FUNCTION public.job_rate_line_set(uuid, uuid, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.job_rate_line_set(uuid, uuid, numeric, text) TO authenticated, service_role;

/*
 * The Client Agreements tab's Save (owner/admin), all or nothing, one note:
 *   { op: 'create', name, effective_from?, note? }            → the new id is used by later ops as "new"
 *   { op: 'rename', agreement_id, name } | { op: 'archive', agreement_id }
 *   { op: 'line', agreement_id, code, value }                 value null = back to Standard
 *   { op: 'link', agreement_id, account_id, effective_from?, primary? }
 *   { op: 'unlink', assignment_id, effective_to? }            ends it (yesterday by default), never deletes
 *   { op: 'from_job', job_id, name }                          a job's custom lines as a standing agreement
 * agreement_id "new" refers to the agreement created earlier in the same save.
 */
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

/* How many of a client's jobs bill T&M — the attach-time note. */
CREATE OR REPLACE FUNCTION public.account_job_mix(_account_ids uuid[])
RETURNS TABLE (account_id uuid, jobs integer, tm_jobs integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT j.account_id, count(*)::int, count(*) FILTER (WHERE j.job_type = 't_m')::int
    FROM public.jobs j
   WHERE j.account_id = ANY(_account_ids)
     AND public.can_manage_agreements(auth.uid())
   GROUP BY j.account_id;
$$;
REVOKE ALL ON FUNCTION public.account_job_mix(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.account_job_mix(uuid[]) TO authenticated, service_role;


-- ======================================== 5. the Estimate catalog → Catalogs

-- Two more categories, for regular items the T&M book has no place for.
ALTER TABLE public.catalog_items DROP CONSTRAINT IF EXISTS catalog_items_category_check;
ALTER TABLE public.catalog_items DROP CONSTRAINT IF EXISTS catalog_items_category_known;
ALTER TABLE public.catalog_items ADD CONSTRAINT catalog_items_category_known
  CHECK (category IN ('labor', 'consumable', 'ppe', 'vehicle', 'equipment', 'service'));
ALTER TABLE public.catalog_items DROP CONSTRAINT IF EXISTS catalog_items_unit_fits_category;
ALTER TABLE public.catalog_items ADD CONSTRAINT catalog_items_unit_fits_category CHECK (
  unit IS NULL
  OR (category = 'labor' AND unit IN ('hr', 'day'))
  OR (category = 'consumable' AND unit IN ('piece', 'roll', 'box', 'pair', 'gal', 'sqft'))
  OR (category = 'ppe' AND unit IN ('piece', 'box', 'pair', 'day'))
  OR (category = 'vehicle' AND unit IN ('day', 'hr'))
  OR category IN ('equipment', 'service')
);
ALTER TABLE public.catalog_items DROP CONSTRAINT IF EXISTS catalog_items_labor_class_known;
ALTER TABLE public.catalog_items ADD CONSTRAINT catalog_items_labor_class_known
  CHECK (labor_class IS NULL OR (category = 'labor' AND labor_class IN ('field', 'management')));

-- Which books an item is in: the T&M sheet (mirrored to tm_rate_codes) and
-- regular pricing (mirrored to estimate_catalog_items, which estimate and
-- invoice lines point at).
ALTER TABLE public.catalog_items
  ADD COLUMN IF NOT EXISTS in_tm boolean,
  ADD COLUMN IF NOT EXISTS in_regular boolean,
  ADD COLUMN IF NOT EXISTS estimate_item_id uuid UNIQUE REFERENCES public.estimate_catalog_items(id);
UPDATE public.catalog_items SET in_tm = true WHERE in_tm IS NULL;
UPDATE public.catalog_items SET in_regular = false WHERE in_regular IS NULL;

CREATE OR REPLACE FUNCTION public.tg_catalog_items_books()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.in_tm := coalesce(NEW.in_tm, NEW.category IN ('labor', 'consumable', 'ppe', 'vehicle'));
    NEW.in_regular := coalesce(NEW.in_regular, NEW.category IN ('equipment', 'service')
                                               OR NEW.estimate_item_id IS NOT NULL);
  END IF;
  IF NEW.category IN ('equipment', 'service') THEN NEW.in_tm := false; END IF;
  IF NEW.estimate_item_id IS NOT NULL THEN NEW.in_regular := true; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_catalog_items_books() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS catalog_items_books ON public.catalog_items;
CREATE TRIGGER catalog_items_books BEFORE INSERT OR UPDATE ON public.catalog_items
  FOR EACH ROW EXECUTE FUNCTION public.tg_catalog_items_books();

-- The T&M mirror only carries T&M items (P1/P2 trigger, now guarded).
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
  IF NOT coalesce(NEW.in_tm, true) THEN
    RETURN NEW;
  END IF;
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

CREATE OR REPLACE FUNCTION public.catalog_unit_to_uom(_unit text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE _unit WHEN 'hr' THEN 'HR' WHEN 'day' THEN 'DAY' WHEN 'piece' THEN 'EA'
                    WHEN 'roll' THEN 'RL' WHEN 'box' THEN 'BX' WHEN 'pair' THEN 'PR'
                    WHEN 'gal' THEN 'GAL' WHEN 'sqft' THEN 'SF' ELSE 'EA' END;
$$;
REVOKE ALL ON FUNCTION public.catalog_unit_to_uom(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.catalog_unit_to_uom(text) TO authenticated, service_role;

-- Regular items edited in Catalogs reach their estimate row (and a new one
-- gets one), so the estimate and invoice pickers keep working unchanged.
CREATE OR REPLACE FUNCTION public.tg_catalog_items_to_estimate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  live boolean := NEW.active AND NEW.archived_at IS NULL;
BEGIN
  IF NOT coalesce(NEW.in_regular, false)
     OR coalesce(current_setting('gsr.catalog_from_estimate', true), '') = 'on' THEN
    RETURN NEW;
  END IF;
  IF NEW.estimate_item_id IS NULL THEN
    INSERT INTO public.estimate_catalog_items (code, name, uom, default_unit_price, is_active, sort_order)
    VALUES (NEW.code, NEW.name, public.catalog_unit_to_uom(NEW.unit), 0, live, NEW.sort_order)
    ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
    RETURNING id INTO NEW.estimate_item_id;
  ELSE
    UPDATE public.estimate_catalog_items e
       SET name = NEW.name, is_active = live
     WHERE e.id = NEW.estimate_item_id
       AND (e.name IS DISTINCT FROM NEW.name OR e.is_active IS DISTINCT FROM live);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_catalog_items_to_estimate() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS catalog_items_to_estimate ON public.catalog_items;
CREATE TRIGGER catalog_items_to_estimate BEFORE INSERT OR UPDATE ON public.catalog_items
  FOR EACH ROW EXECUTE FUNCTION public.tg_catalog_items_to_estimate();

-- Why an estimate item did not merge cleanly, for a person to look at.
CREATE TABLE IF NOT EXISTS public.catalog_merge_review (
  estimate_item_id uuid PRIMARY KEY REFERENCES public.estimate_catalog_items(id),
  code text NOT NULL,
  name text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.catalog_merge_review ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.catalog_merge_review FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.catalog_merge_review TO authenticated;
GRANT ALL ON public.catalog_merge_review TO service_role;
DROP POLICY IF EXISTS catalog_merge_review_read ON public.catalog_merge_review;
CREATE POLICY catalog_merge_review_read ON public.catalog_merge_review
  FOR SELECT TO authenticated USING (public.is_privileged((SELECT auth.uid())));

DO $$
DECLARE
  e record;
  hdr text;
  cat text;
  u text;
  review text;
  new_code text;
  matches text[];
  by_code integer := 0;
  by_name integer := 0;
  added integer := 0;
  flagged integer := 0;
  total integer;
  price_diffs integer;
BEGIN
  PERFORM set_config('gsr.money_note', 'Estimate catalog merged into Catalogs (20261101120000)', true);
  PERFORM set_config('gsr.catalog_from_estimate', 'on', true);
  SELECT count(*) INTO total FROM public.estimate_catalog_items;
  FOR e IN SELECT c.*, h.name AS header_name, h.code AS header_code
             FROM public.estimate_catalog_items c
             LEFT JOIN public.estimate_headers h ON h.id = c.header_id
            WHERE NOT EXISTS (SELECT 1 FROM public.catalog_items ci WHERE ci.estimate_item_id = c.id)
              AND NOT EXISTS (SELECT 1 FROM public.catalog_merge_review r WHERE r.estimate_item_id = c.id)
            ORDER BY c.sort_order, c.code
  LOOP
    -- 1. The same code: one item.
    IF EXISTS (SELECT 1 FROM public.catalog_items ci WHERE ci.code = upper(btrim(e.code)) AND ci.estimate_item_id IS NULL) THEN
      UPDATE public.catalog_items SET estimate_item_id = e.id WHERE code = upper(btrim(e.code));
      by_code := by_code + 1;
      CONTINUE;
    END IF;
    -- 2. The same name: one item; two or more: a person decides.
    SELECT array_agg(ci.code) INTO matches FROM public.catalog_items ci
     WHERE ci.estimate_item_id IS NULL
       AND lower(regexp_replace(btrim(ci.name), '\s+', ' ', 'g')) = lower(regexp_replace(btrim(e.name), '\s+', ' ', 'g'));
    IF array_length(matches, 1) = 1 THEN
      UPDATE public.catalog_items SET estimate_item_id = e.id WHERE code = matches[1];
      by_name := by_name + 1;
      CONTINUE;
    ELSIF array_length(matches, 1) > 1 THEN
      INSERT INTO public.catalog_merge_review VALUES (e.id, e.code, e.name,
        'Same name as ' || array_to_string(matches, ', ') || ' — which one is it?');
      flagged := flagged + 1;
      CONTINUE;
    END IF;
    -- 3. New: a category from its header and unit.
    hdr := lower(coalesce(e.header_name, '') || ' ' || coalesce(e.header_code, ''));
    u := upper(btrim(e.uom));
    cat := CASE
      WHEN e.code ~* '^GSC-EQ-' OR hdr ~ 'equip' THEN 'equipment'
      WHEN u IN ('HR', 'HRS', 'HOUR', 'HOURS') AND (hdr ~ 'labo' OR e.name ~* 'labo|technician|crew|supervisor') THEN 'labor'
      WHEN hdr ~ 'ppe' THEN 'ppe'
      WHEN hdr ~ 'consum|material|suppl' THEN 'consumable'
      ELSE 'service' END;
    review := NULL;
    new_code := upper(btrim(e.code));
    IF new_code !~ '^[A-Z0-9][A-Z0-9-]{0,23}$' THEN
      INSERT INTO public.catalog_merge_review VALUES (e.id, e.code, e.name,
        'Its code cannot be a catalog code (letters, digits and dashes, up to 24) — give it one.');
      flagged := flagged + 1;
      CONTINUE;
    END IF;
    BEGIN
      INSERT INTO public.catalog_items (code, name, category, unit, unit_review, active, sort_order,
                                        source_book, source_key, estimate_item_id, in_tm, in_regular)
      VALUES (new_code, e.name, cat,
        CASE WHEN cat = 'labor' THEN CASE WHEN u IN ('DAY', 'DY') THEN 'day' ELSE 'hr' END
             ELSE CASE u WHEN 'EA' THEN 'piece' WHEN 'EACH' THEN 'piece' WHEN 'UNIT' THEN 'piece'
                         WHEN 'HR' THEN 'hr' WHEN 'HRS' THEN 'hr' WHEN 'HOUR' THEN 'hr'
                         WHEN 'DAY' THEN 'day' WHEN 'DY' THEN 'day' WHEN 'SF' THEN 'sqft' WHEN 'SQFT' THEN 'sqft'
                         WHEN 'GAL' THEN 'gal' WHEN 'RL' THEN 'roll' WHEN 'ROLL' THEN 'roll'
                         WHEN 'BX' THEN 'box' WHEN 'BOX' THEN 'box' WHEN 'PR' THEN 'pair' WHEN 'PAIR' THEN 'pair'
                         END END,
        CASE WHEN cat <> 'labor' AND u NOT IN ('EA', 'EACH', 'UNIT', 'HR', 'HRS', 'HOUR', 'DAY', 'DY', 'SF', 'SQFT',
                                               'GAL', 'RL', 'ROLL', 'BX', 'BOX', 'PR', 'PAIR')
             THEN format('The estimate unit %s has no catalog unit yet — choose one.', e.uom) END,
        e.is_active, e.sort_order, 'estimate_catalog_items', e.code, e.id, false, true);
      added := added + 1;
    EXCEPTION WHEN unique_violation OR check_violation THEN
      INSERT INTO public.catalog_merge_review VALUES (e.id, e.code, e.name,
        'Could not be added: ' || SQLERRM);
      flagged := flagged + 1;
    END;
  END LOOP;
  PERFORM set_config('gsr.catalog_from_estimate', 'off', true);

  IF (SELECT count(*) FROM public.catalog_items WHERE estimate_item_id IS NOT NULL)
     + (SELECT count(*) FROM public.catalog_merge_review) <> total THEN
    RAISE EXCEPTION 'Catalog merge count mismatch: % estimate items, % merged, % flagged.', total,
      (SELECT count(*) FROM public.catalog_items WHERE estimate_item_id IS NOT NULL),
      (SELECT count(*) FROM public.catalog_merge_review);
  END IF;
  -- Duplicates whose estimate price differs from their T&M rate (reported,
  -- never merged into a third price: estimates read Standard, T&M reads T&M).
  SELECT count(*) INTO price_diffs
    FROM public.catalog_items ci
    JOIN public.estimate_catalog_items ec ON ec.id = ci.estimate_item_id
    LEFT JOIN LATERAL public.resolve_money_value('tm_rates', ci.code, 'bill_rate', NULL, current_date) r ON true
   WHERE ci.in_tm AND r.value IS NOT NULL AND r.value <> ec.default_unit_price;
  RAISE NOTICE 'Estimate catalog merge: % items — % linked by code, % linked by name, % added, % flagged for review (catalog_merge_review). % linked items price differently in Standard and T&M.',
    total, by_code, by_name, added, flagged, price_diffs;
  PERFORM set_config('gsr.money_note', '', true);
END;
$$;

COMMENT ON TABLE public.estimate_catalog_items IS
  'Kept since 20261101120000 as the rows estimate and invoice lines point at; edited through Billing & Costs › Catalogs (catalog_items mirrors onto it) and priced by Standard rates and client agreements. The old Estimate catalog page redirects.';

-- Labor class belongs to T&M labor only (a regular-only labor line has no
-- engine-computed cost).
CREATE OR REPLACE FUNCTION public.tg_catalog_items_labor_class()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.category = 'labor' AND coalesce(NEW.in_tm, true) AND NEW.labor_class IS NULL THEN
    NEW.labor_class := 'field';
  ELSIF NEW.category <> 'labor' OR NOT coalesce(NEW.in_tm, true) THEN
    NEW.labor_class := NULL;
  END IF;
  RETURN NEW;
END;
$$;

-- Equipment day costs may carry fractions of a cent (P4 answer 4).
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
