-- Put the cost basis on document lines behind the database, not behind a page.
--
-- THE FINDING: 20260909090000_estimate_catalog_cost_policy withheld
-- estimate_catalog_items.default_cost from every signed-in user. The same
-- number is copied onto every line of every estimate and invoice as
-- estimate_lines.unit_cost / invoice_lines.unit_cost, and BOTH tables still
-- carried a table-wide SELECT grant for `authenticated`. The row policies
-- (estimate_lines_all / invoice_lines_all, FOR ALL) let anyone read a line
-- who can read its parent document; estimates_select / invoices_select admit
-- a job.view_costs holder, the document's creator, and the account's
-- assigned sales rep. So a sales rep — precisely the person the catalog fix
-- was about — could still read the company's cost on every line of their
-- own accounts' estimates with one PostgREST call.
--
-- THE SECOND FINDING: the same catalog fix made a rep's "add catalog line"
-- write unit_cost = 0, because the client can no longer see the catalog cost
-- to copy. Every margin figure on such a job would be wrong until someone
-- with the privilege re-typed the cost. The fill has to happen server-side.
--
-- THE DESIGN, the same shape as the catalog and as public.profiles:
--
--   1. A SECURITY DEFINER BEFORE INSERT trigger on both line tables copies
--      default_cost from the catalog whenever catalog_item_id is set and the
--      cost arrives as 0 or null. Definer context is what lets it read the
--      withheld column. A non-zero unit_cost is never overwritten: someone
--      typed it on purpose. It also runs BEFORE UPDATE OF catalog_item_id,
--      and only then — re-pointing a still-uncosted line to a catalog item
--      should cost it, but a holder patching unit_cost to 0 ("free") must
--      stay 0, and an ordinary quantity/price edit must not touch cost.
--   2. REVOKE the table-wide SELECT from `authenticated` (and `anon`) and
--      GRANT SELECT on every column EXCEPT unit_cost back to `authenticated`.
--      Row visibility is unchanged; only the column is withheld.
--   3. Expose unit_cost only through estimate_line_costs(_estimate_id) and
--      invoice_line_costs(_invoice_id): SECURITY DEFINER functions that
--      answer solely for holders of `job.view_costs` at the document's
--      location — the SAME capability estimates_select / invoices_select
--      already test, and the one the UI gates every money surface on — and
--      only for lines whose parent the caller could see through the line
--      policy anyway (can_view_location OR created_by). Empty set, never an
--      error, for everyone else.
--   4. Backfill the lines written between the catalog fix and this one.
--
-- HAZARD — `select("*")` NOW FAILS on estimate_lines and invoice_lines. With
-- column-level grants Postgres answers a query that touches an ungranted
-- column with "permission denied for table estimate_lines", naming the
-- table, not the column — what took profiles down on 20260907. Two rules:
--   - Every client reader of these tables selects explicit columns. The
--     lists live in src/lib/line-costs.ts (ESTIMATE_LINE_PUBLIC_COLUMNS,
--     INVOICE_LINE_PUBLIC_COLUMNS) and a test pins them.
--   - EVERY future migration that adds a column to either table must GRANT
--     SELECT on it explicitly. There is no table-level grant to inherit.
--
-- Not touched: INSERT / UPDATE / DELETE grants (writing a cost is not a
-- leak, and the row policies still govern who may write), the row policies
-- themselves, service_role and sandbox_exec (server roles that bypass RLS),
-- and estimate_scope_template_lines, which carries its own unit_cost and is
-- noted as a follow-up.
--
-- Re-runnable: CREATE OR REPLACE throughout, REVOKE/GRANT are idempotent,
-- the backfill is bounded to the damage window and only ever writes where
-- the cost is still 0. Nothing is dropped, RLS stays enabled.

-- ---------------------------------------------------------------------------
-- 1. Server-side fill from the catalog.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fill_line_cost_from_catalog()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cost numeric;
BEGIN
  -- Ad hoc line: nothing to copy from.
  IF NEW.catalog_item_id IS NULL THEN
    RETURN NEW;
  END IF;
  -- A cost someone typed (or that an earlier fill produced) stands.
  IF COALESCE(NEW.unit_cost, 0) <> 0 THEN
    RETURN NEW;
  END IF;
  -- On UPDATE only a change of catalog item re-costs the line; a quantity or
  -- price edit on a deliberately zero-cost catalog line must leave it at 0.
  IF TG_OP = 'UPDATE' AND NEW.catalog_item_id IS NOT DISTINCT FROM OLD.catalog_item_id THEN
    RETURN NEW;
  END IF;

  SELECT ci.default_cost INTO v_cost
  FROM public.estimate_catalog_items ci
  WHERE ci.id = NEW.catalog_item_id;

  IF FOUND THEN
    NEW.unit_cost := COALESCE(v_cost, 0);
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.fill_line_cost_from_catalog() IS
  'BEFORE INSERT / BEFORE UPDATE OF catalog_item_id on estimate_lines and invoice_lines: copies estimate_catalog_items.default_cost into unit_cost when the line names a catalog item and its cost is 0 or null. Never overwrites a non-zero cost. Runs as definer so it may read the withheld catalog column. See 20260909100000_line_cost_policy.sql.';

-- A trigger function is invoked by the trigger, never by a caller; nobody
-- needs EXECUTE on it.
REVOKE ALL ON FUNCTION public.fill_line_cost_from_catalog() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fill_line_cost_from_catalog() FROM anon;
REVOKE EXECUTE ON FUNCTION public.fill_line_cost_from_catalog() FROM authenticated;

CREATE OR REPLACE TRIGGER estimate_lines_fill_cost
  BEFORE INSERT OR UPDATE OF catalog_item_id ON public.estimate_lines
  FOR EACH ROW EXECUTE FUNCTION public.fill_line_cost_from_catalog();

CREATE OR REPLACE TRIGGER invoice_lines_fill_cost
  BEFORE INSERT OR UPDATE OF catalog_item_id ON public.invoice_lines
  FOR EACH ROW EXECUTE FUNCTION public.fill_line_cost_from_catalog();

-- ---------------------------------------------------------------------------
-- 2. Column-level SELECT: everything but the cost.
-- ---------------------------------------------------------------------------
REVOKE SELECT ON public.estimate_lines FROM authenticated;
REVOKE SELECT ON public.invoice_lines FROM authenticated;

-- `anon` held table-wide SELECT from the original CREATE TABLE grants. Both
-- policies are TO authenticated so it never saw a row; nothing is granted
-- back, as no anonymous path reads document lines.
REVOKE SELECT ON public.estimate_lines FROM anon;
REVOKE SELECT ON public.invoice_lines FROM anon;

-- Keep these lists in step with ESTIMATE_LINE_PUBLIC_COLUMNS and
-- INVOICE_LINE_PUBLIC_COLUMNS in src/lib/line-costs.ts.
GRANT SELECT (
  id,
  estimate_id,
  scope_id,
  catalog_item_id,
  position,
  code,
  name,
  short_name,
  description,
  uom,
  quantity,
  unit_price,
  taxable,
  is_discount,
  note,
  subtotal,
  created_at,
  updated_at
) ON public.estimate_lines TO authenticated;

GRANT SELECT (
  id,
  invoice_id,
  scope_id,
  catalog_item_id,
  position,
  code,
  name,
  description,
  uom,
  quantity,
  unit_price,
  taxable,
  is_discount,
  note,
  subtotal,
  created_at,
  updated_at
) ON public.invoice_lines TO authenticated;

COMMENT ON COLUMN public.estimate_lines.unit_cost IS
  'What the line costs Gold Star. NOT readable by the authenticated role: read it via estimate_line_costs(_estimate_id). Naming this column in a client SELECT (including select *) fails with "permission denied for table estimate_lines". Filled from the catalog by estimate_lines_fill_cost when a catalog line arrives with cost 0.';

COMMENT ON COLUMN public.invoice_lines.unit_cost IS
  'What the line costs Gold Star. NOT readable by the authenticated role: read it via invoice_line_costs(_invoice_id). Naming this column in a client SELECT (including select *) fails with "permission denied for table invoice_lines". Filled from the catalog by invoice_lines_fill_cost when a catalog line arrives with cost 0.';

-- ---------------------------------------------------------------------------
-- 3. Cost, for the people allowed to see cost, on the lines they can see.
-- ---------------------------------------------------------------------------
--
-- Row scope is the line policy's own test (can_view_location OR created_by
-- on the parent document) AND has_permission(job.view_costs) at the
-- document's location — the form estimates_select / invoices_select already
-- use, so a grant scoped to that branch counts here as it does there. A
-- holder cannot read costs on a document they could not open.
CREATE OR REPLACE FUNCTION public.estimate_line_costs(_estimate_id uuid)
RETURNS TABLE (line_id uuid, unit_cost numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT l.id, l.unit_cost
  FROM public.estimate_lines l
  JOIN public.estimates e ON e.id = l.estimate_id
  WHERE l.estimate_id = _estimate_id
    AND (public.can_view_location(auth.uid(), e.location_id) OR e.created_by = auth.uid())
    AND public.has_permission(auth.uid(), 'job.view_costs', e.location_id);
$$;

CREATE OR REPLACE FUNCTION public.invoice_line_costs(_invoice_id uuid)
RETURNS TABLE (line_id uuid, unit_cost numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT l.id, l.unit_cost
  FROM public.invoice_lines l
  JOIN public.invoices i ON i.id = l.invoice_id
  WHERE l.invoice_id = _invoice_id
    AND (public.can_view_location(auth.uid(), i.location_id) OR i.created_by = auth.uid())
    AND public.has_permission(auth.uid(), 'job.view_costs', i.location_id);
$$;

COMMENT ON FUNCTION public.estimate_line_costs(uuid) IS
  'Cost basis (unit_cost) per line of one estimate, only for callers holding job.view_costs at the estimate''s location who can see the estimate; empty set for everyone else. The column itself is not SELECT-granted to authenticated — see 20260909100000_line_cost_policy.sql.';

COMMENT ON FUNCTION public.invoice_line_costs(uuid) IS
  'Cost basis (unit_cost) per line of one invoice, only for callers holding job.view_costs at the invoice''s location who can see the invoice; empty set for everyone else. The column itself is not SELECT-granted to authenticated — see 20260909100000_line_cost_policy.sql.';

-- SECURITY DEFINER functions are executable by PUBLIC by default, and
-- Supabase's ALTER DEFAULT PRIVILEGES hands `anon` an explicit EXECUTE at
-- CREATE time that the PUBLIC revoke does not touch (verified on the catalog
-- function: proacl carried anon=X). Revoke both, grant only what the app uses.
REVOKE ALL ON FUNCTION public.estimate_line_costs(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.estimate_line_costs(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.estimate_line_costs(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.estimate_line_costs(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.invoice_line_costs(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.invoice_line_costs(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.invoice_line_costs(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.invoice_line_costs(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 4. Backfill the damage window.
-- ---------------------------------------------------------------------------
--
-- Between the catalog fix going live (PR #71 merged 2026-09-09 05:35 UTC) and
-- this trigger, a catalog line added by someone without job.view_costs was
-- written with unit_cost = 0. Fill those, and only those, from the catalog.
-- Bounded to that window on purpose: an older catalog line at 0 may be a
-- cost a holder typed as 0 deliberately. Lines with no catalog item have
-- nothing to fill from and are not touched. The AFTER triggers recompute the
-- document totals, which do not depend on cost; updated_at is bumped.
DO $$
DECLARE
  n_est int;
  n_inv int;
BEGIN
  UPDATE public.estimate_lines l
     SET unit_cost = ci.default_cost
    FROM public.estimate_catalog_items ci
   WHERE ci.id = l.catalog_item_id
     AND COALESCE(l.unit_cost, 0) = 0
     AND COALESCE(ci.default_cost, 0) <> 0
     AND l.created_at >= '2026-09-09T05:35:42Z';
  GET DIAGNOSTICS n_est = ROW_COUNT;

  UPDATE public.invoice_lines l
     SET unit_cost = ci.default_cost
    FROM public.estimate_catalog_items ci
   WHERE ci.id = l.catalog_item_id
     AND COALESCE(l.unit_cost, 0) = 0
     AND COALESCE(ci.default_cost, 0) <> 0
     AND l.created_at >= '2026-09-09T05:35:42Z';
  GET DIAGNOSTICS n_inv = ROW_COUNT;

  RAISE NOTICE 'line_cost_policy backfill: % estimate_lines, % invoice_lines', n_est, n_inv;
END;
$$;
