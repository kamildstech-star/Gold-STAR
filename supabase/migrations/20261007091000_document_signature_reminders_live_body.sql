-- run_document_signature_reminders(): record the body production actually
-- runs, and stop signed-in users from running it.
--
-- WRITTEN, NOT APPLIED. Re-runnable. Applying it changes ONE thing on live --
-- the EXECUTE grant flagged in section 2. The body is the live body, character
-- for character, so the nightly job behaves exactly as it does today.
--
-- ---------------------------------------------------------------------------
-- 1. Why this file exists
-- ---------------------------------------------------------------------------
-- The only version in git is 20260818183217_0a6f0351-…, which hands each
-- reminder to public.notify_user(…). No migration on any branch has ever
-- created notify_user, and it does not exist on live, so that body throws
-- "function public.notify_user(...) does not exist" the first time a packet is
-- due. Someone fixed it in the Lovable SQL editor instead: live now inserts
-- straight into public.notifications. The pg_cron job document-signature-
-- reminders (20 7 * * *, as postgres) has run it successfully every morning
-- since. A fresh replay of the repo, though, still gets the broken body.
--
-- Read from live on 2026-10-07 with pg_get_functiondef; what differs from the
-- file:
--   * INSERT INTO public.notifications (user_id, type, title, body,
--     entity_type, entity_id, href, priority) instead of notify_user(…).
--     Those are the real columns -- type (notification_type, NOT NULL, no
--     default) and href, not kind/link; see 20261006120000 for the time that
--     went wrong -- and 'record_stalled' is in the enum;
--   * type 'record_stalled', which the file never set;
--   * one body sentence instead of body + a separate action line: "<name> has
--     not signed <job N> yet. Send a reminder or call them."
-- Unchanged: SECURITY DEFINER, search_path pinned to public, which packets
-- count as due, the href, priority normal, and the last_reminder_at /
-- reminder_count bump. The body below is pg_get_functiondef's output
-- verbatim (md5 of live prosrc 3c85d002ea83594233737e7447ec421f, which the
-- test holds this file to); only the header is written in this repo's
-- spelling (SET search_path = public is what SET search_path TO 'public'
-- prints as).
--
-- Not changed, noted for whoever owns reminders: there is no cap. A packet is
-- nudged every reminder_days until it expires (30 days by default), where the
-- unscheduled TypeScript twin (src/routes/api/public/hooks/document-
-- signature-reminders.ts) stops at 4. Live behaviour is the source of truth
-- here, so it stays.

CREATE OR REPLACE FUNCTION public.run_document_signature_reminders()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE rec record; n integer := 0;
BEGIN
  FOR rec IN
    SELECT p.*, j.job_number
    FROM public.document_send_packets p
    LEFT JOIN public.jobs j ON j.id = p.job_id
    WHERE p.completed_at IS NULL
      AND p.revoked_at IS NULL
      AND p.sent_at IS NOT NULL
      AND p.expires_at > now()
      AND COALESCE(p.last_reminder_at, p.sent_at) < now() - make_interval(days => p.reminder_days)
  LOOP
    IF rec.created_by IS NOT NULL THEN
      INSERT INTO public.notifications (user_id, type, title, body, entity_type, entity_id, href, priority)
      VALUES (
        rec.created_by,
        'record_stalled'::notification_type,
        'Unsigned documents',
        format('%s has not signed %s yet. Send a reminder or call them.',
               COALESCE(rec.recipient_name, rec.recipient_email),
               COALESCE('job ' || rec.job_number, 'the documents sent')),
        'document',
        rec.id,
        CASE WHEN rec.job_id IS NOT NULL THEN '/jobs/' || rec.job_id ELSE '/documents' END,
        'normal'::notification_priority
      );
    END IF;
    UPDATE public.document_send_packets
      SET last_reminder_at = now(), reminder_count = reminder_count + 1
      WHERE id = rec.id;
    n := n + 1;
  END LOOP;
  RETURN n;
END; $function$;

-- ---------------------------------------------------------------------------
-- 2. FLAGGED FIX: signed-in users can run the nightly sweep
-- ---------------------------------------------------------------------------
-- Live ACL: postgres=X, authenticated=X, service_role=X. The authenticated
-- grant came from 20260818183217 ("GRANT EXECUTE ... TO authenticated") and was
-- never needed: nothing in the app calls this RPC, and the cron job runs as
-- postgres, the owner. With it, any signed-in user -- any office, any role,
-- crew included -- can call a SECURITY DEFINER function that has no access
-- check of its own, and it will:
--   * write a notification to every sender with a due packet, in every office;
--   * stamp last_reminder_at on all of those packets, so the real 07:20 run
--     skips them -- one call from anyone silences a day of reminders; and
--   * return how many packets were overdue for a reminder, company-wide.
-- The fix takes EXECUTE away from authenticated (and from PUBLIC and anon,
-- which already lack it on live -- stated so a replay matches). The owner and
-- service_role keep it; the cron job is unaffected.
--
-- Rollback, if something turns out to call it from a signed-in session:
--   GRANT EXECUTE ON FUNCTION public.run_document_signature_reminders() TO authenticated;
REVOKE EXECUTE ON FUNCTION public.run_document_signature_reminders() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_document_signature_reminders() TO service_role;
