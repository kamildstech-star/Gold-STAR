-- Supplies: what a delivery leaves behind, and what it cost.

CREATE TABLE IF NOT EXISTS public.supply_stock (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES public.supply_items(id) ON DELETE CASCADE,
  on_hand numeric(12,2) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (location_id, item_id)
);
CREATE INDEX IF NOT EXISTS supply_stock_location_idx ON public.supply_stock (location_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.supply_stock TO authenticated;
GRANT ALL ON public.supply_stock TO service_role;
ALTER TABLE public.supply_stock ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "supply_stock_select" ON public.supply_stock;
CREATE POLICY "supply_stock_select" ON public.supply_stock FOR SELECT TO authenticated
  USING (public.can_manage_location(auth.uid(), location_id)
         OR EXISTS (SELECT 1 FROM public.location_members m
                    WHERE m.user_id = auth.uid() AND m.location_id = supply_stock.location_id));
DROP POLICY IF EXISTS "supply_stock_write" ON public.supply_stock;
CREATE POLICY "supply_stock_write" ON public.supply_stock FOR ALL TO authenticated
  USING (public.can_manage_location(auth.uid(), location_id))
  WITH CHECK (public.can_manage_location(auth.uid(), location_id));

CREATE TABLE IF NOT EXISTS public.supply_stock_moves (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES public.supply_items(id) ON DELETE CASCADE,
  qty numeric(12,2) NOT NULL CHECK (qty <> 0),
  reason text NOT NULL DEFAULT 'manual_adjust',
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

CREATE TABLE IF NOT EXISTS public.supply_purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE RESTRICT,
  item_id uuid REFERENCES public.supply_items(id) ON DELETE SET NULL,
  item_label text,
  supplier_name text NOT NULL,
  supplier_account_id uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  quantity numeric(12,2) NOT NULL CHECK (quantity > 0),
  unit_price numeric(12,2) NOT NULL CHECK (unit_price >= 0),
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

ALTER TABLE public.supply_items
  ADD COLUMN IF NOT EXISTS sku text,
  ADD COLUMN IF NOT EXISTS default_supplier text;

CREATE UNIQUE INDEX IF NOT EXISTS supply_items_sku_key
  ON public.supply_items (lower(sku)) WHERE sku IS NOT NULL;

COMMENT ON COLUMN public.supply_items.sku IS
  'Supplier or internal code. The key an imported catalogue upserts on.';
COMMENT ON COLUMN public.supply_items.default_supplier IS
  'Who this is normally bought from. A default for a purchase, never a rule.';