-- Vendors as a managed list, preset per item, overridable per order line.
--
-- David, 22 Sep: "Could I have here another vendor dropdown — I'll have five,
-- 10 vendors in here. We'll select which vendor we generally purchase it from
-- or preset. And then we could obviously always in each order select a
-- vendor."
--
-- Built ON supply_vendors (20260918150000), which already holds name, email,
-- phone and note and fills itself from vendor-order email drafts. Nothing
-- here creates a second vendor table.

-- 1. The preset on the item ------------------------------------------------
ALTER TABLE public.supply_items
  ADD COLUMN IF NOT EXISTS default_vendor_id uuid
    REFERENCES public.supply_vendors(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.supply_items.default_vendor_id IS
  'Who this item is usually bought from. Replaces the free-text default_supplier as the '
  'source of truth; default_supplier is kept, mirrored from the vendor name, for older readers.';

-- 2. The override on the order line ----------------------------------------
-- NULL means "the item's preset". A value means somebody chose differently for
-- this order, and that choice is what the purchase order and the expected
-- price follow.
ALTER TABLE public.supply_request_lines
  ADD COLUMN IF NOT EXISTS vendor_id uuid
    REFERENCES public.supply_vendors(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS supply_request_lines_vendor_idx
  ON public.supply_request_lines (vendor_id) WHERE vendor_id IS NOT NULL;

-- 3. The free text, mapped onto the list -----------------------------------
-- Every distinct supplier name already typed on an item becomes a vendor if
-- one of that name (case- and space-insensitively) does not exist yet, and the
-- item is pointed at it. That is the starting point David's list grows from:
-- the names on it are the ones his catalog already uses, and an admin renames
-- or merges from there. An item with no supplier text gets no preset — the
-- order line then says "no vendor" and the approver picks one.
--
-- default_supplier itself is NOT cleared. It stays as the record of what was
-- typed, and from here on it is mirrored from the chosen vendor's name.
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

-- 4. Renaming a vendor renames the mirror ----------------------------------
-- Vendors are written by approvers (office, location_manager, ...), items only
-- by privileged users, so the mirror write cannot run with the caller's own
-- rights. SECURITY DEFINER, and it does exactly one thing: copy the new name
-- onto items that point at this vendor.
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

-- 5. Managers may adjust the lines of an order they manage -----------------
-- The only write policy on supply_request_lines (20260818173022) is the
-- requester's, and only while the order is still 'requested'. That quietly
-- refused two things the app already does as a manager: writing the running
-- delivered_quantity on a partial delivery (20260918170000 — the update
-- matched no row, so the count never saved), and now choosing a vendor or
-- adjusting a quantity on the order's line list. UPDATE only: a manager
-- adjusts what was asked for, the requester still owns adding and removing.
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
