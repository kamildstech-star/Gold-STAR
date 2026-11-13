-- A flat-fee override for one job's referrer commission.
--
-- Mark, 7 Oct: "commission amount, which will auto calculate as the charges
-- get added, or a flat fee". The job already carries a percentage override,
-- commission_rate_pct (20260918190000: NULL = use the rate for the source, a
-- number = this job only). A flat fee is the same decision in dollars, so it
-- is its sibling column rather than a second override table: NULL = use the
-- deal (referrer rule or source rate), a number = this job pays exactly this.
--
-- The two are exclusive. A job with both a 10% override and a $500 override
-- has no answer to "what is owed", so the database refuses the pair; the
-- Commissions card clears one when the other is typed.
--
-- RLS unchanged: the column inherits the jobs policies, like the commission
-- columns before it. It is money, so it is NOT added to
-- job_revertable_fields() (20261006152000 leaves commission out on purpose).

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS commission_flat_amount numeric(12,2);

ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS job_commission_flat_sane;
ALTER TABLE public.jobs
  ADD CONSTRAINT job_commission_flat_sane
  CHECK (commission_flat_amount IS NULL OR commission_flat_amount >= 0);

ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS job_commission_one_override;
ALTER TABLE public.jobs
  ADD CONSTRAINT job_commission_one_override
  CHECK (commission_flat_amount IS NULL OR commission_rate_pct IS NULL);

COMMENT ON COLUMN public.jobs.commission_flat_amount IS
  'Flat referrer commission for this job only. NULL uses the referrer''s rule or the commission_source rate. Exclusive with commission_rate_pct.';
