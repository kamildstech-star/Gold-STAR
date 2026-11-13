ALTER TABLE public.supply_requests
  ADD COLUMN IF NOT EXISTS delivery_address text;
COMMENT ON COLUMN public.supply_requests.delivery_address IS
  'Ship-to for this order: the office address by default, or one typed on the form. NULL = the office address.';