-- Large-loss expense tracking: a switch on the job.
--
-- WRITTEN, NOT APPLIED. One column and one index. Nothing existing changes.
-- Until this is applied the job's Billing tab says the large-loss section is
-- waiting on it (src/lib/large-loss-expenses.ts treats the missing column as
-- "not yet") and no expense can be added there.
--
-- David, 13 Oct: on large jobs — large loss, T&M, reconstruction — he needs to
-- track what the job spends on third-party contractors, supplies and
-- equipment, with the receipts. Not on every job, so it is switched on per
-- job. (Open question for David: switch, or a permanent tab on every job —
-- see the PR summary. Switching it to permanent is a one-line change in
-- src/lib/large-loss-expenses.ts, LARGE_LOSS_ALWAYS_ON.)
--
-- THE EXPENSES THEMSELVES need no new table: `public.expenses` already has
-- job_id, amount, spent_on, merchant, description and receipt_path, and
-- job_running_cost() already adds every expense on a job into its total
-- (the `exp` CTE). Large-loss entries are expenses with a job_id and a
-- kind of job_contractor / job_supplies / job_equipment / job_other.

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS is_large_loss boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.jobs.is_large_loss IS
  'Turns on the large-loss expense section on the job (contractors, supplies, equipment, with receipts). Set from the job''s Billing tab.';

-- The section reads a job's expenses; running cost already does, unindexed.
CREATE INDEX IF NOT EXISTS expenses_job_idx
  ON public.expenses (job_id) WHERE job_id IS NOT NULL;
