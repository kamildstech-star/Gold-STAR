ALTER TABLE public.document_send_packets ALTER COLUMN recipient_email DROP NOT NULL;
ALTER TABLE public.document_send_packets ADD COLUMN IF NOT EXISTS single_use boolean NOT NULL DEFAULT true;
ALTER TABLE public.document_send_packets ADD COLUMN IF NOT EXISTS submission_count integer NOT NULL DEFAULT 0;
ALTER TABLE public.document_send_packets ADD COLUMN IF NOT EXISTS replaced_by_packet_id uuid REFERENCES public.document_send_packets(id) ON DELETE SET NULL;

INSERT INTO public.app_settings (key, value)
VALUES ('form_link_defaults', jsonb_build_object('expires_in_days', 30, 'single_use', true))
ON CONFLICT (key) DO NOTHING;