-- People: the employment stage and start date Melly's People tab needs.
--
-- Melly, 6 Nov (GSR Edits): one People tab replacing Reassign a book, People
-- and pay and Offboarding — "simple cards for everyone: name, title, time at
-- Gold Star … Stages: Interviewing, Onboarding, Active, Offboarding, Former."
--
-- Offboarding and Former already follow from records (an open offboarding
-- checklist; a deactivated profile — src/lib/people.ts derives them).
-- Interviewing and Onboarding have nothing behind them, so they are stored
-- here, with the day the person started for "time at Gold Star".
--
-- Written only by set_person_employment(), gated to owners, admins and
-- developers like the three pages this replaces. Neither column is in the
-- profiles column-level UPDATE grant (20260903130000), so a user cannot set
-- their own stage directly.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS employment_stage text,
  ADD COLUMN IF NOT EXISTS employment_started_on date;

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_employment_stage_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_employment_stage_check
  CHECK (employment_stage IS NULL
         OR employment_stage IN ('interviewing', 'onboarding', 'active', 'offboarding', 'former'));

COMMENT ON COLUMN public.profiles.employment_stage IS
  'Set by a manager for Interviewing or Onboarding. Offboarding and Former are derived from an open offboarding checklist and a deactivated profile (src/lib/people.ts).';
COMMENT ON COLUMN public.profiles.employment_started_on IS
  'The day the person started at Gold Star, for "time at Gold Star" on the People page.';

CREATE OR REPLACE FUNCTION public.set_person_employment(
  _user_id uuid,
  _stage text DEFAULT NULL,
  _started_on date DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_privileged(auth.uid()) THEN
    RAISE EXCEPTION 'Only an owner, admin or developer can change a person''s stage.'
      USING ERRCODE = '42501';
  END IF;
  IF _stage IS NOT NULL AND _stage NOT IN ('interviewing', 'onboarding', 'active') THEN
    RAISE EXCEPTION 'Offboarding and Former follow from the offboarding checklist and the lockout.'
      USING ERRCODE = '22023';
  END IF;
  UPDATE public.profiles
     SET employment_stage = _stage,
         employment_started_on = _started_on
   WHERE user_id = _user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No such person.' USING ERRCODE = '22023';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.set_person_employment(uuid, text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_person_employment(uuid, text, date) TO authenticated;
