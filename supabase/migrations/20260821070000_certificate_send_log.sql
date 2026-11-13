-- Certificate send log
--
-- Compliance is only half-useful if we can send a certificate but cannot prove
-- we did. The client's ask: "one button emails it to them and records that it
-- went out, and when." This is the record half.
--
-- Sends queue while Microsoft Graph credentials are outstanding, so the row is
-- created at 'queued' and moves to 'sent' or 'failed' once the mailer runs.
--
-- RECONCILIATION NOTE (2026-09-03): this file was never recorded in
-- supabase_migrations.schema_migrations, yet every object in it already exists
-- in production (Lovable applied the schema directly). Every statement is now
-- guarded so the file is a no-op where the objects exist and still builds them
-- where they do not. Nothing about the objects themselves changed.

DO $$ BEGIN
  CREATE TYPE public.certificate_send_status AS ENUM ('queued', 'sent', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.certificate_sends (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  -- Which of our credentials was sent, and the file that actually went out.
  -- Both nullable so a lapsed/removed credential never erases the send history.
  credential_id  uuid REFERENCES public.company_credentials(id) ON DELETE SET NULL,
  document_id    uuid REFERENCES public.documents(id) ON DELETE SET NULL,
  -- The requirement this satisfied, when the send was made against one.
  requirement_id uuid REFERENCES public.account_compliance_requirements(id) ON DELETE SET NULL,

  sent_to        text NOT NULL,
  cc_emails      text[] NOT NULL DEFAULT '{}',
  subject        text,
  status         public.certificate_send_status NOT NULL DEFAULT 'queued',
  error_message  text,

  -- Snapshot of the certificate's expiry at send time. The credential may be
  -- renewed later; what we told them expires on is a fact about this send.
  expiry_at_send date,

  sent_by        uuid REFERENCES public.profiles(user_id) ON DELETE SET NULL,
  queued_at      timestamptz NOT NULL DEFAULT now(),
  sent_at        timestamptz,
  note           text,
  is_demo        boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS certificate_sends_account_idx ON public.certificate_sends (account_id, queued_at DESC);
CREATE INDEX IF NOT EXISTS certificate_sends_status_idx  ON public.certificate_sends (status) WHERE status = 'queued';

DROP TRIGGER IF EXISTS certificate_sends_updated_at ON public.certificate_sends;
CREATE TRIGGER certificate_sends_updated_at
  BEFORE UPDATE ON public.certificate_sends
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.certificate_sends ENABLE ROW LEVEL SECURITY;

-- Mirrors account_compliance_requirements: visible to anyone who can see the
-- account, writable by the rep who owns it or a manager of its location.
DROP POLICY IF EXISTS certificate_sends_select ON public.certificate_sends;
CREATE POLICY certificate_sends_select ON public.certificate_sends
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.accounts a
    WHERE a.id = certificate_sends.account_id
      AND (a.created_by = (SELECT auth.uid())
        OR a.assigned_rep = (SELECT auth.uid())
        OR public.can_view_location((SELECT auth.uid()), a.location_id))
  ));

DROP POLICY IF EXISTS certificate_sends_insert ON public.certificate_sends;
CREATE POLICY certificate_sends_insert ON public.certificate_sends
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.accounts a
    WHERE a.id = certificate_sends.account_id
      AND (a.assigned_rep = (SELECT auth.uid())
        OR public.can_manage_location((SELECT auth.uid()), a.location_id))
  ));

-- Update exists for the mailer to move queued → sent/failed, and for notes.
DROP POLICY IF EXISTS certificate_sends_update ON public.certificate_sends;
CREATE POLICY certificate_sends_update ON public.certificate_sends
  FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.accounts a
    WHERE a.id = certificate_sends.account_id
      AND (a.assigned_rep = (SELECT auth.uid())
        OR public.can_manage_location((SELECT auth.uid()), a.location_id))
  ));

-- A send is a record of something that happened; only privileged users may
-- remove one, and normal correction is a note rather than a delete.
DROP POLICY IF EXISTS certificate_sends_delete ON public.certificate_sends;
CREATE POLICY certificate_sends_delete ON public.certificate_sends
  FOR DELETE TO authenticated
  USING (public.is_privileged((SELECT auth.uid())));

COMMENT ON TABLE public.certificate_sends IS
  'Audit of certificates of insurance sent to client companies: what went out, to whom, by whom, when, and whether delivery succeeded.';

-- Convenience view: latest send per account, for the compliance panel header
-- and the "last sent" column on the account list.
CREATE OR REPLACE VIEW public.account_certificate_last_send
WITH (security_invoker = true) AS
SELECT DISTINCT ON (s.account_id)
  s.account_id,
  s.id AS send_id,
  s.sent_to,
  s.status,
  s.queued_at,
  s.sent_at,
  s.expiry_at_send,
  s.sent_by
FROM public.certificate_sends s
ORDER BY s.account_id, s.queued_at DESC;

GRANT SELECT ON public.account_certificate_last_send TO authenticated;
