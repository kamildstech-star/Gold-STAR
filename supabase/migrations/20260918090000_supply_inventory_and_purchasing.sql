-- Supplies: what a delivery leaves behind, and what it cost.
--
-- From David's 16 Sep walkthrough of Supplies. The request workflow already
-- exists — requested → approved → ordered → delivered, with approval bounded
-- by can_manage_location() — and none of that is touched here. What it has
-- never had is the two things either side of "delivered":
--
--   · delivered items should ENTER INVENTORY, and inventory should be
--     reducible by hand as stock is used;
--   · the purchaser should be able to record what was paid and who it was
--     bought from, so "this month we spent £X at supplier Y on item Z" is a
--     report rather than the spreadsheet he keeps today.
--
-- Three tables, each with the same location-scoped policies the rest of the
-- supplies module uses, so a location sees its own stock and its own spend.

-- Stock ---------------------------------------------------------------------
-- On-hand per item per location. One row per pair; the ledger below is what
-- explains any number in it.
CREATE TABLE IF NOT EXISTS public.supply_stock (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES public.supply_items(id) ON DELETE CASCADE,
  -- Numeric, not integer: a unit may be "gallons" or "rolls" as easily as "each".
  on_hand numeric(12,2) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (location_id, item_id)
);
CREATE INDEX IF NOT EXISTS supply_stock_location_idx ON public.supply_stock (location_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.supply_stock TO authenticated;
GRANT ALL ON public.supply_stock TO service_role;
ALTER TABLE public.supply_stock ENABLE ROW LEVEL SECURITY;

-- Everyone at a location can see what is on the shelf; changing it is the
-- manager's, exactly as approving a request is.
DROP POLICY IF EXISTS "supply_stock_select" ON public.supply_stock;
CREATE POLICY "supply_stock_select" ON public.supply_stock FOR SELECT TO authenticated
  USING (public.can_manage_location(auth.uid(), location_id)
         OR EXISTS (SELECT 1 FROM public.location_members m
                    WHERE m.user_id = auth.uid() AND m.location_id = supply_stock.location_id));
DROP POLICY IF EXISTS "supply_stock_write" ON public.supply_stock;
CREATE POLICY "supply_stock_write" ON public.supply_stock FOR ALL TO authenticated
  USING (public.can_manage_location(auth.uid(), location_id))
  WITH CHECK (public.can_manage_location(auth.uid(), location_id));

-- Ledger --------------------------------------------------------------------
-- Every movement, so a count is auditable rather than asserted. Positive is in,
-- negative is out.
--
-- `reason` is text rather than an enum on purpose: scan-based depletion is a
-- decision the client has not taken yet (manual mark-down is the default that
-- ships), and adding 'scan' later must not need an enum migration.
CREATE TABLE IF NOT EXISTS public.supply_stock_moves (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES public.supply_items(id) ON DELETE CASCADE,
  qty numeric(12,2) NOT NULL CHECK (qty <> 0),
  reason text NOT NULL DEFAULT 'manual_adjust',
  -- What caused it, when there was a cause: the delivered order, or the job the
  -- stock was used on.
  request_id uuid REFERENCES public.supply_requests(id) ON DELETE SET NULL,
  job_id uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
  note text,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS supply_stock_moves_location_idx
  ON public.supply_stock_moves (location_id, created_at DESC);
CREATE INDEX IF NOT EXISTS supply_stock_moves_item_idx
  ON public.supply_stock_moves (item_id, created_at DESC);
-- One delivery per request per item, so re-pressing "delivered" cannot stock
-- the shelf twice.
CREATE UNIQUE INDEX IF NOT EXISTS supply_stock_moves_delivery_key
  ON public.supply_stock_moves (request_id, item_id)
  WHERE reason = 'delivery' AND request_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.supply_stock_moves TO authenticated;
GRANT ALL ON public.supply_stock_moves TO service_role;
ALTER TABLE public.supply_stock_moves ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "supply_stock_moves_select" ON public.supply_stock_moves;
CREATE POLICY "supply_stock_moves_select" ON public.supply_stock_moves FOR SELECT TO authenticated
  USING (public.can_manage_location(auth.uid(), location_id)
         OR EXISTS (SELECT 1 FROM public.location_members m
                    WHERE m.user_id = auth.uid()
                      AND m.location_id = supply_stock_moves.location_id));
DROP POLICY IF EXISTS "supply_stock_moves_write" ON public.supply_stock_moves;
CREATE POLICY "supply_stock_moves_write" ON public.supply_stock_moves FOR ALL TO authenticated
  USING (public.can_manage_location(auth.uid(), location_id))
  WITH CHECK (public.can_manage_location(auth.uid(), location_id));

-- Purchases -----------------------------------------------------------------
-- What was paid, to whom, for what, and when. This is the spreadsheet.
--
-- `supplier_name` is free text with an OPTIONAL link to an account. Gold Star's
-- suppliers are a builders' merchant and a hire shop as often as they are a
-- vendor already on the books, and forcing every purchase through the accounts
-- table would mean inventing an account before a receipt could be typed in.
-- The id is there so a supplier that IS on the books can be joined properly.
CREATE TABLE IF NOT EXISTS public.supply_purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE RESTRICT,
  item_id uuid REFERENCES public.supply_items(id) ON DELETE SET NULL,
  -- Kept for an item that has since been removed from the catalogue, so an old
  -- purchase still says what it was for.
  item_label text,
  supplier_name text NOT NULL,
  supplier_account_id uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  quantity numeric(12,2) NOT NULL CHECK (quantity > 0),
  unit_price numeric(12,2) NOT NULL CHECK (unit_price >= 0),
  -- Stored, not derived, because a line may carry delivery or a discount that
  -- quantity × unit_price does not explain.
  total_cost numeric(12,2) NOT NULL CHECK (total_cost >= 0),
  purchased_on date NOT NULL DEFAULT current_date,
  request_id uuid REFERENCES public.supply_requests(id) ON DELETE SET NULL,
  note text,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supply_purchase_named
    CHECK (item_id IS NOT NULL OR nullif(btrim(coalesce(item_label,'')),'') IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS supply_purchases_month_idx
  ON public.supply_purchases (location_id, purchased_on DESC);
CREATE INDEX IF NOT EXISTS supply_purchases_supplier_idx
  ON public.supply_purchases (supplier_name, purchased_on DESC);
CREATE INDEX IF NOT EXISTS supply_purchases_item_idx
  ON public.supply_purchases (item_id, purchased_on DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.supply_purchases TO authenticated;
GRANT ALL ON public.supply_purchases TO service_role;
ALTER TABLE public.supply_purchases ENABLE ROW LEVEL SECURITY;

-- Money, so this one is narrower than stock: what was paid is a management
-- figure, gated the same way the rest of the app gates money.
DROP POLICY IF EXISTS "supply_purchases_select" ON public.supply_purchases;
CREATE POLICY "supply_purchases_select" ON public.supply_purchases FOR SELECT TO authenticated
  USING (public.can_view_finance(auth.uid())
         OR public.can_manage_location(auth.uid(), location_id));
DROP POLICY IF EXISTS "supply_purchases_write" ON public.supply_purchases;
CREATE POLICY "supply_purchases_write" ON public.supply_purchases FOR ALL TO authenticated
  USING (public.can_view_finance(auth.uid())
         OR public.can_manage_location(auth.uid(), location_id))
  WITH CHECK (public.can_view_finance(auth.uid())
              OR public.can_manage_location(auth.uid(), location_id));

-- Catalogue -----------------------------------------------------------------
-- Two columns the client's spreadsheet will need a home for when it arrives.
-- `sku` is what an import matches on for a second run, so re-importing a
-- corrected sheet updates rows instead of duplicating them.
ALTER TABLE public.supply_items
  ADD COLUMN IF NOT EXISTS sku text,
  ADD COLUMN IF NOT EXISTS default_supplier text;

CREATE UNIQUE INDEX IF NOT EXISTS supply_items_sku_key
  ON public.supply_items (lower(sku)) WHERE sku IS NOT NULL;

COMMENT ON COLUMN public.supply_items.sku IS
  'Supplier or internal code. The key an imported catalogue upserts on.';
COMMENT ON COLUMN public.supply_items.default_supplier IS
  'Who this is normally bought from. A default for a purchase, never a rule.';
