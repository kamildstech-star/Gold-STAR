-- ---------------------------------------------------------------------------
-- An emailed invoice is Sent (5 Nov review, T5: "users won't change it by
-- hand").
--
-- The invoice editor's Email goes through the composer (sendEmail) and, after
-- the undo window, the email-release hook; both end with the email_messages
-- row set to status 'sent' (email-delivery.server.ts). That moment, and only
-- that one, moves the invoice on:
--   - a Draft invoice becomes Sent and gets its sent date (sent_at, kept if
--     it already had one);
--   - a held, cancelled, queued or failed email changes nothing, so a failed
--     send leaves the invoice a Draft;
--   - Sent / Part paid / Paid / Disputed / Written off are never touched, so
--     nothing is downgraded. The manual status dropdown is unchanged.
-- Re-runnable.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mark_invoice_sent_on_email()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.invoice_id IS NULL OR NEW.status::text <> 'sent' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status::text = 'sent' THEN
    RETURN NEW;
  END IF;
  UPDATE public.invoices i
     SET status = 'sent',
         sent_at = COALESCE(i.sent_at, NEW.sent_at, now())
   WHERE i.id = NEW.invoice_id
     AND i.status::text = 'draft';
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_invoice_sent_on_email() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS email_messages_mark_invoice_sent ON public.email_messages;
CREATE TRIGGER email_messages_mark_invoice_sent
  AFTER INSERT OR UPDATE OF status ON public.email_messages
  FOR EACH ROW EXECUTE FUNCTION public.mark_invoice_sent_on_email();

-- VERIFY: email a Draft invoice from its editor; once the email shows "sent"
--   SELECT status, sent_at FROM public.invoices WHERE id = '<id>';  -- sent, set
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS email_messages_mark_invoice_sent ON public.email_messages;
--   DROP FUNCTION IF EXISTS public.mark_invoice_sent_on_email();
