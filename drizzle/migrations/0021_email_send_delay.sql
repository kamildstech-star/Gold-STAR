-- lovable-cron-fallback-reviewed: user-approved migration file applied verbatim; undo window release needs per-minute precision and the kick exits early via an indexed EXISTS when nothing is due.
ALTER TABLE public.email_messages
  ADD COLUMN IF NOT EXISTS release_at timestamptz,
  ADD COLUMN IF NOT EXISTS released_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS reply_to text,
  ADD COLUMN IF NOT EXISTS from_name text,
  ADD COLUMN IF NOT EXISTS log_touchpoint boolean NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS email_messages_held_release_idx
  ON public.email_messages (release_at)
  WHERE status = 'held';

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

  IF OLD.status = 'held' THEN
    IF NEW.status NOT IN ('held', 'cancelled') THEN
      RAISE EXCEPTION 'A held email is released by the send sweep, not by hand.'
        USING ERRCODE = '22023';
    END IF;
    NEW.release_at := OLD.release_at;
    IF NEW.status = 'cancelled' THEN
      NEW.cancelled_at := now();
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'This email was cancelled. Start a new one instead.' USING ERRCODE = '22023';
  END IF;

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

INSERT INTO public.app_settings (key, value)
VALUES ('email_send', '{"delay_minutes": 5}'::jsonb)
ON CONFLICT (key) DO NOTHING;

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