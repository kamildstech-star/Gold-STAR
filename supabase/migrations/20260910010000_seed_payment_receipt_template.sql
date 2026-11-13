-- Give the payment receipt a template, so it stops asking which one to use.
--
-- David, on the 9 September call, after recording a payment and pressing Send
-- receipt: "I'm choosing the template, but I want to have it defaulted."
--
-- The machinery for that already exists. JobEmailDialog takes a `purpose`, and
-- the receipt button passes 'payment_receipt'; the dialog then resolves the
-- first template carrying that purpose and opens on the finished wording. It
-- only falls back to the whole library, unselected, when NO template has the
-- purpose -- which is exactly the state this database is in. Nobody had made
-- one, so the auto-select had nothing to find and the picker opened blank.
--
-- Why this was never seeded before, from the comment on PAYMENT_RECEIPT_TEMPLATE
-- in src/lib/email.ts: the 'payment_receipt' enum value "cannot be used in the
-- same transaction that adds it". True, and it is why 20260902093000 could only
-- add the value. This migration is a separate transaction, so it can use it.
-- Until now the fix was a button in Admin that somebody had to notice.
--
-- The wording is the wording Gold Star's current system already sends under
-- "Payment Received - Thank You", copied from src/lib/email.ts so the two do not
-- drift. Anyone may edit it afterwards; this only ensures one exists.

INSERT INTO public.email_templates (key, name, category, subject, body)
SELECT
  'payment_receipt_default',
  'Payment received — thank you',
  'payment_receipt',
  'Payment received — thank you (invoice {Payment.InvoiceNumber})',
  concat_ws(E'\n',
    '<p>Hello {Contact.FirstName},</p>',
    '<p>Thank you — we received your payment of <b>{Payment.Amount}</b> on {Payment.ReceivedDate} by {Payment.Method}, applied to invoice {Payment.InvoiceNumber} for the work at {Job.SiteAddress.Full}.</p>',
    '<p>Invoice total: {Payment.InvoiceTotal}<br/>Received to date: {Payment.PaidToDate}<br/>Balance remaining: {Payment.BalanceAfter}</p>',
    '<p>Your receipt is below. Please keep it for your records.</p>',
    '<p>{Office - Company Name}<br/>{Office Phone}</p>'
  )
-- Only when the office has not already written their own. A second template
-- with the same purpose would make the auto-select a coin toss.
WHERE NOT EXISTS (
  SELECT 1 FROM public.email_templates
   WHERE category = 'payment_receipt' AND location_id IS NULL
);
