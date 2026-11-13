-- The undo window on outbound email, built into the existing queue.
--
-- David, 24 Sep: every email a person sends from the system waits a few
-- minutes first — "Sending in 4:32 — Edit · Cancel" — so the wrong recipient,
-- the wrong file or a typo can be caught before it leaves.
--
-- Requires 20260928121000_email_status_held_cancelled.sql (the 'held' and
-- 'cancelled' values). Run that first.
--
-- HOW IT WORKS
--   * sendEmail writes the row as status 'held' with release_at = now() + the
--     admin delay (app_settings 'email_send'.delay_minutes, default 5).
--   * While held, the sender (RLS: "email log update own") may change the
--     recipients, subject, body and attachments, or set it 'cancelled'.
--   * Each minute, pg_cron runs email_release_kick(). When something is due it
--     calls the app's /api/public/hooks/email-release, which claims the due
--     rows (claim_due_held_emails — held → queued, atomically, so a row is
--     handed over exactly once) and passes each to the transport seam. With a
--     mail provider connected it goes out and becomes 'sent'; without one it
--     stays 'queued', exactly as every send does today. That is why this works
--     from the first day transport is switched on with no change here.
--   * Once claimed, the row is no longer the sender's to edit: the guard below
--     refuses, so an edit that loses the race is told, not silently dropped.
--
-- Automation emails (job follow-ups to staff) are written 'queued' by the
-- service role with no release_at and are NOT held: nobody pressed Send, so
-- there is no one to catch a mistake in the window; holding them would only
-- delay a nudge to our own people.

-- ---------------------------------------------------------------------------
-- 1. The held state's columns.
-- ---------------------------------------------------------------------------
ALTER TABLE public.email_messages
  ADD COLUMN IF NOT EXISTS release_at timestamptz,
  ADD COLUMN IF NOT EXISTS released_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  -- Files as download links, appended when the email is released rather than
  -- baked into the body at Send — removing a wrong file must really remove it.
  ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- What the send needs at release that used to live only in the request.
  ADD COLUMN IF NOT EXISTS reply_to text,
  ADD COLUMN IF NOT EXISTS from_name text,
  ADD COLUMN IF NOT EXISTS log_touchpoint boolean NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS email_messages_held_release_idx
  ON public.email_messages (release_at)
  WHERE status = 'held';

-- ---------------------------------------------------------------------------
-- 2. The guard: the undo window is the only time a sent email can change.
--
-- Applies to signed-in users only. The release sweep and the provider webhook
-- run as the service role (auth.uid() is null) and move status on as before.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tg_email_hold_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'held' AND NEW.release_at IS NULL THEN
      RAISE EXCEPTION 'A held email needs a release time.' USING ERRCODE = '22023';
    END IF;
    IF NEW.status = 'cancelled' THEN
      RAISE EXCEPTION 'An email cannot be created cancelled.' USING ERRCODE = '22023';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF OLD.status = 'held' THEN
    IF NEW.status NOT IN ('held', 'cancelled') THEN
      RAISE EXCEPTION 'A held email is released by the send sweep, not by hand.'
        USING ERRCODE = '22023';
    END IF;
    -- The window is the admin's, not the sender's to stretch or skip.
    NEW.release_at := OLD.release_at;
    IF NEW.status = 'cancelled' THEN
      NEW.cancelled_at := now();
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'This email was cancelled. Start a new one instead.' USING ERRCODE = '22023';
  END IF;

  -- Released (it was held once) — what went out is what the record says.
  IF OLD.release_at IS NOT NULL
     AND (NEW.to_emails, NEW.cc_emails, NEW.subject, NEW.body_html, NEW.attachments, NEW.status)
         IS DISTINCT FROM
         (OLD.to_emails, OLD.cc_emails, OLD.subject, OLD.body_html, OLD.attachments, OLD.status) THEN
    RAISE EXCEPTION 'This email has already been sent and can no longer be changed.'
      USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_email_hold_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS email_messages_hold_guard ON public.email_messages;
CREATE TRIGGER email_messages_hold_guard
  BEFORE INSERT OR UPDATE ON public.email_messages
  FOR EACH ROW EXECUTE FUNCTION public.tg_email_hold_guard();

-- ---------------------------------------------------------------------------
-- 3. Claim what is due. held → queued in one statement with SKIP LOCKED, so
--    two overlapping sweeps can never hand the same email over twice, and a
--    sender's Cancel either lands before the claim or is refused after it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_due_held_emails(_limit integer DEFAULT 50)
RETURNS SETOF public.email_messages
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  UPDATE public.email_messages m
     SET status = 'queued', released_at = now()
   WHERE m.id IN (
     SELECT h.id FROM public.email_messages h
      WHERE h.status = 'held' AND h.release_at <= now()
      ORDER BY h.release_at
      LIMIT GREATEST(1, LEAST(_limit, 200))
      FOR UPDATE SKIP LOCKED
   )
  RETURNING m.*;
$$;
REVOKE ALL ON FUNCTION public.claim_due_held_emails(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_due_held_emails(integer) TO service_role;

-- ---------------------------------------------------------------------------
-- 4. The admin setting. Stored value wins on re-run.
-- ---------------------------------------------------------------------------
INSERT INTO public.app_settings (key, value)
VALUES ('email_send', '{"delay_minutes": 5}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 5. The minute sweep. Posts to the app only when something is actually due,
--    so an idle minute costs one indexed EXISTS, not an HTTP call.
--    The hook URL can be overridden with app_settings 'email_send'.release_hook_url;
--    the default is the same app origin run-automations-15min calls.
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
    body := '{}'::jsonb
  );
END;
$$;
REVOKE ALL ON FUNCTION public.email_release_kick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.email_release_kick() TO service_role;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron is not installed; email-release remains unscheduled.';
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'email-release') THEN
    PERFORM cron.unschedule('email-release');
  END IF;
  PERFORM cron.schedule(
    'email-release',
    '* * * * *',
    $cron$SELECT public.email_release_kick();$cron$
  );
END
$do$;
