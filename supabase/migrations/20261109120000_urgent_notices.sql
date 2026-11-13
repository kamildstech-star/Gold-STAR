-- ---------------------------------------------------------------------------
-- Urgent (pinned) job notices. 5 Nov review (T4): "Don't block driveway",
-- "Call 30 min before" were missed inside the collapsed Notices strip. A
-- notice marked urgent is shown at the top of the job, outside the strip.
--
-- A notice lives where it is written, so the flag does too:
--   jobs.important_instructions_urgent   the job's on-site warning
--   property_notes.urgent                 the note on the address
--   accounts.standing_note_urgent         the note on the customer
-- Additive, default false: every existing notice stays where it is.
-- ---------------------------------------------------------------------------
ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS important_instructions_urgent boolean NOT NULL DEFAULT false;
ALTER TABLE public.property_notes
  ADD COLUMN IF NOT EXISTS urgent boolean NOT NULL DEFAULT false;
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS standing_note_urgent boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.jobs.important_instructions_urgent IS
  'Pin the on-site warning at the top of the job page (5 Nov, T4).';
COMMENT ON COLUMN public.property_notes.urgent IS
  'Pin this property note at the top of every job at the address (5 Nov, T4).';
COMMENT ON COLUMN public.accounts.standing_note_urgent IS
  'Pin the account note at the top of every job for the account (5 Nov, T4).';

-- ROLLBACK: drop the three columns.
