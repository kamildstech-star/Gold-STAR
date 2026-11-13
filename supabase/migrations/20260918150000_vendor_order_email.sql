-- Approving a supply order composes the vendor's purchase order email.
--
-- David, 16 Sep, point 22: the supply approval flow shipped with vendor
-- emailing MANUAL and "a clean seam to switch on". The decision has come back —
-- switch it on. Approving an order should produce the vendor email itself.
--
-- WHAT IS STILL NOT TRUE: outbound delivery is blocked on Chaim approving the
-- email backend. So the email is composed and RECORDED, and the approver opens
-- it as a prefilled draft in their own Outlook. Nothing here sends anything,
-- and nothing here builds anything that could.
--
-- Three small things. No new email machinery: public.email_messages already is
-- the record of an email with a status, a template key, recipients and
-- opened/sent timestamps, and it already has RLS. It just had no way to say
-- "this one belongs to that supply order".

-- 1. A vendor directory ------------------------------------------------------
-- Suppliers are free text everywhere today: supply_items.default_supplier and
-- supply_purchases.supplier_name are both names somebody typed. That is fine
-- for a spend report and useless for addressing an email.
--
-- This resolves a name to an address WITHOUT changing any of those columns.
-- Nothing is migrated into it and nothing is required to exist — an order for a
-- supplier nobody has recorded composes with a blank recipient, which the
-- approver fills in, and the app records the address for next time.
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

-- Case-insensitive, because "Jon-Don" and "jon-don" are one merchant and the
-- name is what the existing free-text columns will be matched on.
CREATE UNIQUE INDEX IF NOT EXISTS supply_vendors_name_key
  ON public.supply_vendors (lower(name));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.supply_vendors TO authenticated;
GRANT ALL ON public.supply_vendors TO service_role;
ALTER TABLE public.supply_vendors ENABLE ROW LEVEL SECURITY;

-- Read like supply_items: anyone signed in may read the catalogue they order
-- from, and a vendor's phone number is not a secret from the staff who call it.
DROP POLICY IF EXISTS "supply_vendors_read" ON public.supply_vendors;
CREATE POLICY "supply_vendors_read" ON public.supply_vendors FOR SELECT TO authenticated
  USING (true);

-- Write is exactly the set of people who can APPROVE a supply order, because
-- filling in a missing vendor address is something the approver does mid-
-- approval. can_manage_location() cannot express it — it is per-location and
-- returns false for a NULL location, and a vendor belongs to no office — so the
-- role test it is built from is used directly.
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

-- 2. The email knows which order it is for ----------------------------------
-- So an order can show its own email status, and so a second approval cannot
-- quietly compose a second purchase order for the same request.
ALTER TABLE public.email_messages
  ADD COLUMN IF NOT EXISTS supply_request_id uuid
    REFERENCES public.supply_requests(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS email_messages_supply_request_idx
  ON public.email_messages (supply_request_id, created_at DESC);

-- One vendor order per request. The approver pressing Approve twice, or two
-- managers pressing it at once, must not put two purchase orders in front of a
-- supplier — that is the kind of mistake a merchant ships against.
CREATE UNIQUE INDEX IF NOT EXISTS email_messages_supply_request_key
  ON public.email_messages (supply_request_id)
  WHERE supply_request_id IS NOT NULL;

-- RLS on email_messages is UNCHANGED and still the boundary: the log is
-- readable by its sender or by anyone who can view its location, and writable
-- only by its sender. A new column inherits all three policies.

-- 3. Approving without emailing ----------------------------------------------
-- The per-order opt-out. Recorded rather than inferred: "no email row" would
-- otherwise mean both "we chose not to" and "composing went wrong", and those
-- two need different reactions from whoever is looking at the order later.
ALTER TABLE public.supply_requests
  ADD COLUMN IF NOT EXISTS vendor_email_skipped boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.supply_requests.vendor_email_skipped IS
  'Approved deliberately without composing a vendor email. Distinct from no email row at all.';
