-- Interior readings, the water category, the baseline set, and a photograph of
-- the meter behind every number.
--
-- From the 2026-09-04 call with Melly Chein, in her words:
--
--   "I need one for outside exterior, I need one for interior. So exterior, I
--    need it to measure automatically every morning at nine o'clock. And then
--    interior, we're going to manually put in there... or we'll manually have
--    to put in the temperature and the humidity, in addition to uploading the
--    picture."
--
--   "if it's a regular sink water category one, or a stormwater category two,
--    sewage is category three -- it's a different type of category."
--
-- and, on the baseline set, that the readings taken when the job starts and
-- when the equipment is dropped "should really be the same time".
--
-- Four things, all additive:
--
--   1. `point` admits 'interior'  -- the inside pair to the automatic exterior
--      baseline. One figure a day for the whole property, never fetched: no
--      weather model knows what the inside of a flooded house reads.
--   2. `jobs.water_category`      -- 1 clean / 2 grey / 3 black.
--   3. `is_baseline`              -- the set every later day is read against.
--   4. photo columns + a private  -- the picture of the meter that turns a
--      `drying-photos` bucket        typed number into evidence.
--
-- NOT IN THIS FILE: reading the numbers off the photograph. Melly asked
-- whether that could be automatic and the answer is "later, and this is where
-- it lands" -- `values_source` is the column that will record it, and
-- src/lib/drying-meter-photo.ts holds the code seam. Nothing writes anything
-- but 'typed' today.
--
-- DEPENDS ON 20260901120000_drying_log, which is itself written and NOT YET
-- APPLIED (see supabase/MIGRATION_RECONCILIATION.md). Run that one first. The
-- application code degrades while both are pending: it probes for these
-- columns, hides interior entry and the photo field when they are absent, and
-- writes every reading without them rather than losing it.
--
-- Re-runnable: migrations here are applied by hand and sometimes by Lovable,
-- so a second pass must be a no-op. Nothing is dropped and no type is changed.

-- ---------------------------------------------------------------------------
-- 1. The interior point
-- ---------------------------------------------------------------------------
-- The check is named in 20260901120000 only implicitly (it is inline on the
-- column), so production may carry it under either the inline name or Lovable's
-- own. Both are dropped and one is installed, which is also what makes this
-- file safe to run twice.

DO $$
DECLARE con text;
BEGIN
  FOR con IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.job_drying_readings'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%point%'
       AND pg_get_constraintdef(oid) ILIKE '%exterior%'
  LOOP
    EXECUTE format('ALTER TABLE public.job_drying_readings DROP CONSTRAINT %I', con);
  END LOOP;
END $$;

-- NOT VALID so a row already in the table cannot fail the migration; every
-- existing value is one of the original four, so the VALIDATE below is instant.
DO $$ BEGIN
  ALTER TABLE public.job_drying_readings
    ADD CONSTRAINT job_drying_readings_point_check
    CHECK (point IN ('exterior', 'interior', 'unaffected', 'affected', 'dehu_outlet')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.job_drying_readings VALIDATE CONSTRAINT job_drying_readings_point_check;

-- ---------------------------------------------------------------------------
-- 2. The water category on the job
-- ---------------------------------------------------------------------------
-- Deliberately not folded into `loss_type`. Loss type says what happened
-- (water, fire, mould); category says how dirty the water was, and only the
-- category decides whether a wet carpet is dried in place or cut out and
-- binned. A water loss can be any of the three, so one column cannot carry
-- both. Nullable because a job whose category nobody has set must read as
-- unset -- defaulting it to 1 would tell a crew that sewage is clean.

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS water_category smallint;

DO $$ BEGIN
  ALTER TABLE public.jobs
    ADD CONSTRAINT jobs_water_category_check
    CHECK (water_category IS NULL OR water_category IN (1, 2, 3)) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.jobs VALIDATE CONSTRAINT jobs_water_category_check;

COMMENT ON COLUMN public.jobs.water_category IS
  'IICRC S500 water category: 1 clean (supply line, sink), 2 grey (storm water, appliance discharge), 3 black (sewage, ground surface water). NULL means nobody has set it -- never assume 1.';

-- ---------------------------------------------------------------------------
-- 3. The baseline set, the meter photo, and where the numbers came from
-- ---------------------------------------------------------------------------

ALTER TABLE public.job_drying_readings
  -- The set the whole job is read against: taken at the start, or when the
  -- equipment went in, which should be the same visit.
  ADD COLUMN IF NOT EXISTS is_baseline boolean NOT NULL DEFAULT false,
  -- Object name in the private 'drying-photos' bucket, or NULL. The row only
  -- ever points at a file that is already uploaded -- src/lib/drying-log.ts
  -- writes the numbers first, uploads, and only then sets this.
  ADD COLUMN IF NOT EXISTS photo_path text,
  ADD COLUMN IF NOT EXISTS photo_thumb_path text,
  ADD COLUMN IF NOT EXISTS photo_mime text,
  -- Where the two figures came from. 'typed' is a technician at a meter, which
  -- is everything today. 'photo_ocr' is reserved for the automatic read Melly
  -- asked about; when it lands, a row filled by a machine has to be
  -- distinguishable from one a person read, forever, because an adjuster is
  -- entitled to know which is which.
  ADD COLUMN IF NOT EXISTS values_source text NOT NULL DEFAULT 'typed';

DO $$ BEGIN
  ALTER TABLE public.job_drying_readings
    ADD CONSTRAINT job_drying_readings_values_source_check
    CHECK (values_source IN ('typed', 'photo_ocr')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.job_drying_readings VALIDATE CONSTRAINT job_drying_readings_values_source_check;

COMMENT ON COLUMN public.job_drying_readings.is_baseline IS
  'Part of the baseline set taken at job start / equipment drop. Later days are read against it to show the property drying.';
COMMENT ON COLUMN public.job_drying_readings.values_source IS
  'typed = read off a meter by a technician. photo_ocr = reserved for automatic reading of photo_path; nothing writes it yet.';

-- Finding the baseline rows quickly. There is deliberately NO unique index
-- forcing one baseline row per place.
--
-- It was written and then removed. A crew that re-reads a chamber on the
-- baseline day would produce a second flagged row for the same place, and a
-- unique index would answer with 23505 -- which the offline queue retries
-- forever, so a reading taken in a basement would sit on a tablet and never
-- land. Losing evidence to protect a tidy flag is the wrong trade.
--
-- What resolves the ambiguity instead is the read: findBaselineSet in
-- src/lib/drying-baseline.ts takes the earliest flagged day and the wettest
-- reading of each point on it, which is deterministic whatever is flagged, and
-- the entry form will not offer the tick once a baseline stands on another day.
CREATE INDEX IF NOT EXISTS job_drying_readings_baseline_idx
  ON public.job_drying_readings (job_id, reading_date)
  WHERE is_baseline;

-- ---------------------------------------------------------------------------
-- 4. The private bucket for meter photographs
-- ---------------------------------------------------------------------------
-- Its own bucket, and private, like every other bucket here. 'documents' is
-- readable by everyone who can see the row's location; a photograph taken
-- inside somebody's flooded home is narrower than that and is evidence in a
-- claim. 8MB is generous for a 2048px WebP -- the tablet re-encodes before it
-- uploads (src/lib/drying-meter-photo.ts) -- while still admitting the
-- original bytes when a browser could not decode the camera's file.
--
-- Path convention: {user_id}/{job_id}/{reading_id}.{ext}. The leading segment
-- is the uploader, mirroring 'tradeshow-leads', so the storage policy can be
-- checked from the object name alone.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'drying-photos',
  'drying-photos',
  false,
  8388608,
  ARRAY['image/webp', 'image/jpeg', 'image/png', 'image/heic', 'image/heif']
)
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Who may see a meter photo: whoever uploaded it, or anyone who can see the
-- reading it evidences. The second branch reads through the row, so the photo's
-- audience is exactly job_drying_readings_select's audience and cannot drift
-- from it.
DROP POLICY IF EXISTS drying_photos_read ON storage.objects;
CREATE POLICY drying_photos_read
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'drying-photos'
  AND (
    (owner = auth.uid() AND split_part(name, '/', 1) = auth.uid()::text)
    OR EXISTS (
      SELECT 1 FROM public.job_drying_readings r
       WHERE (r.photo_path = storage.objects.name OR r.photo_thumb_path = storage.objects.name)
         AND public.can_view_job(auth.uid(), r.job_id)
    )
  )
);

DROP POLICY IF EXISTS drying_photos_insert ON storage.objects;
CREATE POLICY drying_photos_insert
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'drying-photos'
  AND owner = auth.uid()
  AND split_part(name, '/', 1) = auth.uid()::text
);

-- Update is what `upsert: true` needs when a held reading is replayed after a
-- lost response: the same path, written again by the same owner.
DROP POLICY IF EXISTS drying_photos_update ON storage.objects;
CREATE POLICY drying_photos_update
ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'drying-photos'
  AND owner = auth.uid()
  AND split_part(name, '/', 1) = auth.uid()::text
)
WITH CHECK (
  bucket_id = 'drying-photos'
  AND owner = auth.uid()
  AND split_part(name, '/', 1) = auth.uid()::text
);

-- Deleting the photograph behind a logged reading is deleting evidence, so it
-- is the uploader's own mistake to undo or a privileged user's decision --
-- the same bar job_drying_readings_delete sets on the row itself.
DROP POLICY IF EXISTS drying_photos_delete ON storage.objects;
CREATE POLICY drying_photos_delete
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'drying-photos'
  AND (
    (owner = auth.uid() AND split_part(name, '/', 1) = auth.uid()::text)
    OR public.is_privileged(auth.uid())
  )
);
