-- Where a supply order is delivered.
--
-- David, 22 Sep: "this address up here should be delivery address. And maybe
-- have their location, their warehouse preset — or they should be able to
-- type in a different address."
--
-- Stored on the order as the text that was on the form: the office's address
-- by default, or whatever was typed instead (a job site, a storage unit). It is
-- what the vendor's purchase order says to ship to, so it is written once when
-- the order is placed rather than looked up later — an office moving premises
-- must not rewrite where last month's orders went. NULL on older orders, which
-- keep falling back to their office's address exactly as before.

ALTER TABLE public.supply_requests
  ADD COLUMN IF NOT EXISTS delivery_address text;

COMMENT ON COLUMN public.supply_requests.delivery_address IS
  'Ship-to for this order: the office address by default, or one typed on the form. NULL = the office address.';

-- RLS unchanged: the column inherits every supply_requests policy.
