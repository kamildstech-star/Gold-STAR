-- Trade show intake links.
--
-- A show gets its own intake form URL — a QR code on the booth, a tablet on
-- the table, a link in the follow-up email — and every submission through it
-- is attributed to that show, the same way a lead captured on the tablet is.
--
-- Two things the standalone link did not have:
--
--   * a home. `tradeshow_id` ties the request, and everything submitted
--     through it, to the show.
--   * many uses. A standalone link is minted for one person and closes after
--     one submission (`submitted_at`). A QR code on a booth is scanned by
--     everyone who walks past, so `multi_use` says the link stays open until
--     it expires or is revoked.
--
-- A booth submission creates the account on the way in (server side, same
-- fields the tablet capture writes), and the submission remembers which one
-- so the inbox and the show page can point at it.

ALTER TABLE public.intake_requests
  ADD COLUMN IF NOT EXISTS tradeshow_id uuid REFERENCES public.tradeshows(id) ON DELETE SET NULL;
ALTER TABLE public.intake_requests
  ADD COLUMN IF NOT EXISTS multi_use boolean NOT NULL DEFAULT false;

-- Visibility of a request keys off job_id, then location_id (see
-- 20260831190500_standalone_intake_links.sql). A show link is never on a job,
-- so it must carry the office, or nobody but a privileged user could see it.
ALTER TABLE public.intake_requests DROP CONSTRAINT IF EXISTS intake_requests_show_has_location;
ALTER TABLE public.intake_requests
  ADD CONSTRAINT intake_requests_show_has_location
  CHECK (tradeshow_id IS NULL OR location_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS intake_requests_tradeshow_idx
  ON public.intake_requests (tradeshow_id) WHERE tradeshow_id IS NOT NULL;

ALTER TABLE public.intake_submissions
  ADD COLUMN IF NOT EXISTS account_id uuid REFERENCES public.accounts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS intake_submissions_account_idx
  ON public.intake_submissions (account_id) WHERE account_id IS NOT NULL;

-- No policy changes: a show request always has a location_id (constraint
-- above), so the existing location-scoped select/write policies on
-- intake_requests and intake_submissions already cover it.
