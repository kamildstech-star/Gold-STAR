-- The second half of the booth workflow: the post-show review pass.
--
-- Mark works a show by talking, not typing — badge, voice note, next person —
-- and goes over the recordings afterwards. A capture made that way is a real
-- lead the moment it is spoken, but it has no name, no company and no number
-- until somebody listens to it. That in-between state is what this table
-- records, one row per captured account:
--
--   needs_review = true   the recording exists and nobody has written it up
--   needs_review = false  somebody saved details against it; a normal lead
--
-- It is a side table rather than columns on `accounts` on purpose. The account
-- is already the lead — it carries `tradeshow_id`, it counts on the show's
-- total, it appears on the board — and none of that should depend on a column
-- the general account code would have to learn about. A show page that cannot
-- see this table simply cannot offer the review queue; nothing else changes.
--
-- Nothing here is ever deleted. An unreviewed capture stays in the queue
-- indefinitely, because a forgotten voice note has to be visible rather than
-- silently lost — so there is deliberately no DELETE policy.

CREATE TABLE IF NOT EXISTS public.tradeshow_lead_captures (
  -- One row per captured account: the account IS the lead, this is its state.
  account_id uuid PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  tradeshow_id uuid NOT NULL REFERENCES public.tradeshows(id) ON DELETE CASCADE,
  needs_review boolean NOT NULL DEFAULT true,
  -- Whatever a scanned badge produced, verbatim. Vendors encode badges in
  -- formats nobody publishes, so this is stored as text and shown during the
  -- review pass for a human to read. Nothing parses it.
  badge_raw text,
  -- When the rep pressed record, never when the tablet found signal.
  captured_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  reviewed_by uuid,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  is_demo boolean NOT NULL DEFAULT false
);

-- The queue reads "this show, still unreviewed, oldest first".
CREATE INDEX IF NOT EXISTS tradeshow_lead_captures_review_idx
  ON public.tradeshow_lead_captures (tradeshow_id, needs_review, captured_at);

DROP TRIGGER IF EXISTS update_tradeshow_lead_captures_updated_at
  ON public.tradeshow_lead_captures;
CREATE TRIGGER update_tradeshow_lead_captures_updated_at
  BEFORE UPDATE ON public.tradeshow_lead_captures
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

GRANT SELECT, INSERT, UPDATE ON public.tradeshow_lead_captures TO authenticated;
GRANT ALL ON public.tradeshow_lead_captures TO service_role;

ALTER TABLE public.tradeshow_lead_captures ENABLE ROW LEVEL SECURITY;

-- Same audience as the recording itself: whoever captured it, plus the show's
-- leadership. Reusing the media table's function keeps the two from drifting —
-- a row here without the audio it describes would be a puzzle, and the reverse
-- would put a rep's spoken notes in front of somebody who cannot hear them.
DROP POLICY IF EXISTS tradeshow_lead_captures_select ON public.tradeshow_lead_captures;
CREATE POLICY tradeshow_lead_captures_select ON public.tradeshow_lead_captures
  FOR SELECT TO authenticated
  USING (public.can_view_tradeshow_lead_media(auth.uid(), tradeshow_id, created_by));

DROP POLICY IF EXISTS tradeshow_lead_captures_insert ON public.tradeshow_lead_captures;
CREATE POLICY tradeshow_lead_captures_insert ON public.tradeshow_lead_captures
  FOR INSERT TO authenticated
  WITH CHECK (
    created_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.tradeshows t
       WHERE t.id = tradeshow_lead_captures.tradeshow_id
         AND (t.location_id IS NULL OR public.can_view_location(auth.uid(), t.location_id))
    )
  );

-- Update carries two jobs: an offline replay rewriting the same row by id, and
-- the review pass flipping needs_review off. Both are open to the same people
-- who may read the capture, because a manager clearing a departed rep's
-- backlog of voice notes is exactly the case this page exists for.
DROP POLICY IF EXISTS tradeshow_lead_captures_update ON public.tradeshow_lead_captures;
CREATE POLICY tradeshow_lead_captures_update ON public.tradeshow_lead_captures
  FOR UPDATE TO authenticated
  USING (public.can_view_tradeshow_lead_media(auth.uid(), tradeshow_id, created_by))
  WITH CHECK (public.can_view_tradeshow_lead_media(auth.uid(), tradeshow_id, created_by));
