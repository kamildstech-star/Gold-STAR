-- What a job report was assembled from.
--
-- David, reading a generated report on a call: "That's pulling random
-- information... I don't need all this information in here... we should have a
-- report section here that's blank. And you manually have to choose what
-- updates you want to put in."
--
-- `sections` is that choice, recorded on the report it produced: an object of
-- `{ fieldForm: true, photos: true, ... }` keyed by ReportSectionKey in
-- src/lib/job-report-sections.ts. Two jobs at once:
--
--   * it is the audit trail for what a sent document was allowed to contain,
--     alongside the `snapshot` column that says what it was built from; and
--   * the newest report's value seeds the next report on the same job, so the
--     office does not re-tick the same boxes every day.
--
-- Nullable on purpose. NULL means "made before reports were assembled by
-- hand", which the code reads as "show it as it was" rather than as an empty
-- selection — a default of '{}' would blank the figures panel on every
-- historical report. New rows always write an explicit object.
--
-- Additive: no default, no backfill, no constraint. Nothing that reads
-- job_reports today changes behaviour when this lands.
alter table public.job_reports
  add column if not exists sections jsonb;

comment on column public.job_reports.sections is
  'Which report sections the sender ticked, keyed by ReportSectionKey (src/lib/job-report-sections.ts). NULL = generated before reports were assembled by hand.';
