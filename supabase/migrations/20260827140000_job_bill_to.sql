-- Who we bill, as opposed to which of our entities is billing.
--
-- `jobs.billing_location_id` is the GSR office whose EIN, logo and payment link
-- go on the paperwork. It was the only "billing" field on a job, and it was
-- read as the customer's billing entity, which it never was. The counterpart —
-- the legal name and address the invoice is addressed to — had no column at
-- all, so a job at a rental unit had no way to say the bill goes to the
-- managing agent rather than the tenant standing in the water.
--
-- A pointer at `accounts`, not a copied name and address. Accounts already
-- carry name / address_line1 / city / state / postal_code / email, the exact
-- projection the invoice and estimate PDFs already print in their Bill To
-- block, and the payer is nearly always a property manager, landlord LLC or
-- carrier that is already a CRM record. Duplicating those fields onto `jobs`
-- would give the same company two addresses that drift apart silently, which
-- is the failure this whole change exists to undo.
--
-- ON DELETE SET NULL, not CASCADE: losing the account must not delete the job.
-- Null is a meaningful value here and always will be — it means "bill the
-- customer", which is what most jobs do, so there is no default and no
-- backfill. Every existing job keeps addressing its documents exactly as it
-- does today.

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS bill_to_account_id uuid
    REFERENCES public.accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS bill_to_attention text;

COMMENT ON COLUMN public.jobs.bill_to_account_id IS
  'The customer-side party the invoice is addressed to (property manager, landlord LLC, carrier). Null means bill the job''s own customer. Not to be confused with billing_location_id, which is the GSR entity doing the billing.';
COMMENT ON COLUMN public.jobs.bill_to_attention IS
  'Attn: line printed above the bill-to address. Per job — an AP contact or unit reference belongs to this invoice, not to the account.';

-- The PDF builders reach the payer through the job, and the accounts screens
-- will want "which jobs bill to this company". Partial: the column is null on
-- most rows and those are not a lookup anybody performs.
CREATE INDEX IF NOT EXISTS jobs_bill_to_account_id_idx
  ON public.jobs (bill_to_account_id) WHERE bill_to_account_id IS NOT NULL;

-- No policy change. `jobs` is protected by table-level policies only
-- (jobs_select / jobs_insert / jobs_update / jobs_delete, most recently
-- rewritten in 20260818175247 and 20260820071015) with a table-wide
-- GRANT SELECT, INSERT, UPDATE, DELETE ... TO authenticated from 20260728041824
-- — there are no column privileges on this table, so a new column is readable
-- and writable by exactly the people who can already read and write the row.
--
-- Reading the account behind the pointer stays governed by accounts_select, so
-- a user who cannot see the payer account gets no row for it rather than a
-- leaked name; the UI has to render that as unknown, not as unset.
