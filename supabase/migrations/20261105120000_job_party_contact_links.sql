-- Pick from the company, don't retype (spec BC-CON-1).
--
-- A job's people are picked from the CRM now instead of typed fresh. A pick
-- COPIES the person's name, email and phone onto the job, the same columns a
-- typed entry fills, and records which CRM contact it came from beside them.
-- The copy stays the job's own: editing the CRM record later never rewrites a
-- job, and editing the job's copy reaches the CRM only when somebody asks it to.
--
-- Most slots already had a link column (desk / field / public adjuster,
-- independent reviewer). Two did not:
--
--   jobs.adjuster_contact_id         the carrier adjuster
--   jobs.insurance_agent_contact_id  the insurance agent
--
-- and the job's Contacts tab kept no position for the person, so a picked
-- property manager arrived without the "Building super" that told you why
-- they were on the job:
--
--   job_contacts.position_key        a `contact_position` key, copied at pick
--
-- Every column is nullable and nothing backfills: existing jobs keep exactly
-- the typed values they have and display as they do today.
--
-- The app checks for each column before writing it (the job row is read with
-- select("*"), and the Contacts tab falls back to its old select), so it runs
-- correctly before this is applied — a pick just records no link until then.
--
-- Audit: log_job_field_changes() walks every column of `jobs`, so changes to
-- the two new links are logged with no change to it. They are deliberately
-- NOT added to the Revert allow-list: reverting a name already reverts what
-- the job shows, and a revertable link with no matching name would be a third
-- state nobody could read.
--
-- Re-runnable.

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS adjuster_contact_id uuid
    REFERENCES public.contacts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS insurance_agent_contact_id uuid
    REFERENCES public.contacts(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.jobs.adjuster_contact_id IS
  'CRM contact the carrier adjuster was picked from. adjuster_name/email/phone stay the job''s own copy.';
COMMENT ON COLUMN public.jobs.insurance_agent_contact_id IS
  'CRM contact the insurance agent was picked from. insurance_agent_name/email/phone stay the job''s own copy.';

CREATE INDEX IF NOT EXISTS jobs_adjuster_contact_id_idx
  ON public.jobs (adjuster_contact_id) WHERE adjuster_contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS jobs_insurance_agent_contact_id_idx
  ON public.jobs (insurance_agent_contact_id) WHERE insurance_agent_contact_id IS NOT NULL;

ALTER TABLE public.job_contacts
  ADD COLUMN IF NOT EXISTS position_key text;

COMMENT ON COLUMN public.job_contacts.position_key IS
  'Position at their company (contact_position managed list), copied when the person was picked or added. The job''s own copy.';
