-- Email delivery and open trail
--
-- `email_messages` already carries delivered_at / opened_at / bounced_at, but a
-- single timestamp column can only answer "did it ever" — never "how many
-- times, to whom, and in what order". The client wants the trail:
-- sent -> delivered -> opened, with times and recipient.
--
-- Design notes worth keeping:
--
--  * Append-only. We store every callback Resend sends, verbatim, including the
--    thirty-odd opens Gmail's image cache and Apple Mail Privacy Protection
--    generate for a single human read. Filtering happens when we DISPLAY the
--    trail, never when we record it — the day we need to explain an open count
--    to a client, the raw record has to still be there.
--
--  * The dedupe key is the Svix message id from the `svix-id` header, not
--    anything in the body. Resend's payload has no event id of its own, and
--    Svix redelivers the same message on any non-2xx or timeout. Without the
--    UNIQUE below, one flaky minute writes the same "opened" five times and the
--    count on screen becomes fiction.

-- Guarded (IF NOT EXISTS / DROP-then-CREATE) since 2026-09-03: unapplied in
-- production and applied by hand, so a second pass has to be a no-op.
CREATE TABLE IF NOT EXISTS public.email_events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Nullable: a callback can arrive for mail we have no row for (a send from
  -- the Resend dashboard, or a message deleted since). We keep the event rather
  -- than drop it, and it simply has no trail to hang from.
  email_message_id    uuid REFERENCES public.email_messages(id) ON DELETE CASCADE,

  provider            text NOT NULL DEFAULT 'resend',
  -- The provider's id for the email itself (Resend `data.email_id`), which is
  -- what `email_messages.provider_id` stores at send time. This is the join.
  provider_message_id text,
  -- The provider's id for THIS delivery of THIS event (the Svix message id).
  provider_event_id   text NOT NULL,

  event_type          text NOT NULL,
  recipient           text,
  occurred_at         timestamptz NOT NULL DEFAULT now(),
  payload             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),

  -- Webhooks are retried. This is the whole reason duplicates do not accumulate.
  UNIQUE (provider, provider_event_id)
);

-- Reading a trail is always "every event for this message, oldest first".
CREATE INDEX IF NOT EXISTS email_events_message_idx
  ON public.email_events (email_message_id, occurred_at);

-- Writing a trail is always "which message does this provider id belong to".
CREATE INDEX IF NOT EXISTS email_events_provider_message_idx
  ON public.email_events (provider_message_id);

-- The webhook resolves email_messages by the provider's id on every callback;
-- provider_id had no index because nothing used to look it up.
CREATE INDEX IF NOT EXISTS email_messages_provider_id_idx
  ON public.email_messages (provider_id)
  WHERE provider_id IS NOT NULL;

ALTER TABLE public.email_events ENABLE ROW LEVEL SECURITY;

-- Visibility follows the email itself: if you can read the message you can read
-- what happened to it. Deliberately mirrors "email log visible in scope".
DROP POLICY IF EXISTS email_events_select ON public.email_events;
CREATE POLICY email_events_select ON public.email_events
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.email_messages m
    WHERE m.id = email_events.email_message_id
      AND (m.sent_by = (SELECT auth.uid())
        OR (m.location_id IS NOT NULL
            AND public.can_view_location((SELECT auth.uid()), m.location_id)))
  ));

-- No INSERT/UPDATE/DELETE policy for `authenticated` on purpose. These rows are
-- the provider's testimony about what happened; only the webhook (service_role,
-- which bypasses RLS) may write them, and nobody may edit them afterwards.
GRANT SELECT ON public.email_events TO authenticated;
GRANT ALL ON public.email_events TO service_role;

COMMENT ON TABLE public.email_events IS
  'Append-only delivery trail from the mail provider''s webhook: one row per event delivery, deduplicated on the provider event id. Open events are recorded faithfully but are NOT evidence a human read the mail — mail clients prefetch tracking pixels. Never drive automation off an open.';

COMMENT ON COLUMN public.email_events.provider_event_id IS
  'Svix message id from the svix-id header. Stable across retries of the same event, which is what makes the UNIQUE constraint work.';
