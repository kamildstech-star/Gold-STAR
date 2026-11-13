-- Microsoft 365 / Graph mailbox registry + sync state
CREATE TABLE public.graph_mailboxes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid REFERENCES public.integration_connections(id) ON DELETE SET NULL,
  upn text NOT NULL UNIQUE,
  graph_user_id text,
  display_name text,
  kind text NOT NULL DEFAULT 'user' CHECK (kind IN ('user','shared_office')),
  location_id uuid REFERENCES public.locations(id) ON DELETE SET NULL,
  user_id uuid REFERENCES public.profiles(user_id) ON DELETE SET NULL,
  enabled boolean NOT NULL DEFAULT true,
  sync_mail boolean NOT NULL DEFAULT true,
  sync_calendar boolean NOT NULL DEFAULT true,
  messages_subscription_id text,
  messages_subscription_expires_at timestamptz,
  events_subscription_id text,
  events_subscription_expires_at timestamptz,
  messages_delta_link text,
  events_delta_link text,
  last_delta_sync_at timestamptz,
  last_message_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.graph_mailboxes TO authenticated;
GRANT ALL ON public.graph_mailboxes TO service_role;
ALTER TABLE public.graph_mailboxes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "graph mailboxes viewable by staff" ON public.graph_mailboxes
  FOR SELECT TO authenticated
  USING (
    has_role(auth.uid(), 'admin'::app_role)
    OR has_role(auth.uid(), 'owner'::app_role)
    OR has_role(auth.uid(), 'dev'::app_role)
    OR has_role(auth.uid(), 'sales_manager'::app_role)
    OR has_role(auth.uid(), 'location_manager'::app_role)
    OR user_id = auth.uid()
  );

CREATE POLICY "graph mailboxes managed by admins" ON public.graph_mailboxes
  FOR ALL TO authenticated
  USING (
    has_role(auth.uid(), 'admin'::app_role)
    OR has_role(auth.uid(), 'owner'::app_role)
    OR has_role(auth.uid(), 'dev'::app_role)
  )
  WITH CHECK (
    has_role(auth.uid(), 'admin'::app_role)
    OR has_role(auth.uid(), 'owner'::app_role)
    OR has_role(auth.uid(), 'dev'::app_role)
  );

CREATE TRIGGER graph_mailboxes_updated_at BEFORE UPDATE ON public.graph_mailboxes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Threading + auto-reply awareness on captured email
ALTER TABLE public.captured_communications
  ADD COLUMN IF NOT EXISTS conversation_id text,
  ADD COLUMN IF NOT EXISTS internet_message_id text,
  ADD COLUMN IF NOT EXISTS mailbox_id uuid REFERENCES public.graph_mailboxes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_auto_reply boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS web_link text;

CREATE INDEX IF NOT EXISTS captured_comms_conversation_idx
  ON public.captured_communications (conversation_id, occurred_at);

-- Calendar state drives "did the meeting happen", not a rep ticking a box
ALTER TABLE public.calendar_events
  ADD COLUMN IF NOT EXISTS mailbox_id uuid REFERENCES public.graph_mailboxes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS organizer_email text,
  ADD COLUMN IF NOT EXISTS response_status text,
  ADD COLUMN IF NOT EXISTS is_cancelled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_all_day boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS accepted_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS declined_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS meeting_held boolean,
  ADD COLUMN IF NOT EXISTS web_link text,
  ADD COLUMN IF NOT EXISTS series_master_id text,
  ADD COLUMN IF NOT EXISTS last_modified_at timestamptz;

CREATE INDEX IF NOT EXISTS calendar_events_account_idx
  ON public.calendar_events (account_id, starts_at DESC);

-- "4 emails sent, no reply — cadence not met"
CREATE OR REPLACE FUNCTION public.account_email_reply_status(_account_id uuid)
RETURNS TABLE (
  emails_sent integer,
  emails_replied integer,
  outbound_since_reply integer,
  last_outbound_at timestamptz,
  last_reply_at timestamptz,
  cadence_met boolean
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH c AS (
    SELECT direction, occurred_at, is_auto_reply
    FROM public.captured_communications
    WHERE account_id = _account_id
      AND channel = 'email'
      AND occurred_at > now() - interval '180 days'
  ),
  agg AS (
    SELECT
      count(*) FILTER (WHERE direction = 'outbound')::int AS sent,
      count(*) FILTER (WHERE direction = 'inbound' AND NOT is_auto_reply)::int AS replied,
      max(occurred_at) FILTER (WHERE direction = 'outbound') AS last_out,
      max(occurred_at) FILTER (WHERE direction = 'inbound' AND NOT is_auto_reply) AS last_in
    FROM c
  )
  SELECT
    agg.sent,
    agg.replied,
    (SELECT count(*) FROM c
      WHERE direction = 'outbound'
        AND (agg.last_in IS NULL OR occurred_at > agg.last_in))::int,
    agg.last_out,
    agg.last_in,
    (agg.last_in IS NOT NULL AND agg.last_in > now() - interval '90 days')
  FROM agg;
$$;

GRANT EXECUTE ON FUNCTION public.account_email_reply_status(uuid) TO authenticated;