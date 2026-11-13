-- A template purpose for payment receipts.
--
-- Gold Star's current system sends a "Payment Received - Thank You" email off
-- its own template library; this is the purpose that lets Admin -> Email
-- templates hold that wording and lets the Send receipt action show it and
-- nothing else.
--
-- Re-runnable: ADD VALUE IF NOT EXISTS is a no-op when the label is already
-- there, so applying this twice is safe.
--
-- Deliberately no seed row here. A new enum label cannot be *used* in the same
-- transaction that adds it, so inserting the starter template alongside would
-- fail; the app seeds it from PAYMENT_RECEIPT_TEMPLATE (src/lib/email.ts)
-- instead, on one click in the admin screen.
--
-- Until this is applied: reads are unaffected (the app filters templates in
-- the client and never sends the literal to Postgres), and the only thing that
-- fails is an administrator trying to save a template under this purpose.

alter type public.email_category add value if not exists 'payment_receipt';
