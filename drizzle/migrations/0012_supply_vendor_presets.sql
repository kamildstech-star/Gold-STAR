ALTER TABLE public.supply_items
  ADD COLUMN IF NOT EXISTS default_vendor_id uuid
    REFERENCES public.supply_vendors(id) ON DELETE SET NULL;
COMMENT ON COLUMN public.supply_items.default_vendor_id IS
  'Who this item is usually bought from. Replaces the free-text default_supplier as the '
  'source of truth; default_supplier is kept, mirrored from the vendor name, for older readers.';
ALTER TABLE public.supply_request_lines
  ADD COLUMN IF NOT EXISTS vendor_id uuid
    REFERENCES public.supply_vendors(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS supply_request_lines_vendor_idx
  ON public.supply_request_lines (vendor_id) WHERE vendor_id IS NOT NULL;
INSERT INTO public.supply_vendors (name)
SELECT DISTINCT ON (lower(btrim(i.default_supplier))) btrim(i.default_supplier)
FROM public.supply_items i
WHERE nullif(btrim(coalesce(i.default_supplier, '')), '') IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.supply_vendors v
    WHERE lower(btrim(v.name)) = lower(btrim(i.default_supplier))
  )
ORDER BY lower(btrim(i.default_supplier)), btrim(i.default_supplier)
ON CONFLICT DO NOTHING;
UPDATE public.supply_items i
SET default_vendor_id = v.id
FROM public.supply_vendors v
WHERE i.default_vendor_id IS NULL
  AND nullif(btrim(coalesce(i.default_supplier, '')), '') IS NOT NULL
  AND lower(btrim(v.name)) = lower(btrim(i.default_supplier));
CREATE OR REPLACE FUNCTION public.supply_vendor_name_mirror()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name THEN
    UPDATE public.supply_items SET default_supplier = NEW.name
    WHERE default_vendor_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.supply_vendor_name_mirror() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS supply_vendors_name_mirror ON public.supply_vendors;
CREATE TRIGGER supply_vendors_name_mirror AFTER UPDATE OF name ON public.supply_vendors
  FOR EACH ROW EXECUTE FUNCTION public.supply_vendor_name_mirror();
DROP POLICY IF EXISTS "supply_lines_manage" ON public.supply_request_lines;
CREATE POLICY "supply_lines_manage" ON public.supply_request_lines FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.supply_requests r
    WHERE r.id = request_id AND public.can_manage_location((SELECT auth.uid()), r.location_id)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.supply_requests r
    WHERE r.id = request_id AND public.can_manage_location((SELECT auth.uid()), r.location_id)
  ));