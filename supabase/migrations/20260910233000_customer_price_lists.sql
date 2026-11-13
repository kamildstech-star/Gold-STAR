-- Price lists: the customer agreement and the state rate, on top of the
-- default catalog.
--
-- WHAT DAVID ASKED FOR, on the call:
--   "You're charging a daily rate over here. You see the unit price is $95 ...
--    but what's if I have different clients that I have different pricing
--    with? Let's say Falcon has a price that I'm charging them only $80 and
--    everyone else in charging 95 ... There's a default price list, right? And
--    then I have customers that I have an agreement with ... Different states,
--    you know, if one state, let's say New York and California, I charge for
--    labor $70 versus Jersey. I can charge $65 ... There's a default across
--    the board. But when you select certain clients, those clients override
--    the default."
--
-- THE MODEL. The default price list ALREADY EXISTS: it is
-- public.estimate_catalog_items.default_unit_price, the number the estimate
-- line picker copies onto a line today. Nothing here duplicates it. What is
-- added is a thin override layer:
--
--   price_lists              a named list — "Falcon 2026", "New Jersey rates"
--   price_list_items         (list, catalog item) -> the price on that list
--   price_list_assignments   who the list applies to: an ACCOUNT or a
--                            LOCATION, effective-dated
--
-- Resolution, per catalog item, is customer -> location -> default, and lives
-- in ONE pure function (`buildPriceBook` / `resolvePrice`, src/lib/price-lists.ts)
-- that the tests point at. Fall-through is PER ITEM, not per list: Falcon's
-- agreement covers the four lines that were negotiated, and every other line
-- on their estimate still comes off the default catalog. A list that had to
-- restate all 34 catalog items to change one of them is a list nobody would
-- keep current.
--
-- WHY ASSIGNMENTS ARE THEIR OWN TABLE rather than an account_id column on the
-- list: one negotiated sheet routinely covers a group of accounts (Falcon and
-- Falcon East), and the same sheet can be the standing rate for a branch. A
-- column would force a copy of the list per customer, and a copy is a list
-- that drifts.
--
-- WHY NOT labour_rates. public.labour_rates is effective-dated per role and
-- per location already, and it looks like the answer to the "different states"
-- half. It is not. labour_rates.hourly_rate is what a crew member COSTS us —
-- job_labour_summary multiplies it by minutes through rate_for() to produce
-- labour_cost, and its RLS is "rates visible to managers only"
-- (is_privileged OR can_view_finance). David's "$70 in New York versus $65 in
-- Jersey" is what he CHARGES, a sell price on an estimate line, and the people
-- who need it are the estimators that policy deliberately hides labour_rates
-- from. Putting a charge rate in the cost table would either leak our wage
-- basis to every estimator or hide the charge rate from them. Location pricing
-- belongs here, beside the other sell prices.
--
-- COST IS NOT IN THIS FILE. estimate_catalog_items has column-level SELECT
-- grants (20260909090000) precisely so `default_cost` cannot be read by
-- someone without job.view_costs, and estimate_lines/invoice_lines the same
-- (20260909100000). A price list carries NO cost column at all — a customer's
-- agreed sell price says nothing about our margin — so there is nothing here
-- to withhold and no column-level grant to maintain. Anyone adding a cost
-- column to these tables inherits the whole of 20260909090000: revoke the
-- table grant, grant every other column by name, and expose cost through a
-- SECURITY DEFINER function gated on job.view_costs.
--
-- WHAT HAPPENS TO LINES ALREADY WRITTEN: nothing, ever. estimate_lines and
-- invoice_lines store `unit_price` as a value, snapshotted when the line was
-- added, exactly as they always have. Resolution runs at the moment a line is
-- created and never again — there is deliberately no trigger, view or
-- generated column in this migration that could reach back into a document.
-- Signing a new agreement with Falcon on Tuesday does not rewrite the estimate
-- they approved on Monday, and it does not change an invoice that has been
-- sent. New lines added to that old estimate DO price at the new agreement,
-- which is the same rule the catalog has always followed when its default
-- price is edited.
--
-- Re-runnable: every statement is IF NOT EXISTS / CREATE OR REPLACE / DROP
-- POLICY IF EXISTS. Nothing existing is altered or dropped.

-- ---------------------------------------------------------------- the list

CREATE TABLE IF NOT EXISTS public.price_lists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  -- Retiring rather than deleting, for the same reason a catalog item is
  -- retired: the list is the record of what was agreed, and documents priced
  -- from it are still on file.
  is_active boolean NOT NULL DEFAULT true,
  is_demo boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.price_lists IS
  'A named override of the default catalog price (estimate_catalog_items.default_unit_price). Applied to accounts or locations through price_list_assignments.';

-- ------------------------------------------------------------- its prices

CREATE TABLE IF NOT EXISTS public.price_list_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  price_list_id uuid NOT NULL REFERENCES public.price_lists(id) ON DELETE CASCADE,
  catalog_item_id uuid NOT NULL REFERENCES public.estimate_catalog_items(id) ON DELETE CASCADE,
  -- A price of 0 is a real, deliberate price ("we don't charge Falcon for
  -- travel"), which is why the resolver must never treat 0 as "no entry".
  -- Negative is not a price; a give-back is a discount line.
  unit_price numeric NOT NULL CHECK (unit_price >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- One price per item per list. The importer relies on this to upsert.
  UNIQUE (price_list_id, catalog_item_id)
);

COMMENT ON TABLE public.price_list_items IS
  'The overridden unit price for one catalog item on one price list. Items absent from a list fall through to the next scope, and finally to the catalog default.';

-- --------------------------------------------------------- who it applies to

CREATE TABLE IF NOT EXISTS public.price_list_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  price_list_id uuid NOT NULL REFERENCES public.price_lists(id) ON DELETE CASCADE,
  account_id uuid REFERENCES public.accounts(id) ON DELETE CASCADE,
  location_id uuid REFERENCES public.locations(id) ON DELETE CASCADE,
  -- Effective-dated the way labour_rates is, and for the same reason: an
  -- agreement starts on a day, and last year's jobs must keep last year's
  -- answer if anyone ever asks the resolver about a past date.
  effective_from date NOT NULL DEFAULT CURRENT_DATE,
  effective_to date,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Exactly one scope per row. "This list is for Falcon AND for New Jersey"
  -- is two different rules that would resolve differently, so it is written
  -- as two rows and the resolver can rank them.
  CONSTRAINT price_list_assignments_one_scope CHECK (
    (account_id IS NOT NULL AND location_id IS NULL)
    OR (account_id IS NULL AND location_id IS NOT NULL)
  ),
  CONSTRAINT price_list_assignments_dates CHECK (
    effective_to IS NULL OR effective_to >= effective_from
  )
);

COMMENT ON TABLE public.price_list_assignments IS
  'Applies a price list to one account (a customer agreement) or one location (a state/branch rate), between two dates. Account beats location; see src/lib/price-lists.ts.';

-- Overlapping assignments are NOT forbidden here. Two agreements that both
-- cover today is a data state a human can create by hand and by import, and a
-- constraint that rejects it would block the ordinary act of superseding one
-- agreement with another mid-day. The resolver breaks the tie deterministically
-- instead (newest effective_from, then newest row) and its tests pin that.
CREATE INDEX IF NOT EXISTS price_list_assignments_account_idx
  ON public.price_list_assignments (account_id) WHERE account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS price_list_assignments_location_idx
  ON public.price_list_assignments (location_id) WHERE location_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS price_list_items_list_idx
  ON public.price_list_items (price_list_id);
CREATE INDEX IF NOT EXISTS price_list_items_catalog_idx
  ON public.price_list_items (catalog_item_id);

-- -------------------------------------------------------------- updated_at

DROP TRIGGER IF EXISTS price_lists_set_updated_at ON public.price_lists;
CREATE TRIGGER price_lists_set_updated_at
  BEFORE UPDATE ON public.price_lists
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS price_list_items_set_updated_at ON public.price_list_items;
CREATE TRIGGER price_list_items_set_updated_at
  BEFORE UPDATE ON public.price_list_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS price_list_assignments_set_updated_at ON public.price_list_assignments;
CREATE TRIGGER price_list_assignments_set_updated_at
  BEFORE UPDATE ON public.price_list_assignments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- --------------------------------------------------------------------- RLS
--
-- Modelled on estimate_catalog_items: every signed-in user reads, only
-- is_privileged() writes.
--
-- Read is deliberately open to `authenticated`. A sell price is not a secret
-- from our own staff — default_unit_price is readable by everyone today, and
-- an estimator who cannot see Falcon's agreed rate cannot write Falcon's bill,
-- which is the entire point of the feature. The thing that IS withheld is
-- cost, and cost is not in these tables (see the header).

ALTER TABLE public.price_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.price_list_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.price_list_assignments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS price_lists_select ON public.price_lists;
CREATE POLICY price_lists_select ON public.price_lists
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS price_lists_write ON public.price_lists;
CREATE POLICY price_lists_write ON public.price_lists
  FOR ALL TO authenticated
  USING (public.is_privileged((SELECT auth.uid())))
  WITH CHECK (public.is_privileged((SELECT auth.uid())));

DROP POLICY IF EXISTS price_list_items_select ON public.price_list_items;
CREATE POLICY price_list_items_select ON public.price_list_items
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS price_list_items_write ON public.price_list_items;
CREATE POLICY price_list_items_write ON public.price_list_items
  FOR ALL TO authenticated
  USING (public.is_privileged((SELECT auth.uid())))
  WITH CHECK (public.is_privileged((SELECT auth.uid())));

DROP POLICY IF EXISTS price_list_assignments_select ON public.price_list_assignments;
CREATE POLICY price_list_assignments_select ON public.price_list_assignments
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS price_list_assignments_write ON public.price_list_assignments;
CREATE POLICY price_list_assignments_write ON public.price_list_assignments
  FOR ALL TO authenticated
  USING (public.is_privileged((SELECT auth.uid())))
  WITH CHECK (public.is_privileged((SELECT auth.uid())));

-- Table-level grants are correct here: there is no column these tables must
-- hold back. If that ever changes, see the header.
GRANT SELECT ON public.price_lists TO authenticated;
GRANT SELECT ON public.price_list_items TO authenticated;
GRANT SELECT ON public.price_list_assignments TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.price_lists TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.price_list_items TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.price_list_assignments TO authenticated;
GRANT ALL ON public.price_lists TO service_role;
GRANT ALL ON public.price_list_items TO service_role;
GRANT ALL ON public.price_list_assignments TO service_role;

-- Supabase's ALTER DEFAULT PRIVILEGES hands `anon` the full table grant at
-- CREATE TABLE time. No anonymous path prices anything, and both policies are
-- TO authenticated so anon has never seen a row, but the grant is taken away
-- by name for the same reason 20260909090000 took it away from the catalog:
-- an unauthenticated role should not be nominally able to read or write our
-- customers' negotiated rates.
REVOKE ALL ON public.price_lists FROM anon;
REVOKE ALL ON public.price_list_items FROM anon;
REVOKE ALL ON public.price_list_assignments FROM anon;
