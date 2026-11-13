-- The public intake form, trimmed.
--
-- The client: "cut it down to just the first four questions that are on the
-- intake form right now. Then there should be an option to add photos and a
-- box for notes. Photos and notes are optional but the first four should be
-- with an asterisk." The four are the property address, the person's name,
-- their phone and their email — the fields a lead cannot be worked without.
-- Loss type, dates, carrier, claim and policy come off the public form; the
-- office asks those on the call.
--
-- Two things the schema needs for that:
--
--   * a way for the office to put a questionnaire item BACK on the public form
--     without a deploy. The admin screen still defines the questions; this
--     flag says which of them the public form asks. Default off, so the form
--     is exactly the four fields, photos and notes until somebody opts a
--     question in.
--   * somewhere to keep the photos. A submission is not a job yet, so the
--     photos cannot go in `photos` (which hangs off a project). They live in
--     a private bucket of their own and the submission lists them.

ALTER TABLE public.intake_questions
  ADD COLUMN IF NOT EXISTS ask_on_public_form boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.intake_questions.ask_on_public_form IS
  'Asked on the public intake form in addition to the four required fields. Off by default; the internal job form ignores this.';

ALTER TABLE public.intake_submissions
  ADD COLUMN IF NOT EXISTS photos jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.intake_submissions.photos IS
  'Array of {path, name, mime, size} in the intake-uploads bucket, path prefixed by the request id.';

-- Private bucket. The public form uploads through a signed upload URL minted
-- by the server against the link token; staff view through signed read URLs
-- minted after RLS on intake_submissions has let them read the row. So there
-- are no storage policies for authenticated here on purpose — the bucket is
-- reachable only through those two server paths.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'intake-uploads',
  'intake-uploads',
  false,
  15728640,
  ARRAY['image/jpeg','image/png','image/webp','image/heic','image/heif','image/gif']
)
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;
