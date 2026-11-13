
-- Send packets: one email to one recipient carrying one or more generated documents.
CREATE TABLE public.document_send_packets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES public.locations(id),
  job_id uuid REFERENCES public.jobs(id) ON DELETE CASCADE,
  account_id uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  token text NOT NULL UNIQUE,
  recipient_email text NOT NULL,
  recipient_name text,
  subject text NOT NULL,
  message text,
  required_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  field_values jsonb NOT NULL DEFAULT '{}'::jsonb,
  reminder_days integer NOT NULL DEFAULT 3,
  last_reminder_at timestamptz,
  reminder_count integer NOT NULL DEFAULT 0,
  sent_at timestamptz,
  first_viewed_at timestamptz,
  completed_at timestamptz,
  revoked_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  created_by uuid,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.document_send_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  packet_id uuid NOT NULL REFERENCES public.document_send_packets(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  requires_signature boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (packet_id, document_id)
);

CREATE INDEX idx_dsp_job ON public.document_send_packets(job_id);
CREATE INDEX idx_dsp_open ON public.document_send_packets(completed_at, revoked_at) WHERE completed_at IS NULL AND revoked_at IS NULL;
CREATE INDEX idx_dsi_packet ON public.document_send_items(packet_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.document_send_packets TO authenticated;
GRANT ALL ON public.document_send_packets TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.document_send_items TO authenticated;
GRANT ALL ON public.document_send_items TO service_role;

ALTER TABLE public.document_send_packets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_send_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY dsp_select ON public.document_send_packets FOR SELECT TO authenticated
  USING (public.can_view_location((SELECT auth.uid()), location_id) OR created_by = (SELECT auth.uid()));
CREATE POLICY dsp_insert ON public.document_send_packets FOR INSERT TO authenticated
  WITH CHECK (public.can_view_location((SELECT auth.uid()), location_id) AND created_by = (SELECT auth.uid()));
CREATE POLICY dsp_update ON public.document_send_packets FOR UPDATE TO authenticated
  USING (public.can_view_location((SELECT auth.uid()), location_id) OR created_by = (SELECT auth.uid()));
CREATE POLICY dsp_delete ON public.document_send_packets FOR DELETE TO authenticated
  USING (public.can_manage_location((SELECT auth.uid()), location_id));

CREATE POLICY dsi_all ON public.document_send_items FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.document_send_packets p WHERE p.id = packet_id
                 AND (public.can_view_location((SELECT auth.uid()), p.location_id) OR p.created_by = (SELECT auth.uid()))))
  WITH CHECK (EXISTS (SELECT 1 FROM public.document_send_packets p WHERE p.id = packet_id
                 AND (public.can_view_location((SELECT auth.uid()), p.location_id) OR p.created_by = (SELECT auth.uid()))));

CREATE TRIGGER trg_dsp_updated BEFORE UPDATE ON public.document_send_packets
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Nightly reminder scan: an unsigned packet past its reminder interval notifies its sender.
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
      PERFORM public.notify_user(
        rec.created_by,
        'Unsigned documents',
        format('%s has not signed %s yet.', COALESCE(rec.recipient_name, rec.recipient_email),
               COALESCE('job ' || rec.job_number, 'the documents sent')),
        'Send a reminder or call them.',
        'document', rec.id,
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

SELECT cron.schedule('document-signature-reminders', '20 7 * * *',
  $cron$SELECT public.run_document_signature_reminders();$cron$);
