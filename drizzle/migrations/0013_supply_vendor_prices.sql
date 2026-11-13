CREATE TABLE IF NOT EXISTS public.supply_item_vendor_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES public.supply_items(id) ON DELETE CASCADE,
  vendor_id uuid NOT NULL REFERENCES public.supply_vendors(id) ON DELETE CASCADE,
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
DROP POLICY IF EXISTS "supply_item_vendor_prices_write" ON public.supply_item_vendor_prices;
CREATE POLICY "supply_item_vendor_prices_write" ON public.supply_item_vendor_prices
  FOR ALL TO authenticated
  USING (public.is_privileged((SELECT auth.uid())))
  WITH CHECK (public.is_privileged((SELECT auth.uid())));