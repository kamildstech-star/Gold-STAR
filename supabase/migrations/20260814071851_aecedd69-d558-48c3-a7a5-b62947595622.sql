ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS satisfaction_score numeric(2,1),
  ADD COLUMN IF NOT EXISTS satisfaction_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS satisfaction_updated_by uuid;

ALTER TABLE public.accounts
  ADD CONSTRAINT accounts_satisfaction_score_range
  CHECK (satisfaction_score IS NULL OR (satisfaction_score >= 0 AND satisfaction_score <= 5));