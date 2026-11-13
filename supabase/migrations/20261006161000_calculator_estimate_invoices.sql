-- Quick Estimates (Job Calculator sheets) convert to invoices.
--
-- UNAPPLIED when written (2026-10-06). The app works without it: until it is
-- applied the Billing tab simply does not offer Convert on a calculator row,
-- exactly as before.
--
-- Mark, of the calculator rows on a job's Billing tab: "these need to be able
-- to be converted to invoices." A detailed estimate already converts; its
-- invoice carries `estimate_id`, which is how the list says "invoiced as …"
-- and how a second Convert finds the first invoice instead of making another.
-- A calculator sheet needs the same link, to its own table.

-- 1. Which sheet an invoice was converted from ------------------------------
--
-- SET NULL, like estimate_id: an invoice is a billed document and outlives the
-- sheet it came from.
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS job_calculation_id uuid
    REFERENCES public.job_calculations(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.invoices.job_calculation_id IS
  'The Job Calculator sheet (Quick Estimate) this invoice was converted from, if any. Unique: one invoice per sheet. See src/lib/estimate-invoice.ts convertCalculationToInvoice.';

-- One invoice per sheet, enforced here rather than by the client's look-up
-- alone: two tabs or a double tap must produce one invoice, and the client
-- treats this index's refusal (23505) as "already invoiced".
CREATE UNIQUE INDEX IF NOT EXISTS invoices_job_calculation_id_key
  ON public.invoices (job_calculation_id)
  WHERE job_calculation_id IS NOT NULL;

-- The sheet's typed-in lines and note, which customer_price includes, are
-- readable since 20261006141500 (#302); the conversion relies on that grant.
