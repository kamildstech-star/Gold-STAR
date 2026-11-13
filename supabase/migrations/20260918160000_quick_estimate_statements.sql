-- Opening and closing statements for the Quick Estimate, and one optional note.
--
-- David, 17 Sep, on the calculator-style estimate he renamed Quick Estimate:
-- it has no opening or closing statement, and "I'm thinking if we should just
-- have presets... and maybe a small little section if we want to put in a
-- note."
--
-- The design constraint is his too, and it decides the shape of this: the
-- quick estimate is used standing on a driveway. "Open it up quickly... tap,
-- tap, tap, and you have your estimate." So the statements are PRESETS applied
-- automatically — nobody types them on a phone — and the note is the one place
-- typing is allowed, and is skippable.

-- 1. The presets ------------------------------------------------------------
-- app_settings, not a column: the statements belong to the company, not to one
-- estimate. Editing them in Admin changes what the next estimate prints and
-- leaves every estimate already sent alone, because the wording is copied onto
-- nothing — it is read at print time.
--
-- Seeded with wording that reads like a restoration company wrote it, which is
-- the whole point of a preset. An office is expected to edit it; it must not
-- start empty, or the first estimate goes out with no statements at all.
INSERT INTO public.app_settings (key, value)
VALUES (
  'quick_estimate_statements',
  jsonb_build_object(
    'opening',
    'Thank you for the opportunity to provide this estimate. The pricing below reflects the '
    || 'scope of work as observed at the property and is based on industry-standard rates for '
    || 'restoration services.',
    'closing',
    'This estimate is valid for 30 days. Any additional work discovered once the affected areas '
    || 'are opened will be documented and quoted separately before it is carried out. Please '
    || 'call us with any questions.'
  )
)
ON CONFLICT (key) DO NOTHING;

-- ON CONFLICT DO NOTHING, deliberately: re-running this must not overwrite the
-- wording an office has since edited in Admin. A seed is a starting point once.

-- 2. The optional note ------------------------------------------------------
-- One nullable text column. Not a table and not a second document: "a small
-- little section if we want to put in a note" is one box, and an estimate with
-- nothing in it stays NULL and prints nothing at all.
ALTER TABLE public.job_calculations
  ADD COLUMN IF NOT EXISTS note text;

COMMENT ON COLUMN public.job_calculations.note IS
  'Optional free text printed with the quick estimate. Skippable; NULL prints nothing.';

-- RLS is untouched. job_calculations already has its policies and a new column
-- inherits every one of them; app_settings likewise.
