-- Blank lines on a job calculation.
--
-- David, 16 Sep: he wanted a small "add item" control at the bottom of the Job
-- Calculator that drops in an empty row he can type into, several times over.
--
-- The calculator's catalogue is fixed on purpose — a shared list of labour,
-- equipment and supply rates is what stops two estimators pricing the same job
-- two different ways. So a job needing a dumpster permit, a specialist
-- subcontractor or any other one-off had nowhere to say so, and the habit was
-- to bend "Miscellaneous" into meaning four unrelated things at once.
--
-- Stored as jsonb rather than a child table: these lines have no life of their
-- own. They are never queried across estimates, never reported on, and never
-- exist apart from the calculation that carries them — they are part of the
-- sheet, the way `equipment_quantities` already is on this same row.
--
-- Shape: [{ "label": text, "amount": number }]. The app drops rows with neither
-- a label nor an amount before writing, so a user who adds three lines and
-- fills one stores one.

ALTER TABLE public.job_calculations
  ADD COLUMN IF NOT EXISTS custom_lines jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.job_calculations.custom_lines IS
  'Free-typed estimate lines: [{"label": text, "amount": number}]. Part of the sheet, like equipment_quantities.';

-- A malformed value would break the calculator for that estimate, and the app
-- is not the only thing that can write here.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'job_calculations_custom_lines_is_array'
  ) THEN
    ALTER TABLE public.job_calculations
      ADD CONSTRAINT job_calculations_custom_lines_is_array
      CHECK (jsonb_typeof(custom_lines) = 'array');
  END IF;
END $$;
