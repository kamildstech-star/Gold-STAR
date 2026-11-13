ALTER TABLE public.location_groups
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0;

ALTER TABLE public.share_links ALTER COLUMN project_id DROP NOT NULL;

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS bill_to_account_id uuid,
  ADD COLUMN IF NOT EXISTS bill_to_attention text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'jobs_bill_to_account_id_fkey'
  ) THEN
    ALTER TABLE public.jobs
      ADD CONSTRAINT jobs_bill_to_account_id_fkey
      FOREIGN KEY (bill_to_account_id) REFERENCES public.accounts(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS jobs_bill_to_account_id_idx ON public.jobs(bill_to_account_id);