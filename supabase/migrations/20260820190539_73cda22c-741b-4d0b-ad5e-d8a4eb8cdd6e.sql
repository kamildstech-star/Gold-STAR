ALTER TABLE public.translations ADD COLUMN IF NOT EXISTS source_hash text;

COMMENT ON COLUMN public.translations.source_hash IS
  'Fingerprint of source_text. A translation is only rendered when this matches the current English for the same field.';

-- Older job work orders were stored as one combined "scope" row, so the
-- Spanish column could show text from a different field. Drop any job
-- translation whose English no longer equals the exact field it claims to
-- translate; the UI re-translates per field on demand.
DELETE FROM public.translations t
WHERE t.entity_type = 'job'
  AND NOT EXISTS (
    SELECT 1
    FROM public.jobs j
    WHERE j.id = t.entity_id
      AND (
        (t.field = 'scope' AND j.scope IS NOT DISTINCT FROM t.source_text)
        OR (t.field = 'important_instructions' AND j.important_instructions IS NOT DISTINCT FROM t.source_text)
      )
  );
