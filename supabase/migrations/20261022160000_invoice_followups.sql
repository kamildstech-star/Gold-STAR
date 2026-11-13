-- Automated invoice follow-ups (client item 18, 21 Oct — David).
--
-- Unpaid, SENT invoices get a reminder email N days after they were sent, in
-- steps (7 days, then 14), each step from its own template. Evaluated by the
-- existing every-15-minutes automations sweep (run-automations), so it fires
-- with the app closed; the emails go into the existing outbound queue as
-- 'held' rows with the admin's send delay, so they show on the job's
-- Communications tab and timeline, can be cancelled in the window, and leave
-- through the same transport seam as everything else.
--
--   invoice_followup_rules  — the steps, company-wide or per office.
--   invoices.followup_mode  — per invoice: 'auto' (the rules), 'off', or
--                             'rule' (followup_rule_id).
--   accounts.no_auto_followups — per client: never, whatever the rule or the
--                             invoice says. Checked again at send time.
--   invoice_followups       — one row per (invoice, rule, step): the "fires
--                             once" lock AND the audit of who/what scheduled
--                             it, what was sent or why it was cancelled.
--
-- A payment that settles an invoice (or writing it off) cancels any follow-up
-- still waiting, here in the database, in the same transaction.
--
-- Re-runnable.

-- ---------------------------------------------------------------------------
-- 1. Rules
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.invoice_followup_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  -- NULL: company-wide. An office's own rule wins for that office's invoices.
  location_id uuid REFERENCES public.locations(id) ON DELETE CASCADE,
  is_active   boolean NOT NULL DEFAULT true,
  -- [{ "days": 7, "template_key": "invoice_followup_1" }, …], ascending days.
  steps       jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(steps) = 'array'),
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.invoice_followup_rules ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.invoice_followup_rules FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.invoice_followup_rules TO authenticated;

DROP POLICY IF EXISTS invoice_followup_rules_read ON public.invoice_followup_rules;
CREATE POLICY invoice_followup_rules_read ON public.invoice_followup_rules
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS invoice_followup_rules_write ON public.invoice_followup_rules;
CREATE POLICY invoice_followup_rules_write ON public.invoice_followup_rules
  FOR ALL TO authenticated
  USING (public.is_privileged((SELECT auth.uid())))
  WITH CHECK (public.is_privileged((SELECT auth.uid())));

-- The default: 7 days → first reminder, 14 days → second. Seeded once.
INSERT INTO public.invoice_followup_rules (name, location_id, is_active, steps)
SELECT 'Unpaid invoice reminders', NULL, true,
       '[{"days": 7, "template_key": "invoice_followup_1"},
         {"days": 14, "template_key": "invoice_followup_2"}]'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM public.invoice_followup_rules WHERE location_id IS NULL);

-- ---------------------------------------------------------------------------
-- 2. Per invoice, per client
-- ---------------------------------------------------------------------------
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS followup_mode text NOT NULL DEFAULT 'auto',
  ADD COLUMN IF NOT EXISTS followup_rule_id uuid
    REFERENCES public.invoice_followup_rules(id) ON DELETE SET NULL;
DO $$ BEGIN
  ALTER TABLE public.invoices
    ADD CONSTRAINT invoices_followup_mode_check CHECK (followup_mode IN ('auto', 'off', 'rule'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS no_auto_followups boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.accounts.no_auto_followups IS
  'Corporate-client policy: never send this client automated invoice follow-ups. Wins over every rule and invoice setting, and is re-checked at send time.';

-- ---------------------------------------------------------------------------
-- 3. What fired — the once-only lock and the audit trail
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.invoice_followups (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id       uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  rule_id          uuid REFERENCES public.invoice_followup_rules(id) ON DELETE SET NULL,
  -- The rule's id at the time, kept even if the rule is deleted, for the lock.
  rule_key         uuid NOT NULL,
  step_index       integer NOT NULL,
  days             integer NOT NULL,
  template_key     text NOT NULL,
  -- emailed: queued (held) to the client; notified: no client email, the
  -- office got a task instead; skipped: a later step was due at the same
  -- time and went instead; cancelled: paid / written off / exempted / off.
  outcome          text NOT NULL CHECK (outcome IN ('emailed', 'notified', 'skipped', 'cancelled')),
  email_message_id uuid REFERENCES public.email_messages(id) ON DELETE SET NULL,
  task_id          uuid REFERENCES public.tasks(id) ON DELETE SET NULL,
  to_emails        text[] NOT NULL DEFAULT '{}',
  -- Who or what scheduled it: 'sweep' for the automation, else a user id.
  scheduled_by     text NOT NULL DEFAULT 'sweep',
  reason           text,
  cancelled_at     timestamptz,
  cancel_reason    text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (invoice_id, rule_key, step_index)
);
CREATE INDEX IF NOT EXISTS invoice_followups_invoice_idx ON public.invoice_followups (invoice_id);

ALTER TABLE public.invoice_followups ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.invoice_followups FROM PUBLIC, anon;
GRANT SELECT ON public.invoice_followups TO authenticated;
-- Readable by whoever can read the invoice (invoices' own RLS decides).
DROP POLICY IF EXISTS invoice_followups_read ON public.invoice_followups;
CREATE POLICY invoice_followups_read ON public.invoice_followups
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.invoices i WHERE i.id = invoice_followups.invoice_id));
-- Written only by the sweep and the send-time check (service role).

-- ---------------------------------------------------------------------------
-- 4. Paid or written off → anything still waiting is cancelled
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cancel_invoice_followups(_invoice_id uuid, _reason text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n integer;
BEGIN
  -- Held (in the undo window) or queued (waiting on transport): not sent yet.
  UPDATE public.email_messages
     SET status = 'cancelled', error = _reason
   WHERE invoice_id = _invoice_id
     AND template_key LIKE 'invoice_followup%'
     AND status IN ('held', 'queued');
  GET DIAGNOSTICS n = ROW_COUNT;
  UPDATE public.invoice_followups f
     SET outcome = 'cancelled', cancelled_at = now(), cancel_reason = _reason
   WHERE f.invoice_id = _invoice_id
     AND f.outcome = 'emailed'
     AND f.cancelled_at IS NULL
     AND EXISTS (
       SELECT 1 FROM public.email_messages m
        WHERE m.id = f.email_message_id AND m.status = 'cancelled'
     );
  RETURN n;
END;
$$;
REVOKE ALL ON FUNCTION public.cancel_invoice_followups(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_invoice_followups(uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.tg_invoice_followups_settle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status IN ('paid', 'written_off', 'draft')
     AND NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM public.cancel_invoice_followups(
      NEW.id,
      CASE NEW.status
        WHEN 'paid' THEN 'Invoice paid'
        WHEN 'written_off' THEN 'Invoice written off'
        ELSE 'Invoice returned to draft'
      END
    );
  ELSIF NEW.followup_mode = 'off' AND OLD.followup_mode IS DISTINCT FROM 'off' THEN
    PERFORM public.cancel_invoice_followups(NEW.id, 'Follow-ups switched off for this invoice');
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_invoice_followups_settle() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS invoice_followups_settle ON public.invoices;
CREATE TRIGGER invoice_followups_settle
  AFTER UPDATE OF status, followup_mode ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.tg_invoice_followups_settle();

-- ---------------------------------------------------------------------------
-- 5. The two follow-up templates, in Admin → Email templates
-- ---------------------------------------------------------------------------
-- The same strings as EMAIL_TEMPLATE_DEFAULTS in src/lib/email-templates.ts.
-- Inserted only where the company-wide row is missing: an office that edits
-- its own wording keeps it, and a second run adds nothing.
INSERT INTO public.email_templates (key, name, category, subject, body, is_active)
SELECT v.key, v.name, v.category::public.email_category, v.subject, v.body, v.is_active
FROM (VALUES
  (
    'invoice_followup_1',
    'Invoice follow-up — first reminder',
    'reminder',
    'Reminder: invoice {{invoice_number}} — {{balance_remaining}} outstanding',
    concat_ws(E'\n',
      '<p>Hello {{customer_name}},</p>',
      '<p>This is a friendly reminder that invoice {{invoice_number}} for the work at {{job_address}}, sent {{days_since_sent}} days ago, still shows a balance of <b>{{balance_remaining}}</b>.</p>',
      '<p>If you have already sent payment, thank you — please disregard this note. Otherwise you can pay here: {{payment_link}}</p>',
      '<p>Questions about the invoice? Reply to this email or call us at {{company_phone}}.</p>',
      '<p>{{company_name}}</p>'
    ),
    true
  ),
  (
    'invoice_followup_2',
    'Invoice follow-up — second reminder',
    'reminder',
    'Second reminder: invoice {{invoice_number}} is {{days_since_sent}} days unpaid',
    concat_ws(E'\n',
      '<p>Hello {{customer_name}},</p>',
      '<p>We have not yet received payment for invoice {{invoice_number}} ({{job_address}}), sent {{days_since_sent}} days ago. The balance due is <b>{{balance_remaining}}</b>.</p>',
      '<p>Please arrange payment at your earliest convenience: {{payment_link}}</p>',
      '<p>If there is a question holding this up, reply to this email or call {{company_phone}} and we will sort it out.</p>',
      '<p>{{company_name}}</p>'
    ),
    true
  )
) AS v(key, name, category, subject, body, is_active)
WHERE NOT EXISTS (
  SELECT 1 FROM public.email_templates t WHERE t.key = v.key AND t.location_id IS NULL
);
