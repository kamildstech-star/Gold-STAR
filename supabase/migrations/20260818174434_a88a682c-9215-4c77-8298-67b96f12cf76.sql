ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS independent_reviewer_account_id uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS independent_reviewer_contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS independent_reviewer_firm text,
  ADD COLUMN IF NOT EXISTS independent_reviewer_name text,
  ADD COLUMN IF NOT EXISTS independent_reviewer_email text,
  ADD COLUMN IF NOT EXISTS independent_reviewer_phone text;

CREATE INDEX IF NOT EXISTS jobs_independent_reviewer_account_idx
  ON public.jobs (independent_reviewer_account_id);
CREATE INDEX IF NOT EXISTS jobs_independent_reviewer_contact_idx
  ON public.jobs (independent_reviewer_contact_id);