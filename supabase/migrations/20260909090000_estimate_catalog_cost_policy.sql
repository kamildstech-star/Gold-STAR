-- Put the catalog's cost basis behind the database, not behind a page.
--
-- THE FINDING: public.estimate_catalog_items carries default_unit_price (what
-- the customer is charged) AND default_cost (what the item costs Gold Star).
-- Its SELECT policy is `USING (true)` for `authenticated` and the table-level
-- SELECT grant covers every column, so every signed-in user — a crew member, a
-- cold caller — could read the company's cost on all 34 catalog items with one
-- PostgREST call. The Job Calculator and the catalog admin screen hide the
-- Cost column with `useCan("job.view_costs")`, but that is a UI gate: the data
-- was always one `select=default_cost` away.
--
-- THE DESIGN: "everyone reads the row, only some read a column" is a
-- COLUMN-level grant, exactly the shape public.profiles has used since
-- 20260821175812:
--
--   1. REVOKE the table-wide SELECT from `authenticated`.
--   2. GRANT SELECT on every column EXCEPT default_cost back to `authenticated`.
--      Sales reps and office staff keep names, codes, units and
--      default_unit_price, which is all the Job Calculator needs from them.
--   3. Expose default_cost only through estimate_catalog_item_costs(), a
--      SECURITY DEFINER function that answers solely for holders of
--      `job.view_costs` — the SAME capability the UI already gates money on
--      (useCan("job.view_costs") in the client, has_permission() in SQL). No
--      new role or permission is invented here.
--
-- The SELECT policy itself is left as `USING (true)`: row visibility is still
-- "every signed-in user sees every catalog row". Only the column changes.
--
-- HAZARD — `select("*")` NOW FAILS. With column-level grants Postgres answers
-- a query that touches an ungranted column with "permission denied for table
-- estimate_catalog_items", naming the table, not the column. That is exactly
-- what took profiles down on 20260907 (see
-- 20260907120000_profiles_missing_column_grants.sql). Two rules follow:
--   - Every client reader of this table must select explicit columns. The
--     list lives in src/lib/estimates.ts (CATALOG_ITEM_PUBLIC_COLUMNS) and a
--     test pins it.
--   - EVERY future migration that adds a column to this table must GRANT
--     SELECT on it explicitly. There is no table-level grant to inherit from.
--
-- Re-runnable: REVOKE/GRANT are idempotent and the function is CREATE OR
-- REPLACE. Nothing is dropped, RLS stays enabled, no other table is touched.

-- 1. Drop the table-wide read.
REVOKE SELECT ON public.estimate_catalog_items FROM authenticated;

-- `anon` also held table-wide SELECT from the original CREATE TABLE grant. It
-- never saw a row (both policies are TO authenticated) but there is no reason
-- for the cost column to be nominally readable by an unauthenticated role.
-- Nothing is granted back to anon: no anonymous path reads the catalog.
REVOKE SELECT ON public.estimate_catalog_items FROM anon;

-- 2. Hand back every column that is not the cost basis. Keep this list in
-- step with CATALOG_ITEM_PUBLIC_COLUMNS in src/lib/estimates.ts.
GRANT SELECT (
  id,
  header_id,
  code,
  name,
  description,
  uom,
  default_unit_price,
  taxable,
  is_active,
  sort_order,
  is_demo,
  created_at,
  updated_at,
  short_name
) ON public.estimate_catalog_items TO authenticated;

-- INSERT / UPDATE / DELETE grants are untouched: writes were already limited
-- to admin/owner/dev by the estimate_catalog_items_write policy
-- (is_privileged(auth.uid())).

-- 3. Cost, for the people allowed to see cost.
--
-- Returns (id, default_cost) for every catalog row when the caller holds
-- job.view_costs, and an EMPTY set otherwise — never an error — so a screen
-- can degrade to "cost hidden" instead of failing. The permission check uses
-- has_permission() with no location, i.e. role defaults plus unscoped grants
-- minus revokes. A grant scoped to one location will show costs in the UI
-- (effective_permissions() ignores scope) but not here; that mismatch errs
-- on the side of hiding.
CREATE OR REPLACE FUNCTION public.estimate_catalog_item_costs()
RETURNS TABLE (id uuid, default_cost numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT ci.id, ci.default_cost
  FROM public.estimate_catalog_items ci
  WHERE public.has_permission(auth.uid(), 'job.view_costs', NULL);
$$;

COMMENT ON FUNCTION public.estimate_catalog_item_costs() IS
  'Cost basis (default_cost) per catalog item, only for callers holding job.view_costs; empty set for everyone else. The column itself is not SELECT-granted to authenticated — see 20260909090000_estimate_catalog_cost_policy.sql.';

COMMENT ON COLUMN public.estimate_catalog_items.default_cost IS
  'What the item costs Gold Star. NOT readable by the authenticated role: read it via estimate_catalog_item_costs(). Naming this column in a client SELECT (including select *) fails with "permission denied for table estimate_catalog_items".';

-- SECURITY DEFINER functions are executable by PUBLIC by default; take that
-- away and grant only what the app uses. Supabase's ALTER DEFAULT PRIVILEGES
-- also hands `anon` an explicit EXECUTE at CREATE time, which the PUBLIC
-- revoke does not touch (verified in production: proacl carried anon=X), so
-- anon is revoked by name too.
REVOKE ALL ON FUNCTION public.estimate_catalog_item_costs() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.estimate_catalog_item_costs() FROM anon;
GRANT EXECUTE ON FUNCTION public.estimate_catalog_item_costs() TO authenticated;
GRANT EXECUTE ON FUNCTION public.estimate_catalog_item_costs() TO service_role;
