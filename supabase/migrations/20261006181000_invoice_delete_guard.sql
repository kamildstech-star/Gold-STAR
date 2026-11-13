-- Only an untouched draft invoice can be deleted.
--
-- UNAPPLIED when written (2026-10-06). The app works without it: the Billing
-- tab already offers Delete only on an untouched draft, to a manager of the
-- office. This is the same rule held in the database, for every other path.
--
-- Mark, of the Invoices card: "need to rework this box to make more sense and
-- need a delete or undo." Invoices are money. invoices_delete (20260731003140)
-- lets an office manager delete ANY invoice, paid ones included, and a delete
-- cascades the payments and their correction trail (invoice_payment_changes,
-- 20260927121000) with it. The app never offered that; now that it offers
-- Delete at all, the database should refuse what the button refuses:
--
--   - anything but a draft;
--   - a draft that was ever sent (sent_at is set when it goes out and is not
--     cleared by moving it back to draft);
--   - one the carrier has ruled on (approved_amount);
--   - one with money against it, or any payment record, even a removed one —
--     the removal's trail lives on the invoice and would be deleted with it.
--
-- A whole job being deleted cascades into invoices after the job row is gone;
-- that is the job's business, not this rule's.
--
-- The delete is already written to activity_log by log_activity_invoices
-- (20260820195702), so it shows on the job's Timeline. Invoices are left out
-- of the Timeline Restore (#300) on purpose; nothing here changes that.
--
-- Re-runnable.
CREATE OR REPLACE FUNCTION public.refuse_deleting_issued_invoice()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trail boolean := false;
BEGIN
  IF OLD.job_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = OLD.job_id) THEN
    RETURN OLD;
  END IF;
  -- Dynamic: the trail table arrives with 20260927121000.
  IF to_regclass('public.invoice_payment_changes') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.invoice_payment_changes c WHERE c.invoice_id = $1)'
      INTO v_trail USING OLD.id;
  END IF;
  IF OLD.status::text <> 'draft'
     OR OLD.sent_at IS NOT NULL
     OR OLD.approved_amount IS NOT NULL
     OR COALESCE(OLD.collected_amount, 0) <> 0
     OR EXISTS (SELECT 1 FROM public.invoice_payments p WHERE p.invoice_id = OLD.id)
     OR v_trail
  THEN
    RAISE EXCEPTION '% can''t be deleted — it has been sent, ruled on or paid. Set it to Written off, or edit it and resend.', OLD.invoice_number
      USING ERRCODE = 'P0001';
  END IF;
  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.refuse_deleting_issued_invoice() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS invoices_refuse_issued_delete ON public.invoices;
CREATE TRIGGER invoices_refuse_issued_delete BEFORE DELETE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.refuse_deleting_issued_invoice();
