CREATE TABLE IF NOT EXISTS public.supply_vendors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text,
  phone text,
  note text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS supply_vendors_name_key
  ON public.supply_vendors (lower(name));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.supply_vendors TO authenticated;
GRANT ALL ON public.supply_vendors TO service_role;
ALTER TABLE public.supply_vendors ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "supply_vendors_read" ON public.supply_vendors;
CREATE POLICY "supply_vendors_read" ON public.supply_vendors FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "supply_vendors_write" ON public.supply_vendors;
CREATE POLICY "supply_vendors_write" ON public.supply_vendors FOR ALL TO authenticated
  USING (
    public.is_privileged(auth.uid())
    OR public.has_any_role_text(auth.uid(), ARRAY['office','location_manager','sales_manager','regional'])
  )
  WITH CHECK (
    public.is_privileged(auth.uid())
    OR public.has_any_role_text(auth.uid(), ARRAY['office','location_manager','sales_manager','regional'])
  );

ALTER TABLE public.email_messages
  ADD COLUMN IF NOT EXISTS supply_request_id uuid
    REFERENCES public.supply_requests(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS email_messages_supply_request_idx
  ON public.email_messages (supply_request_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS email_messages_supply_request_key
  ON public.email_messages (supply_request_id)
  WHERE supply_request_id IS NOT NULL;

ALTER TABLE public.supply_requests
  ADD COLUMN IF NOT EXISTS vendor_email_skipped boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.supply_requests.vendor_email_skipped IS
  'Approved deliberately without composing a vendor email. Distinct from no email row at all.';