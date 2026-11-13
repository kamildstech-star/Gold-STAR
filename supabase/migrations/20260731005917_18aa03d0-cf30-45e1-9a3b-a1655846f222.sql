-- Link fire leads and incidents to accounts.
-- HPD gives us a registered owner name on ~98% of fire leads; matching those
-- against existing accounts surfaces "this burning building belongs to a
-- property manager we already work with", which is a materially better lead.
ALTER TABLE public.fire_leads
  ADD COLUMN IF NOT EXISTS account_id uuid REFERENCES public.accounts(id) ON DELETE SET NULL;

ALTER TABLE public.incidents
  ADD COLUMN IF NOT EXISTS account_id uuid REFERENCES public.accounts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_fire_leads_account_id
  ON public.fire_leads(account_id) WHERE account_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_incidents_account_id
  ON public.incidents(account_id) WHERE account_id IS NOT NULL;

-- Reverse lookups from an account hub page.
CREATE INDEX IF NOT EXISTS idx_jobs_account_id
  ON public.jobs(account_id) WHERE account_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_projects_account_id
  ON public.projects(account_id) WHERE account_id IS NOT NULL;