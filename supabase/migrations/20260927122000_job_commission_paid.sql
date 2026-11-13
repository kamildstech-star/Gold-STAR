-- Whether a job's commission has actually been paid.
--
-- David, 24 Sep: "I want to be able to mark off if the payment was actually
-- made or still outstanding... track commissions paid versus outstanding...
-- tied into reports."
--
-- Built on the per-job commission of 20260918190000 (commission_source +
-- commission_rate_pct, rates in app_settings 'commission_rates'). A job whose
-- commission has a source and no paid date is OUTSTANDING; marking it paid
-- records when, against what (a cheque number, a payroll run), how much was
-- actually paid, and who marked it. The amount is stored because the job's
-- revenue — and so the computed commission — can still move after a payment
-- has gone out; what was paid should not move with it.
--
-- RLS unchanged: the columns inherit the jobs policies, like the commission
-- columns before them.

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS commission_paid_on date,
  ADD COLUMN IF NOT EXISTS commission_paid_ref text,
  ADD COLUMN IF NOT EXISTS commission_paid_amount numeric(12,2),
  ADD COLUMN IF NOT EXISTS commission_paid_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS job_commission_paid_amount_sane;
ALTER TABLE public.jobs
  ADD CONSTRAINT job_commission_paid_amount_sane
  CHECK (commission_paid_amount IS NULL OR commission_paid_amount >= 0);

-- The commissions report reads jobs that carry a commission.
CREATE INDEX IF NOT EXISTS jobs_commission_source_idx
  ON public.jobs (commission_source, created_at DESC) WHERE commission_source IS NOT NULL;
