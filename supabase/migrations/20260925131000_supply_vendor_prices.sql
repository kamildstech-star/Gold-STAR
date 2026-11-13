-- What each vendor charges for an item.
--
-- David, 22 Sep: "if there's two vendors that sell the same item, one guy
-- charges $9, the other guy charges $10, then we should be able to put it in
-- for each vendor and the system should automatically pick it up... so that
-- we can track spending properly." And: "I want it to be automatic really."
--
-- This is the EXPECTATION: what an order line should cost from the vendor it
-- is going to. The FACT stays where it is — supply_purchases, one row per
-- purchase at the price actually paid, which is what Spending and the monthly
-- reports read. The two are never merged: a price change here rewrites no
-- purchase, and a purchase at a different price changes no price here.
--
-- Not supply_items.unit_cost either. That is what the running-cost engine
-- CHARGES A JOB for the item (Cost rates), a different number with a
-- different owner.

CREATE TABLE IF NOT EXISTS public.supply_item_vendor_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES public.supply_items(id) ON DELETE CASCADE,
  vendor_id uuid NOT NULL REFERENCES public.supply_vendors(id) ON DELETE CASCADE,
  -- Per the item's own unit (its pack: "24 Case", "1 Roll").
  unit_price numeric(12,2) NOT NULL CHECK (unit_price >= 0),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supply_item_vendor_prices_one UNIQUE (item_id, vendor_id)
);

CREATE INDEX IF NOT EXISTS supply_item_vendor_prices_vendor_idx
  ON public.supply_item_vendor_prices (vendor_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.supply_item_vendor_prices TO authenticated;
GRANT ALL ON public.supply_item_vendor_prices TO service_role;
ALTER TABLE public.supply_item_vendor_prices ENABLE ROW LEVEL SECURITY;

-- Read: the people who approve and pay for supply orders — finance, and the
-- roles that already manage vendors (20260918150000). What a merchant charges
-- us is purchasing money, so a crew member placing a request does not see it.
DROP POLICY IF EXISTS "supply_item_vendor_prices_read" ON public.supply_item_vendor_prices;
CREATE POLICY "supply_item_vendor_prices_read" ON public.supply_item_vendor_prices
  FOR SELECT TO authenticated
  USING (
    public.is_privileged((SELECT auth.uid()))
    OR public.can_view_finance((SELECT auth.uid()))
    OR public.has_any_role_text(
      (SELECT auth.uid()), ARRAY['office','location_manager','sales_manager','regional']
    )
  );

-- Write: whoever edits the catalog, exactly as supply_items_manage says.
DROP POLICY IF EXISTS "supply_item_vendor_prices_write" ON public.supply_item_vendor_prices;
CREATE POLICY "supply_item_vendor_prices_write" ON public.supply_item_vendor_prices
  FOR ALL TO authenticated
  USING (public.is_privileged((SELECT auth.uid())))
  WITH CHECK (public.is_privileged((SELECT auth.uid())));
