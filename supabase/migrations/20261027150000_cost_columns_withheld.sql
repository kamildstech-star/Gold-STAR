-- WRITTEN, NOT APPLIED. Apply by hand after review (TM8).
--
-- Put the supply catalogue's and the equipment register's internal cost
-- behind the database, not behind a page.
--
-- THE FINDING: three columns that say what something COSTS Gold Star were
-- readable by every signed-in user, sellers included:
--
--   · supply_items.unit_cost — policy supply_items_read is USING (true) and
--     the CREATE TABLE grant (20260818173022) is table-wide, so one PostgREST
--     call (`supply_items?select=name,unit_cost`) gave anyone the cost of
--     every consumable.
--   · equipment.daily_rate_cents and equipment.purchase_cost_cents — policy
--     equipment_select (20260731002107) admits anyone who can view the
--     unit's office, again with a table-wide grant.
--
-- IS daily_rate_cents A COST OR A CHARGE? A COST. 20260918131000 seeds it
-- with "THESE ARE COSTS — what GSR pays per day — NOT charge rates";
-- job_running_cost() multiplies it by days on site as equipment_cost; the
-- Cost rates screen lists it as what a unit costs per day. What a customer is
-- charged for equipment comes from the T&M rate codes and the price lists
-- (the T&M bill, the invoice "Pull from job" / "From ledger" pull); none of
-- them reads this column — src/lib/invoice-pull.test.ts asserts the pull
-- panel never names it. So it is withheld with the other two.
--
-- THE DESIGN — the repo's existing column-withholding shape, exactly as
-- estimate_catalog_items (20260909090000), the document lines
-- (20260909100000) and job_calculations (20260909110000):
--
--   1. REVOKE the table-wide SELECT from `authenticated` (and `anon`).
--   2. GRANT SELECT on every OTHER column back to `authenticated`. Row
--      visibility (the policies) is unchanged.
--   3. Expose the cost only through SECURITY DEFINER functions gated on
--      `job.view_costs` — the capability the UI gates money on
--      (useCan("job.view_costs")) and that no seller role can hold
--      (20261027130000):
--        · supply_item_costs()       → (id, unit_cost) for every item
--        · equipment_costs(_ids)     → (id, daily_rate_cents,
--          purchase_cost_cents) for units the caller can already see
--          (equipment_select's own rule) AND holds job.view_costs at the
--          unit's office.
--      Both return an EMPTY set, never an error, for anyone else.
--   4. add_equipment_from_scan() handed back purchase_cost_cents of ANY
--      existing unit — across every office — to anyone who scanned its
--      plate. It now returns NULL in that column (the signature is kept so
--      the client contract is unchanged; the client no longer reads it).
--
-- The running-cost engine (job_running_cost, running_cost_overview) is
-- SECURITY DEFINER and keeps reading the columns; it already decides itself
-- who sees cost. Writes are untouched: INSERT / UPDATE grants stay, and the
-- row policies (supply_items_manage, equipment_insert / equipment_update)
-- still decide who may set a cost.
--
-- HAZARD — `select("*")` NOW FAILS on both tables. Postgres answers a query
-- touching an ungranted column with "permission denied for table …", naming
-- the table. Every client reader selects explicit columns; the lists live in
-- src/lib/cost-columns.ts (SUPPLY_ITEM_PUBLIC_COLUMNS,
-- EQUIPMENT_PUBLIC_COLUMNS) and src/lib/cost-columns.columns.test.ts pins
-- them to this file. EVERY future migration that adds a column to either
-- table must GRANT SELECT on it explicitly.
--
-- Re-runnable: REVOKE / GRANT are idempotent, functions are CREATE OR
-- REPLACE, the guard below only reads. Nothing is dropped, RLS stays on.

-- ---------------------------------------------------------------------------
-- 0. Guard: the column lists below must cover every column of each table.
--    A column in neither list would be silently unreadable after the revoke
--    and fail every reader of the table; better to stop here and say which.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(column_name, ', ' ORDER BY column_name) INTO v_missing
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'supply_items'
    AND column_name <> ALL (ARRAY[
      'id', 'name', 'unit', 'category', 'is_active', 'sort_order', 'created_by',
      'created_at', 'updated_at', 'sku', 'default_supplier', 'size',
      'default_vendor_id', 'unit_cost'
    ]);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'supply_items has columns this migration does not list: %', v_missing;
  END IF;

  SELECT string_agg(column_name, ', ' ORDER BY column_name) INTO v_missing
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'equipment'
    AND column_name <> ALL (ARRAY[
      'id', 'asset_tag', 'equipment_type', 'make', 'model', 'serial_number',
      'purchase_date', 'location_id', 'status', 'external_tracker_id', 'notes',
      'created_by', 'created_at', 'updated_at', 'is_demo', 'equipment_type_detail',
      'tracker_provider', 'last_lat', 'last_lon', 'last_seen_at',
      'tracker_battery_pct', 'tracker_heartbeat_status', 'tracker_location_status',
      'tracker_location_name', 'tracker_address', 'tracker_synced_at',
      'created_via', 'created_job_id', 'daily_rate_cents', 'purchase_cost_cents'
    ]);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'equipment has columns this migration does not list: %', v_missing;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 1. supply_items: everything but unit_cost.
-- ---------------------------------------------------------------------------
REVOKE SELECT ON public.supply_items FROM authenticated;
-- anon held nothing it used (the policies are TO authenticated); nothing is
-- granted back to it.
REVOKE SELECT ON public.supply_items FROM anon;

-- Keep this list in step with SUPPLY_ITEM_PUBLIC_COLUMNS in src/lib/cost-columns.ts.
GRANT SELECT (
  id,
  name,
  unit,
  category,
  is_active,
  sort_order,
  created_by,
  created_at,
  updated_at,
  sku,
  default_supplier,
  size,
  default_vendor_id
) ON public.supply_items TO authenticated;

COMMENT ON COLUMN public.supply_items.unit_cost IS
  'What one unit costs Gold Star. NOT readable by the authenticated role: read it via supply_item_costs(). Naming this column in a client SELECT (including select *) fails with "permission denied for table supply_items". See 20261027150000_cost_columns_withheld.sql.';

-- ---------------------------------------------------------------------------
-- 2. equipment: everything but daily_rate_cents and purchase_cost_cents.
-- ---------------------------------------------------------------------------
REVOKE SELECT ON public.equipment FROM authenticated;
REVOKE SELECT ON public.equipment FROM anon;

-- Keep this list in step with EQUIPMENT_PUBLIC_COLUMNS in src/lib/cost-columns.ts.
GRANT SELECT (
  id,
  asset_tag,
  equipment_type,
  make,
  model,
  serial_number,
  purchase_date,
  location_id,
  status,
  external_tracker_id,
  notes,
  created_by,
  created_at,
  updated_at,
  is_demo,
  equipment_type_detail,
  tracker_provider,
  last_lat,
  last_lon,
  last_seen_at,
  tracker_battery_pct,
  tracker_heartbeat_status,
  tracker_location_status,
  tracker_location_name,
  tracker_address,
  tracker_synced_at,
  created_via,
  created_job_id
) ON public.equipment TO authenticated;

COMMENT ON COLUMN public.equipment.daily_rate_cents IS
  'What the unit COSTS Gold Star per day on a job (the running cost multiplies it by days on site) — not a charge rate. NOT readable by the authenticated role: read it via equipment_costs(). See 20261027150000_cost_columns_withheld.sql.';
COMMENT ON COLUMN public.equipment.purchase_cost_cents IS
  'What the unit cost to buy. NOT readable by the authenticated role: read it via equipment_costs(). See 20261027150000_cost_columns_withheld.sql.';

-- ---------------------------------------------------------------------------
-- 3. Cost, for the people allowed to see cost.
-- ---------------------------------------------------------------------------

-- Every catalogue item's unit cost, for job.view_costs holders; an empty set
-- for everyone else. No location: the catalogue is company-wide, so this is
-- role defaults plus unscoped grants minus revokes — the same check
-- estimate_catalog_item_costs() makes.
CREATE OR REPLACE FUNCTION public.supply_item_costs()
RETURNS TABLE (id uuid, unit_cost numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT si.id, si.unit_cost
  FROM public.supply_items si
  WHERE public.has_permission(auth.uid(), 'job.view_costs', NULL);
$$;

COMMENT ON FUNCTION public.supply_item_costs() IS
  'Unit cost per supply item, only for callers holding job.view_costs; empty set for everyone else. The column itself is not SELECT-granted to authenticated — see 20261027150000_cost_columns_withheld.sql.';

REVOKE ALL ON FUNCTION public.supply_item_costs() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.supply_item_costs() TO authenticated, service_role;

-- Each unit's daily cost rate and purchase cost. A unit is answered only when
-- the caller could already read its row (equipment_select: created it, or can
-- view its office) AND holds job.view_costs at the unit's office. _ids NULL =
-- every such unit. Empty set, never an error, for anyone else.
CREATE OR REPLACE FUNCTION public.equipment_costs(_ids uuid[] DEFAULT NULL)
RETURNS TABLE (id uuid, daily_rate_cents integer, purchase_cost_cents integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT e.id, e.daily_rate_cents, e.purchase_cost_cents
  FROM public.equipment e
  WHERE (_ids IS NULL OR e.id = ANY (_ids))
    AND (e.created_by = auth.uid() OR public.can_view_location(auth.uid(), e.location_id))
    AND public.has_permission(auth.uid(), 'job.view_costs', e.location_id);
$$;

COMMENT ON FUNCTION public.equipment_costs(uuid[]) IS
  'Daily cost rate and purchase cost per equipment unit, only for units the caller can see and only when the caller holds job.view_costs at the unit''s office; empty set otherwise. The columns are not SELECT-granted to authenticated — see 20261027150000_cost_columns_withheld.sql.';

REVOKE ALL ON FUNCTION public.equipment_costs(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.equipment_costs(uuid[]) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. A scan no longer hands back a purchase cost.
--
-- Body as 20261026160000, with purchase_cost_cents returned as NULL in both
-- branches. The 'existing' branch looks across the WHOLE register, other
-- offices included, so it would otherwise have been a cost oracle for anyone
-- holding a phone camera. Signature and return shape unchanged.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.add_equipment_from_scan(
  _tag text,
  _equipment_type text,
  _location_id uuid,
  _notes text DEFAULT NULL,
  _via text DEFAULT NULL,
  _job_id uuid DEFAULT NULL
)
RETURNS TABLE (
  outcome text,
  id uuid,
  asset_tag text,
  equipment_type text,
  status public.equipment_status,
  location_id uuid,
  purchase_cost_cents integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_uid uuid := auth.uid();
  v_tag text;
  v_key text;
  v_type text;
  v_existing public.equipment%ROWTYPE;
  v_new public.equipment%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  -- The scanner's cleaning (cleanAssetTag) and plate shape (TAG_SHAPE).
  v_tag := upper(btrim(coalesce(_tag, '')));
  v_tag := regexp_replace(v_tag, '[‐-―−_[:space:]]+', '-', 'g');
  v_tag := regexp_replace(v_tag, '-{2,}', '-', 'g');
  v_tag := regexp_replace(v_tag, '^-|-$', '', 'g');
  v_key := regexp_replace(v_tag, '[^A-Z0-9]', '', 'g');
  IF length(v_key) < 3 OR length(v_key) > 32 THEN
    RAISE EXCEPTION 'not_a_tag: %', left(coalesce(_tag, ''), 40) USING ERRCODE = '22023';
  END IF;

  -- One add per plate at a time, whoever is scanning it.
  PERFORM pg_advisory_xact_lock(hashtext('equipment_tag:' || v_key));

  SELECT e.* INTO v_existing
    FROM public.equipment e
   WHERE upper(regexp_replace(e.asset_tag, '[^A-Za-z0-9]', '', 'g')) = v_key
   ORDER BY (e.asset_tag = v_tag) DESC, e.created_at
   LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT 'existing'::text, v_existing.id, v_existing.asset_tag,
      v_existing.equipment_type, v_existing.status, v_existing.location_id,
      NULL::integer;
    RETURN;
  END IF;

  -- Nothing registered under it: only a plate-shaped tag may become a unit.
  IF v_tag !~ '^[A-Z]{2,5}-[A-Z]{0,4}[0-9]{1,8}-[A-Z]{2,3}[0-9]?$' THEN
    RAISE EXCEPTION 'not_a_tag: %', left(coalesce(_tag, ''), 40) USING ERRCODE = '22023';
  END IF;

  IF _location_id IS NULL OR NOT public.can_manage_location(v_uid, _location_id) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  v_type := nullif(btrim(coalesce(_equipment_type, '')), '');
  IF v_type IS NULL OR length(v_type) > 40 THEN
    v_type := 'other';
  END IF;

  INSERT INTO public.equipment
    (asset_tag, equipment_type, location_id, status, notes, created_by, created_via, created_job_id)
  VALUES
    (v_tag, v_type, _location_id, 'available', nullif(btrim(coalesce(_notes, '')), ''),
     v_uid, left(nullif(btrim(coalesce(_via, '')), ''), 40), _job_id)
  RETURNING * INTO v_new;

  RETURN QUERY SELECT 'created'::text, v_new.id, v_new.asset_tag, v_new.equipment_type,
    v_new.status, v_new.location_id, NULL::integer;
END;
$$;

REVOKE ALL ON FUNCTION public.add_equipment_from_scan(text, text, uuid, text, text, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_equipment_from_scan(text, text, uuid, text, text, uuid)
  TO authenticated, service_role;
