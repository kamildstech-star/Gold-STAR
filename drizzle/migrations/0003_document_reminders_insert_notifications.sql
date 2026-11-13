-- The nightly unsigned-document scan called public.notify_user(), which does
-- not exist on this database, so every run aborted before updating any packet.
-- Insert the notification row directly instead; same recipient, same copy.
CREATE OR REPLACE FUNCTION public.run_document_signature_reminders()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
END; $$;

GRANT EXECUTE ON FUNCTION public.run_document_signature_reminders() TO authenticated;
REVOKE EXECUTE ON FUNCTION public.run_document_signature_reminders() FROM anon, PUBLIC;
