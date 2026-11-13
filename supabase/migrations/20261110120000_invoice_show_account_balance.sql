-- ---------------------------------------------------------------------------
-- The customer's open balance on the invoice: a switch, per invoice
-- (6 Nov voice note).
--
-- Since FE9 (28 Oct) every invoice PDF ends with "Account balance, all open
-- invoices" when the customer owes more than this one, so a customer with
-- other invoices open sees the whole account. The Follow-ups card now shows
-- that balance with a switch beside it: on (the default, what every invoice
-- did until now) prints the line at the bottom of the invoice; off leaves it
-- off this invoice. Nothing else reads the column. Re-runnable.
-- ---------------------------------------------------------------------------
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS show_account_balance boolean NOT NULL DEFAULT true;

-- VERIFY:
--   SELECT show_account_balance FROM public.invoices LIMIT 1;  -- true
-- ROLLBACK:
--   ALTER TABLE public.invoices DROP COLUMN IF EXISTS show_account_balance;
