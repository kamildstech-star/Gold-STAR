-- ===== enums =====
CREATE TYPE public.email_category AS ENUM ('estimate','invoice','follow_up','seasonal','work_authorization','reminder','notification');
CREATE TYPE public.email_status AS ENUM ('queued','sent','delivered','opened','bounced','failed');
CREATE TYPE public.notification_priority AS ENUM ('low','normal','high','urgent');
CREATE TYPE public.notification_delivery AS ENUM ('immediate','daily_digest','off');
CREATE TYPE public.task_status AS ENUM ('open','in_progress','done','cancelled');
CREATE TYPE public.task_priority AS ENUM ('low','normal','high','urgent');
CREATE TYPE public.notification_type AS ENUM (
  'lead_new','incident_new','incident_unaccepted',
  'estimate_sent','estimate_viewed','estimate_approved','estimate_rejected','estimate_expiring',
  'invoice_sent','invoice_viewed','invoice_partial_payment','invoice_paid',
  'invoice_overdue_30','invoice_overdue_60','invoice_overdue_90','invoice_carrier_shortfall',
  'task_due_today','task_overdue','account_touch_overdue','account_meeting_due','vendor_doc_expiring',
  'job_assigned','job_status_changed','job_complete_equipment_out',
  'chat_message','chat_mention',
  'sync_failed','integration_disconnected'
);

-- ===== email templates =====
CREATE TABLE public.email_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL,
  name text NOT NULL,
  category public.email_category NOT NULL DEFAULT 'notification',
  subject text NOT NULL,
  body text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  location_id uuid REFERENCES public.locations(id) ON DELETE CASCADE,
  from_name text,
  reply_to text,
  signature text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX email_templates_key_location_uniq
  ON public.email_templates (key, COALESCE(location_id, '00000000-0000-0000-0000-000000000000'::uuid));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.email_templates TO authenticated;
GRANT ALL ON public.email_templates TO service_role;
ALTER TABLE public.email_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "templates readable" ON public.email_templates FOR SELECT TO authenticated USING (true);
CREATE POLICY "templates managed by admins" ON public.email_templates FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'owner') OR public.has_role(auth.uid(),'dev'))
  WITH CHECK (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'owner') OR public.has_role(auth.uid(),'dev'));

-- ===== email messages =====
CREATE TABLE public.email_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid REFERENCES public.email_templates(id) ON DELETE SET NULL,
  template_key text,
  category public.email_category NOT NULL DEFAULT 'notification',
  to_emails text[] NOT NULL,
  cc_emails text[] NOT NULL DEFAULT '{}',
  subject text NOT NULL,
  body_html text NOT NULL,
  account_id uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  job_id uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
  invoice_id uuid REFERENCES public.invoices(id) ON DELETE SET NULL,
  location_id uuid REFERENCES public.locations(id) ON DELETE SET NULL,
  attachment_url text,
  sent_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  status public.email_status NOT NULL DEFAULT 'queued',
  provider_id text,
  error text,
  touchpoint_id uuid REFERENCES public.touchpoints(id) ON DELETE SET NULL,
  queued_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  delivered_at timestamptz,
  opened_at timestamptz,
  bounced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_messages_account_idx ON public.email_messages (account_id, created_at DESC);
CREATE INDEX email_messages_job_idx ON public.email_messages (job_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE ON public.email_messages TO authenticated;
GRANT ALL ON public.email_messages TO service_role;
ALTER TABLE public.email_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "email log visible in scope" ON public.email_messages FOR SELECT TO authenticated
  USING (sent_by = auth.uid() OR (location_id IS NOT NULL AND public.can_view_location(auth.uid(), location_id)));
CREATE POLICY "email log insert own" ON public.email_messages FOR INSERT TO authenticated
  WITH CHECK (sent_by = auth.uid());
CREATE POLICY "email log update own" ON public.email_messages FOR UPDATE TO authenticated
  USING (sent_by = auth.uid()) WITH CHECK (sent_by = auth.uid());

-- ===== notifications =====
CREATE TABLE public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type public.notification_type NOT NULL,
  title text NOT NULL,
  body text,
  entity_type text,
  entity_id uuid,
  href text,
  priority public.notification_priority NOT NULL DEFAULT 'normal',
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON public.notifications (user_id, read_at, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.notifications TO authenticated;
GRANT ALL ON public.notifications TO service_role;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own notifications" ON public.notifications FOR ALL TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- ===== notification preferences =====
CREATE TABLE public.notification_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type public.notification_type NOT NULL,
  in_app boolean NOT NULL DEFAULT true,
  email boolean NOT NULL DEFAULT false,
  delivery public.notification_delivery NOT NULL DEFAULT 'immediate',
  quiet_hours_start smallint,
  quiet_hours_end smallint,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, type)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.notification_preferences TO authenticated;
GRANT ALL ON public.notification_preferences TO service_role;
ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own notification prefs" ON public.notification_preferences FOR ALL TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- ===== tasks =====
CREATE TABLE public.tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  description text,
  assignee uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  due_date date,
  due_time time,
  priority public.task_priority NOT NULL DEFAULT 'normal',
  status public.task_status NOT NULL DEFAULT 'open',
  entity_type text,
  entity_id uuid,
  account_id uuid REFERENCES public.accounts(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  job_id uuid REFERENCES public.jobs(id) ON DELETE CASCADE,
  location_id uuid REFERENCES public.locations(id) ON DELETE SET NULL,
  source text NOT NULL DEFAULT 'manual',
  cadence_key text,
  completed_at timestamptz,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tasks_assignee_idx ON public.tasks (assignee, status, due_date);
CREATE UNIQUE INDEX tasks_cadence_uniq ON public.tasks (cadence_key) WHERE cadence_key IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.tasks TO authenticated;
GRANT ALL ON public.tasks TO service_role;
ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tasks visible in scope" ON public.tasks FOR SELECT TO authenticated
  USING (assignee = auth.uid() OR created_by = auth.uid()
         OR (location_id IS NOT NULL AND public.can_view_location(auth.uid(), location_id)));
CREATE POLICY "tasks insert" ON public.tasks FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid());
CREATE POLICY "tasks update in scope" ON public.tasks FOR UPDATE TO authenticated
  USING (assignee = auth.uid() OR created_by = auth.uid()
         OR (location_id IS NOT NULL AND public.can_manage_location(auth.uid(), location_id)))
  WITH CHECK (true);
CREATE POLICY "tasks delete own" ON public.tasks FOR DELETE TO authenticated
  USING (created_by = auth.uid()
         OR (location_id IS NOT NULL AND public.can_manage_location(auth.uid(), location_id)));

-- ===== reminders =====
CREATE TABLE public.reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid REFERENCES public.tasks(id) ON DELETE CASCADE,
  entity_type text,
  entity_id uuid,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  remind_at timestamptz NOT NULL,
  offset_minutes integer,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reminders_due_idx ON public.reminders (remind_at) WHERE sent_at IS NULL;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.reminders TO authenticated;
GRANT ALL ON public.reminders TO service_role;
ALTER TABLE public.reminders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own reminders" ON public.reminders FOR ALL TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- updated_at triggers
CREATE TRIGGER email_templates_updated_at BEFORE UPDATE ON public.email_templates
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER tasks_updated_at BEFORE UPDATE ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();