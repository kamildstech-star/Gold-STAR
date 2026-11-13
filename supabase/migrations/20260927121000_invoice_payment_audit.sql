-- Payments can be corrected, and every correction leaves a trail.
--
-- David, 24 Sep: "if somebody puts in a payment and makes a mistake...
-- payments have to be editable."
--
-- The write policy on invoice_payments (20260731003140) already allows an
-- office manager or the invoice's creator to update and delete — nothing in
-- the app offered it. What was missing is the record of it: this is money,
-- and a payment that quietly changes from $5,000 to $500 is exactly the edit
-- somebody has to be able to find later. So the trail is written by the
-- DATABASE, on every update and delete, whichever screen (or script) made it.
--
-- The rollup trigger (tg_invoice_payment_rollup) already recomputes the
-- invoice's collected amount and status on UPDATE and DELETE, so an edited
-- payment moves the invoice, the job's collected figure and the Payments tab
-- with it. A payment cannot be moved to another invoice here (that would
-- leave the old invoice's total stale); correct it by removing and recording.

-- Who last changed the row, and why. The reason is set by the edit itself and
-- copied into the trail; it is not a history of its own.
ALTER TABLE public.invoice_payments
  ADD COLUMN IF NOT EXISTS updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS change_reason text;

CREATE TABLE IF NOT EXISTS public.invoice_payment_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- No foreign key: the trail outlives a removed payment, which is the point.
  payment_id uuid NOT NULL,
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('edit', 'remove')),
  changed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  before_data jsonb NOT NULL,
  after_data jsonb,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS invoice_payment_changes_invoice_idx
  ON public.invoice_payment_changes (invoice_id, created_at DESC);

GRANT SELECT ON public.invoice_payment_changes TO authenticated;
GRANT ALL ON public.invoice_payment_changes TO service_role;
ALTER TABLE public.invoice_payment_changes ENABLE ROW LEVEL SECURITY;

-- Read by whoever can read the invoice's payments; written by nobody but the
-- trigger (no insert/update/delete policy), so the trail cannot be edited.
DROP POLICY IF EXISTS "invoice_payment_changes_select" ON public.invoice_payment_changes;
CREATE POLICY "invoice_payment_changes_select" ON public.invoice_payment_changes
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.invoices i WHERE i.id = invoice_id
      AND (public.can_view_location((SELECT auth.uid()), i.location_id)
           OR i.created_by = (SELECT auth.uid()))
  ));

-- The trail. SECURITY DEFINER so it can write a table nobody else may, and it
-- writes only what it was handed: the row before, the row after, the caller.
CREATE OR REPLACE FUNCTION public.tg_invoice_payment_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.invoice_id IS DISTINCT FROM OLD.invoice_id THEN
      RAISE EXCEPTION 'A payment cannot be moved to another invoice. Remove it and record it on the right one.'
        USING ERRCODE = '22023';
    END IF;
    -- Only the money facts count as a change worth a line in the trail.
    IF (NEW.amount, NEW.received_at, NEW.method, NEW.reference, NEW.notes)
       IS DISTINCT FROM (OLD.amount, OLD.received_at, OLD.method, OLD.reference, OLD.notes) THEN
      NEW.updated_at := now();
      NEW.updated_by := auth.uid();
      INSERT INTO public.invoice_payment_changes
        (payment_id, invoice_id, action, changed_by, before_data, after_data, reason)
      VALUES
        (OLD.id, OLD.invoice_id, 'edit', auth.uid(),
         jsonb_build_object('amount', OLD.amount, 'received_at', OLD.received_at,
                            'method', OLD.method, 'reference', OLD.reference, 'notes', OLD.notes),
         jsonb_build_object('amount', NEW.amount, 'received_at', NEW.received_at,
                            'method', NEW.method, 'reference', NEW.reference, 'notes', NEW.notes),
         nullif(btrim(coalesce(NEW.change_reason, '')), ''));
    END IF;
    RETURN NEW;
  END IF;

  -- DELETE
  INSERT INTO public.invoice_payment_changes
    (payment_id, invoice_id, action, changed_by, before_data, after_data, reason)
  VALUES
    (OLD.id, OLD.invoice_id, 'remove', auth.uid(),
     jsonb_build_object('amount', OLD.amount, 'received_at', OLD.received_at,
                        'method', OLD.method, 'reference', OLD.reference, 'notes', OLD.notes),
     NULL,
     nullif(btrim(coalesce(OLD.change_reason, '')), ''));
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_invoice_payment_audit() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS invoice_payments_audit_update ON public.invoice_payments;
CREATE TRIGGER invoice_payments_audit_update BEFORE UPDATE ON public.invoice_payments
  FOR EACH ROW EXECUTE FUNCTION public.tg_invoice_payment_audit();

DROP TRIGGER IF EXISTS invoice_payments_audit_delete ON public.invoice_payments;
CREATE TRIGGER invoice_payments_audit_delete BEFORE DELETE ON public.invoice_payments
  FOR EACH ROW EXECUTE FUNCTION public.tg_invoice_payment_audit();
