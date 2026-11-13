-- A customer's emailed answer to a request for information, held as suggested
-- job fields for a person to apply.
--
-- WRITTEN, NOT APPLIED. Adds columns to intake_submissions; no new table, no
-- policy on it changes. Until this is applied the Outlook sync cannot store a
-- suggestion and files a single "Review reply" task instead (the behaviour the
-- office had before, minus having to log it by hand), and the job's review
-- panel reads form submissions exactly as before.
--
-- Mark, 13 Oct: "when you send an email for info, it needs to have a pop up or
-- a bubble or something that shows that info that should be inputted into the
-- correct fields in the job not as a task".
--
-- WHY intake_submissions: it is already "values someone outside the company
-- gave us about this job, waiting for staff to accept them" — pending /
-- applied / dismissed, shown against the job, visible to whoever can see the
-- job and writable by whoever can manage it (policies from 20260903223000,
-- plus the restrictive guards of 20260929121000). An emailed answer is the
-- same thing arriving by a different door, so it gets a `source` rather than
-- a parallel table with a parallel set of policies to keep in step.
--
--   source              'form' (the secure intake link, every existing row)
--                       or 'email_reply' (read from an Outlook reply by
--                       src/lib/info-reply.server.ts, service role only).
--   source_message_id   The Graph message id. Unique, so a re-sync of the
--                       same email never files a second suggestion.
--   source_subject /    What the review panel shows as "the email this came
--   source_excerpt /    from". The excerpt is the customer's own new text,
--   source_received_at  capped; the message itself stays in the mailbox.
--   field_review        Per-field decisions made in the review panel:
--                       {"f:loss_date": {"status": "applied", ...}}. The row's
--                       status becomes applied/dismissed once every field is
--                       decided. Written by staff through the existing
--                       intake_submissions_write policy (can_manage_job).
--
-- The source_* columns are fixed once written: an UPDATE keeps the old values,
-- so the review panel can never be made to show a different email than the
-- one that was read.

ALTER TABLE public.intake_submissions
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'form',
  ADD COLUMN IF NOT EXISTS source_message_id text,
  ADD COLUMN IF NOT EXISTS source_subject text,
  ADD COLUMN IF NOT EXISTS source_excerpt text,
  ADD COLUMN IF NOT EXISTS source_received_at timestamptz,
  ADD COLUMN IF NOT EXISTS field_review jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'intake_submissions_source_check'
      AND conrelid = 'public.intake_submissions'::regclass
  ) THEN
    ALTER TABLE public.intake_submissions
      ADD CONSTRAINT intake_submissions_source_check
      CHECK (source IN ('form', 'email_reply'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'intake_submissions_source_text_check'
      AND conrelid = 'public.intake_submissions'::regclass
  ) THEN
    ALTER TABLE public.intake_submissions
      ADD CONSTRAINT intake_submissions_source_text_check
      CHECK (
        coalesce(length(source_subject), 0) <= 1000
        AND coalesce(length(source_excerpt), 0) <= 4000
        AND coalesce(length(source_message_id), 0) <= 512
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'intake_submissions_field_review_check'
      AND conrelid = 'public.intake_submissions'::regclass
  ) THEN
    ALTER TABLE public.intake_submissions
      ADD CONSTRAINT intake_submissions_field_review_check
      CHECK (jsonb_typeof(field_review) = 'object');
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS intake_submissions_source_message_uniq
  ON public.intake_submissions (source_message_id)
  WHERE source_message_id IS NOT NULL;

-- The source of a suggestion is a fact about where it came from, not
-- something the review edits.
CREATE OR REPLACE FUNCTION public.tg_intake_submissions_keep_source()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.source := OLD.source;
  NEW.source_message_id := OLD.source_message_id;
  NEW.source_subject := OLD.source_subject;
  NEW.source_excerpt := OLD.source_excerpt;
  NEW.source_received_at := OLD.source_received_at;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_intake_submissions_keep_source() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS intake_submissions_keep_source ON public.intake_submissions;
CREATE TRIGGER intake_submissions_keep_source
  BEFORE UPDATE ON public.intake_submissions
  FOR EACH ROW EXECUTE FUNCTION public.tg_intake_submissions_keep_source();

-- Access is unchanged. The restrictive guards every RLS table carries
-- (20260929121000) are restated so this file stands on its own.
REVOKE ALL ON public.intake_submissions FROM anon;

DROP POLICY IF EXISTS active_profile_required ON public.intake_submissions;
CREATE POLICY active_profile_required ON public.intake_submissions
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT goldstar_private.profile_is_active(auth.uid())))
  WITH CHECK ((SELECT goldstar_private.profile_is_active(auth.uid())));
DROP POLICY IF EXISTS anonymous_business_access_denied ON public.intake_submissions;
CREATE POLICY anonymous_business_access_denied ON public.intake_submissions
  AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'portal_customer') THEN
    DROP POLICY IF EXISTS portal_customer_denied ON public.intake_submissions;
    CREATE POLICY portal_customer_denied ON public.intake_submissions
      AS RESTRICTIVE FOR ALL TO portal_customer USING (false) WITH CHECK (false);
  END IF;
END $$;
