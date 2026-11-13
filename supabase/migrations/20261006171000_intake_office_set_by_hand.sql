-- Intake office, set by hand: the quick switch on the intake card.
--
-- Mark, on an intake card badged "NY-UP · NY-UPSTATE · FROM ADDRESS": "give a
-- way to switch the office quickly if they don't like the match".
--
-- Switching needs no new permission. intake_submissions_write
-- (20260903223000, live) already says it: a waiting form in an office is
-- written by whoever can_manage_location that office (USING), and the row it
-- becomes must be in an office they can manage too (WITH CHECK). So a manager
-- can hand a form to another office they manage, privileged staff can send it
-- anywhere, and nobody can push a form into an office they could not then see
-- or pull one out of an office they do not manage. This file does not touch
-- that policy.
--
-- What it adds is the record of the choice, so it is VISIBLE ("set by Dana")
-- and so re-routing never undoes it:
--   1. location_set_by / location_set_at on intake_submissions;
--   2. a trigger that stamps them from the session — the browser asks for a
--      manual choice, the database writes WHO and WHEN, so a client cannot
--      credit someone else — and marks the row not auto-assigned. The
--      Territory page's re-route only moves auto-assigned (or unplaced) rows
--      (planIntakeRematch, and the same filter on its UPDATE), so a choice a
--      person made is never overwritten by a rule.
--
-- Not applied by the agent that wrote it. Safe to re-run. Until it is applied
-- the switch still works — it saves the office and clears the auto flag — and
-- the badge simply has no "set by" name.

ALTER TABLE public.intake_submissions
  ADD COLUMN IF NOT EXISTS location_set_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS location_set_at timestamptz;

-- A signed-in session asking for a manual choice (location_set_by given, with
-- a new office or a new chooser) is stamped as itself, now. The service role
-- (no auth.uid()) is left alone: it never makes manual choices.
CREATE OR REPLACE FUNCTION public.stamp_intake_office_choice()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL OR NEW.location_set_by IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.location_id IS DISTINCT FROM OLD.location_id
     OR NEW.location_set_by IS DISTINCT FROM OLD.location_set_by THEN
    NEW.location_set_by := auth.uid();
    NEW.location_set_at := now();
    NEW.location_auto_assigned := false;
  ELSE
    -- Nothing chosen: the stamp a person earned stays as it was.
    NEW.location_set_at := OLD.location_set_at;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.stamp_intake_office_choice() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS intake_submissions_stamp_office_choice ON public.intake_submissions;
CREATE TRIGGER intake_submissions_stamp_office_choice
  BEFORE UPDATE OF location_id, location_set_by, location_set_at ON public.intake_submissions
  FOR EACH ROW EXECUTE FUNCTION public.stamp_intake_office_choice();
