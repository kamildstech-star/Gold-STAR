-- Email a person sent: which transport carried it, why one did not, and
-- another go for the ones that were stuck.
--
-- NOT APPLIED. Written for review; the app degrades without it (below).
--
-- THE BUG (production, 2026-10-11)
-- David Stern sent an invoice at 21:53 UTC. The screen said sent. The row went
-- held -> claimed by the email-release sweep at 21:59 -> 'queued', with no
-- provider id, no sent_at, no error: the transport seam only knew Resend,
-- Resend had no key, and a 'queued' row was never looked at again. Two real
-- rows were stuck that way: that invoice, and a work authorization of
-- 2026-08-25 (also David's).
--
-- WHAT THIS ADDS
--   1. Columns on email_messages for the transport's bookkeeping:
--        provider          'outlook' | 'resend' — who carried it.
--        sent_from         the address it went out from (the sender's own
--                          mailbox for Outlook).
--        delivery_reason   why a 'queued' row has not gone (machine-readable,
--                          the CHECK below); NULL on anything that is not
--                          parked. ONLY the transport seam sets it, which is
--                          what makes a row eligible for retry — a vendor
--                          order draft or an automation row is never picked up.
--        delivery_attempts real send attempts (a transport tried and failed).
--        next_attempt_at   when the sweep may look at it again (backoff).
--        last_attempt_at   the last real attempt.
--        claimed_at        the sweep's claim; a claim older than 10 minutes is
--                          a crashed run and lapses.
--   2. A guard: a signed-in user cannot write those columns. The sweep and the
--      seam run as the service role. Without it, a sender could mark their own
--      row "parked" and have it sent with no undo window.
--   3. claim_retryable_queued_emails(_limit, _only_id): the atomic claim.
--        sweep (_only_id NULL): status 'queued', delivery_reason set, sent_at
--          NULL, younger than 14 days, under 6 attempts, due, not claimed —
--          oldest first, SKIP LOCKED, at most 100.
--        one row (_only_id, a person's Resend): 'queued' or 'failed', sent_at
--          NULL, not claimed; age and attempts are the person's call, and the
--          attempt count starts again.
--      Never a row with sent_at, never a vendor order (supply_request_id).
--   4. email_release_kick() also posts when a parked row is due, not only when
--      a held one is. A row waiting on its sender is rescheduled 5 minutes out
--      by the app each time it is looked at, so this is at most one call every
--      few minutes while something waits — and none once nothing does.
--   5. Backfill: the rows that were stuck before this existed are marked
--      'no_transport' so the sweep can see them. The 14-day rule then sends
--      David's invoice once he connects Outlook, and leaves the 25 Aug work
--      authorization for a person to Resend or Cancel.
--
-- The 14 days / 6 attempts / 10 minutes literals are the constants in
-- src/lib/email-transport.ts; email-transport.test.ts pins them together.
--
-- WITHOUT IT the app still sends (Outlook, then Resend), writes only the
-- columns that exist, shows unsent rows without a stored reason, and the hook
-- skips the retry step ("migrated": false).
--
-- Re-runnable.

-- ---------------------------------------------------------------------------
-- 1. Columns.
-- ---------------------------------------------------------------------------
ALTER TABLE public.email_messages
  ADD COLUMN IF NOT EXISTS provider text,
  ADD COLUMN IF NOT EXISTS sent_from text,
  ADD COLUMN IF NOT EXISTS delivery_reason text,
  ADD COLUMN IF NOT EXISTS delivery_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'email_messages_provider_check'
  ) THEN
    ALTER TABLE public.email_messages
      ADD CONSTRAINT email_messages_provider_check
      CHECK (provider IS NULL OR provider IN ('outlook', 'resend'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'email_messages_delivery_reason_check'
  ) THEN
    ALTER TABLE public.email_messages
      ADD CONSTRAINT email_messages_delivery_reason_check
      CHECK (delivery_reason IS NULL OR delivery_reason IN (
        'no_transport', 'sender_not_connected', 'needs_reconnect',
        'sender_inactive', 'transport_error'
      ));
  END IF;
END
$do$;

-- What the kick's EXISTS and the claim read: only parked rows are indexed.
CREATE INDEX IF NOT EXISTS email_messages_parked_due_idx
  ON public.email_messages (next_attempt_at)
  WHERE status = 'queued' AND sent_at IS NULL AND delivery_reason IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. The guard. Signed-in writers cannot touch the transport's columns.
--    On INSERT they start empty; on UPDATE they keep what they were.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tg_email_transport_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.provider := NULL;
    NEW.sent_from := NULL;
    NEW.delivery_reason := NULL;
    NEW.delivery_attempts := 0;
    NEW.next_attempt_at := NULL;
    NEW.last_attempt_at := NULL;
    NEW.claimed_at := NULL;
    RETURN NEW;
  END IF;
  -- A parked email goes out as it was when its sender pressed Send. The
  -- held-email guard already freezes a released row; this covers one sent
  -- with the undo window off, which has no release_at for that guard to see.
  IF OLD.delivery_reason IS NOT NULL
     AND (NEW.to_emails, NEW.cc_emails, NEW.subject, NEW.body_html, NEW.attachments)
         IS DISTINCT FROM
         (OLD.to_emails, OLD.cc_emails, OLD.subject, OLD.body_html, OLD.attachments) THEN
    RAISE EXCEPTION 'This email is waiting to send and can no longer be changed. Cancel it and send a new one.'
      USING ERRCODE = '22023';
  END IF;
  NEW.provider := OLD.provider;
  NEW.sent_from := OLD.sent_from;
  NEW.delivery_reason := OLD.delivery_reason;
  NEW.delivery_attempts := OLD.delivery_attempts;
  NEW.next_attempt_at := OLD.next_attempt_at;
  NEW.last_attempt_at := OLD.last_attempt_at;
  NEW.claimed_at := OLD.claimed_at;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_email_transport_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS email_messages_transport_guard ON public.email_messages;
CREATE TRIGGER email_messages_transport_guard
  BEFORE INSERT OR UPDATE ON public.email_messages
  FOR EACH ROW EXECUTE FUNCTION public.tg_email_transport_guard();

-- ---------------------------------------------------------------------------
-- 3. The claim.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_retryable_queued_emails(
  _limit integer DEFAULT 25,
  _only_id uuid DEFAULT NULL
)
RETURNS SETOF public.email_messages
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  UPDATE public.email_messages m
     SET claimed_at = now(),
         delivery_attempts = CASE WHEN _only_id IS NULL THEN m.delivery_attempts ELSE 0 END
   WHERE m.id IN (
     SELECT q.id FROM public.email_messages q
      WHERE q.sent_at IS NULL
        AND q.supply_request_id IS NULL
        AND (q.claimed_at IS NULL OR q.claimed_at < now() - interval '10 minutes')
        AND CASE
              WHEN _only_id IS NULL THEN
                q.status = 'queued'
                AND q.delivery_reason IS NOT NULL
                AND q.created_at > now() - interval '14 days'
                AND q.delivery_attempts < 6
                AND (q.next_attempt_at IS NULL OR q.next_attempt_at <= now())
              ELSE
                q.id = _only_id AND q.status IN ('queued', 'failed')
            END
      ORDER BY q.created_at
      LIMIT GREATEST(1, LEAST(_limit, 100))
      FOR UPDATE SKIP LOCKED
   )
  RETURNING m.*;
$$;
REVOKE ALL ON FUNCTION public.claim_retryable_queued_emails(integer, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_retryable_queued_emails(integer, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 4. The minute kick: held and due, OR parked and due. Same URL, secret and
--    grants as 20260928122000; only the condition grew.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.email_release_kick()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  hook_url text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.email_messages WHERE status = 'held' AND release_at <= now()
  ) AND NOT EXISTS (
    SELECT 1 FROM public.email_messages q
     WHERE q.status = 'queued'
       AND q.sent_at IS NULL
       AND q.delivery_reason IS NOT NULL
       AND q.supply_request_id IS NULL
       AND q.created_at > now() - interval '14 days'
       AND q.delivery_attempts < 6
       AND (q.next_attempt_at IS NULL OR q.next_attempt_at <= now())
       AND (q.claimed_at IS NULL OR q.claimed_at < now() - interval '10 minutes')
  ) THEN
    RETURN;
  END IF;
  SELECT value->>'release_hook_url' INTO hook_url
    FROM public.app_settings WHERE key = 'email_send';
  hook_url := COALESCE(
    NULLIF(btrim(hook_url), ''),
    'https://project--b0a4cfc7-3fd3-46ba-aa5d-90a925aaa67c.lovable.app/api/public/hooks/email-release'
  );
  PERFORM net.http_post(
    url := hook_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', public.cron_secret()),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
END;
$$;
REVOKE ALL ON FUNCTION public.email_release_kick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.email_release_kick() TO service_role;

-- ---------------------------------------------------------------------------
-- 5. Backfill the rows that were stuck before any of this existed.
--
--    Only rows that provably went through the old seam: released by the
--    sweep (released_at set), or named. A bare 'queued' row can also be an
--    assistant-written record or an automation follow-up that never asked to
--    be sent, and must not start sending because of this file.
--
--    On 2026-10-11 the stuck rows are exactly two, both David's:
--      7144b36a… invoice, 11 Oct (released 21:59) — goes out once he
--                connects Outlook (or Resend is connected);
--      ba41fad0… work authorization, 25 Aug (sent before the undo window
--                existed, so no released_at; named here) — past 14 days, so
--                the sweep never sends it by itself: Mark decides.
-- ---------------------------------------------------------------------------
UPDATE public.email_messages
   SET delivery_reason = 'no_transport'
 WHERE status = 'queued'
   AND sent_at IS NULL
   AND provider_id IS NULL
   AND sent_by IS NOT NULL
   AND supply_request_id IS NULL
   AND delivery_reason IS NULL
   AND (
     released_at IS NOT NULL
     OR id IN (
       '7144b36a-1f57-4d81-b785-3d6d5a69d126'::uuid,
       'ba41fad0-e366-4bcd-b324-0e370aea6d96'::uuid
     )
   );
