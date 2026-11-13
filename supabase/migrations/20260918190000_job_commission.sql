-- Commission on a job, so the profit line is the one David actually keeps.
--
-- David, 17 Sep, pointing at the job money area: "this should be the running
-- costs also — it should have the revenue, the labor hours spent on the job
-- and what it costs us... pretty much the items like I have on the spreadsheet
-- I sent you — that we track all the jobs, that counts the days and the guys
-- and the hours and our expenses, what we're billing and all that,
-- commissions. I want to try to replicate that in the system... the goal is to
-- just have one automated system and everybody shouldn't have to put
-- everything in five times."
--
-- Almost every column of that sheet already has a live source: running costs
-- compute labour, equipment, supplies, subcontractors, expenses and referral,
-- and invoices carry billed and paid. Commission was the one with nowhere to
-- come from, so it is the only thing this migration adds.

-- Where the job came from, and what that costs ------------------------------
-- Two columns on the job rather than a table: a job has ONE referral source
-- and ONE rate, and a second table would be a join for every row of a report
-- that is already joining four.
--
-- The rate is nullable ON PURPOSE. Null means "use the rate for this source",
-- which is the normal case and keeps the rate table meaningful; a number here
-- is a deliberate override for this one job, which David asked for.
ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS commission_source text,
  ADD COLUMN IF NOT EXISTS commission_rate_pct numeric(5,2);

DO $$ BEGIN
  ALTER TABLE public.jobs
    ADD CONSTRAINT job_commission_rate_sane
    CHECK (commission_rate_pct IS NULL OR (commission_rate_pct >= 0 AND commission_rate_pct <= 100));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN public.jobs.commission_source IS
  'Who the job came from — matches a key in the commission_rates setting.';
COMMENT ON COLUMN public.jobs.commission_rate_pct IS
  'Overrides the rate for this job only. NULL uses the rate for commission_source.';

-- The rate table ------------------------------------------------------------
-- Seeded with the rates already on file. app_settings rather than columns
-- because these change by negotiation, not by schema, and an office editing
-- them must not need a migration.
--
-- ON CONFLICT DO NOTHING: a seed is a starting point once, and must never
-- overwrite a rate somebody has since renegotiated.
INSERT INTO public.app_settings (key, value)
VALUES (
  'commission_rates',
  jsonb_build_object(
    'sources', jsonb_build_array(
      jsonb_build_object('key', 'salesman',  'label', 'Salesman',  'pct', 10),
      jsonb_build_object('key', 'broker',    'label', 'Broker',    'pct', 10),
      jsonb_build_object('key', 'pa',        'label', 'PA',        'pct', 20),
      jsonb_build_object('key', 'called_in', 'label', 'Called In', 'pct', 0),
      -- Per-person rates, which sit beside the role rates rather than under
      -- them: Gold Star pays the person, and the role is only the default.
      jsonb_build_object('key', 'shia_spira',        'label', 'Shia Spira',            'pct', 25),
      jsonb_build_object('key', 'star_moore',        'label', 'Star Moore',            'pct', 30),
      jsonb_build_object('key', 'klein_gsr',         'label', 'Klein — GSR job',       'pct', 20),
      jsonb_build_object('key', 'klein_out_of_town', 'label', 'Klein — out of town',   'pct', 25),
      jsonb_build_object('key', 'klein_in_town',     'label', 'Klein — in town',       'pct', 35)
    )
  )
)
ON CONFLICT (key) DO NOTHING;

-- RLS is untouched. jobs keeps every policy it has and the two new columns
-- inherit all of them; app_settings likewise.
