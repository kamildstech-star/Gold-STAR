-- ===== enums =====
CREATE TYPE public.escalation_record_type AS ENUM ('estimate','invoice','job','account','lead');
CREATE TYPE public.escalation_target_kind AS ENUM ('named_user','record_owner','assignee','location_manager','collector');
CREATE TYPE public.escalation_event_state AS ENUM ('open','resolved','dismissed');
CREATE TYPE public.job_report_type AS ENUM ('carrier_submission','customer_update','internal_review');
CREATE TYPE public.job_report_status AS ENUM ('draft','approved','superseded');

ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'record_stalled';
ALTER TYPE public.document_type ADD VALUE IF NOT EXISTS 'job_report';

-- ===== escalation_rules =====
CREATE TABLE public.escalation_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  name text NOT NULL,
  record_type public.escalation_record_type NOT NULL,
  statuses text[] NOT NULL DEFAULT '{}',
  stale_days integer NOT NULL CHECK (stale_days > 0),
  target_kind public.escalation_target_kind NOT NULL DEFAULT 'record_owner',
  target_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  step2_days integer CHECK (step2_days IS NULL OR step2_days > 0),
  step2_target_kind public.escalation_target_kind,
  step2_target_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  step3_days integer CHECK (step3_days IS NULL OR step3_days > 0),
  step3_target_kind public.escalation_target_kind,
  step3_target_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_escalation_rules_loc ON public.escalation_rules(location_id, record_type) WHERE active;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.escalation_rules TO authenticated;
GRANT ALL ON public.escalation_rules TO service_role;
ALTER TABLE public.escalation_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "view rules in scope" ON public.escalation_rules
  FOR SELECT TO authenticated USING (public.can_view_location(auth.uid(), location_id));
CREATE POLICY "manage rules in scope" ON public.escalation_rules
  FOR ALL TO authenticated
  USING (public.can_manage_location(auth.uid(), location_id))
  WITH CHECK (public.can_manage_location(auth.uid(), location_id));

CREATE TRIGGER trg_escalation_rules_updated BEFORE UPDATE ON public.escalation_rules
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ===== escalation_events =====
CREATE TABLE public.escalation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id uuid NOT NULL REFERENCES public.escalation_rules(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  record_type public.escalation_record_type NOT NULL,
  record_id uuid NOT NULL,
  record_label text,
  record_status text,
  step smallint NOT NULL DEFAULT 1 CHECK (step BETWEEN 1 AND 3),
  target_kind public.escalation_target_kind NOT NULL,
  notified_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  owner_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  last_movement_at timestamptz,
  days_stale integer NOT NULL DEFAULT 0,
  state public.escalation_event_state NOT NULL DEFAULT 'open',
  resolved_at timestamptz,
  resolved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  resolution_note text,
  notified_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rule_id, record_id, step)
);
CREATE INDEX idx_escalation_events_open ON public.escalation_events(location_id, record_type) WHERE state = 'open';
CREATE INDEX idx_escalation_events_record ON public.escalation_events(record_type, record_id);

GRANT SELECT, INSERT, UPDATE ON public.escalation_events TO authenticated;
GRANT ALL ON public.escalation_events TO service_role;
ALTER TABLE public.escalation_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "view escalations in scope" ON public.escalation_events
  FOR SELECT TO authenticated USING (public.can_view_location(auth.uid(), location_id));
CREATE POLICY "resolve escalations in scope" ON public.escalation_events
  FOR UPDATE TO authenticated
  USING (public.can_view_location(auth.uid(), location_id))
  WITH CHECK (public.can_view_location(auth.uid(), location_id));

CREATE TRIGGER trg_escalation_events_updated BEFORE UPDATE ON public.escalation_events
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ===== last movement =====
-- "Movement" is a real event against the record: a status change, a payment,
-- a logged touchpoint, or an email sent. A due date passing is NOT movement.
CREATE OR REPLACE FUNCTION public.record_last_movement(
  _type public.escalation_record_type,
  _id uuid
) RETURNS timestamptz
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE ts timestamptz;
BEGIN
  IF _type = 'invoice' THEN
    SELECT GREATEST(
      COALESCE(i.updated_at, i.created_at),
      COALESCE((SELECT max(p.created_at) FROM invoice_payments p WHERE p.invoice_id = i.id), 'epoch'::timestamptz),
      COALESCE((SELECT max(e.sent_at) FROM email_messages e WHERE e.invoice_id = i.id), 'epoch'::timestamptz),
      COALESCE(i.sent_at, 'epoch'::timestamptz)
    ) INTO ts FROM invoices i WHERE i.id = _id;
  ELSIF _type = 'estimate' THEN
    SELECT GREATEST(
      COALESCE(q.updated_at, q.created_at),
      COALESCE(q.submitted_at, 'epoch'::timestamptz),
      COALESCE((SELECT max(e.sent_at) FROM email_messages e WHERE e.job_id = q.job_id), 'epoch'::timestamptz)
    ) INTO ts FROM quotes q WHERE q.id = _id;
  ELSIF _type = 'job' THEN
    SELECT GREATEST(
      COALESCE(j.updated_at, j.created_at),
      COALESCE((SELECT max(h.changed_at) FROM job_status_history h WHERE h.job_id = j.id), 'epoch'::timestamptz),
      COALESCE((SELECT max(n.created_at) FROM job_notes n WHERE n.job_id = j.id), 'epoch'::timestamptz),
      COALESCE((SELECT max(e.sent_at) FROM email_messages e WHERE e.job_id = j.id), 'epoch'::timestamptz),
      COALESCE((SELECT max(t.created_at) FROM time_entries t WHERE t.job_id = j.id), 'epoch'::timestamptz)
    ) INTO ts FROM jobs j WHERE j.id = _id;
  ELSIF _type = 'account' THEN
    SELECT GREATEST(
      COALESCE(a.updated_at, a.created_at),
      COALESCE(a.stage_changed_at, 'epoch'::timestamptz),
      COALESCE((SELECT max(t.occurred_at) FROM touchpoints t WHERE t.account_id = a.id), 'epoch'::timestamptz),
      COALESCE((SELECT max(e.sent_at) FROM email_messages e WHERE e.account_id = a.id), 'epoch'::timestamptz)
    ) INTO ts FROM accounts a WHERE a.id = _id;
  ELSIF _type = 'lead' THEN
    SELECT GREATEST(
      COALESCE(l.updated_at, l.created_at),
      COALESCE(l.stage_changed_at, 'epoch'::timestamptz),
      COALESCE((SELECT max(c.created_at) FROM contact_attempts c WHERE c.lead_id = l.id), 'epoch'::timestamptz),
      COALESCE((SELECT max(n.created_at) FROM lead_notes n WHERE n.lead_id = l.id), 'epoch'::timestamptz)
    ) INTO ts FROM fire_leads l WHERE l.id = _id;
  END IF;
  RETURN ts;
END; $$;

-- Resolve a rule step's chosen target to a real user. Never inferred beyond
-- the explicit choice the rule stores.
CREATE OR REPLACE FUNCTION public.resolve_escalation_target(
  _kind public.escalation_target_kind,
  _named uuid,
  _location_id uuid,
  _owner uuid,
  _record_type public.escalation_record_type,
  _record_id uuid
) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE uid uuid; _job uuid;
BEGIN
  IF _kind = 'named_user' THEN RETURN _named; END IF;
  IF _kind = 'record_owner' THEN RETURN _owner; END IF;
  IF _kind = 'location_manager' THEN
    SELECT lm.user_id INTO uid FROM location_members lm
      WHERE lm.location_id = _location_id AND lm.role = 'manager' LIMIT 1;
    RETURN uid;
  END IF;
  -- assignee / collector resolve against the job behind the record
  IF _record_type = 'job' THEN _job := _record_id;
  ELSIF _record_type = 'invoice' THEN SELECT job_id INTO _job FROM invoices WHERE id = _record_id;
  ELSIF _record_type = 'estimate' THEN SELECT job_id INTO _job FROM quotes WHERE id = _record_id;
  END IF;
  IF _job IS NULL THEN RETURN _owner; END IF;
  IF _kind = 'collector' THEN
    SELECT a.user_id INTO uid FROM job_assignments a
      WHERE a.job_id = _job AND a.role = 'collector' LIMIT 1;
  ELSE
    SELECT a.user_id INTO uid FROM job_assignments a
      WHERE a.job_id = _job ORDER BY (a.role = 'project_manager') DESC, a.created_at LIMIT 1;
  END IF;
  RETURN COALESCE(uid, _owner);
END; $$;

-- ===== the sweep =====
CREATE OR REPLACE FUNCTION public.run_escalation_scan()
RETURNS TABLE(raised integer, resolved integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r record; rec record; step_no smallint; days_needed integer;
  kind public.escalation_target_kind; named uuid; target uuid;
  moved timestamptz; stale integer; n_raised integer := 0; n_resolved integer := 0;
BEGIN
  -- Close anything that has since moved.
  FOR rec IN SELECT * FROM escalation_events WHERE state = 'open' LOOP
    moved := record_last_movement(rec.record_type, rec.record_id);
    IF moved IS NULL OR moved > rec.notified_at THEN
      UPDATE escalation_events
        SET state = 'resolved', resolved_at = now(),
            resolution_note = COALESCE(resolution_note, 'Record moved after escalation')
        WHERE id = rec.id;
      n_resolved := n_resolved + 1;
    ELSE
      UPDATE escalation_events
        SET days_stale = GREATEST(0, (EXTRACT(EPOCH FROM (now() - moved)) / 86400)::int)
        WHERE id = rec.id;
    END IF;
  END LOOP;

  FOR r IN SELECT * FROM escalation_rules WHERE active LOOP
    FOR rec IN
      SELECT * FROM (
        SELECT i.id, i.location_id, i.status::text AS status,
               COALESCE(i.invoice_number, 'Invoice') AS label, i.created_by AS owner
          FROM invoices i WHERE r.record_type = 'invoice'
        UNION ALL
        SELECT q.id, q.location_id, q.status::text,
               COALESCE(q.title, 'Estimate'), q.created_by
          FROM quotes q WHERE r.record_type = 'estimate'
        UNION ALL
        SELECT j.id, j.location_id, j.status::text,
               COALESCE(j.job_number, j.address, 'Job'), COALESCE(j.crew_chief, j.created_by)
          FROM jobs j WHERE r.record_type = 'job'
        UNION ALL
        SELECT a.id, a.location_id, a.stage::text, a.name, COALESCE(a.assigned_rep, a.created_by)
          FROM accounts a WHERE r.record_type = 'account'
        UNION ALL
        SELECT l.id, l.location_id, l.pipeline_stage::text,
               COALESCE(l.address, 'Lead'), l.assigned_rep
          FROM fire_leads l WHERE r.record_type = 'lead'
      ) s
      WHERE s.location_id = r.location_id
        AND (cardinality(r.statuses) = 0 OR s.status = ANY (r.statuses))
    LOOP
      moved := record_last_movement(r.record_type, rec.id);
      IF moved IS NULL THEN CONTINUE; END IF;
      stale := GREATEST(0, (EXTRACT(EPOCH FROM (now() - moved)) / 86400)::int);

      -- highest step whose threshold the silence has passed
      step_no := NULL;
      IF r.step3_days IS NOT NULL AND stale >= r.step3_days THEN
        step_no := 3; days_needed := r.step3_days;
        kind := COALESCE(r.step3_target_kind, 'location_manager'); named := r.step3_target_user_id;
      ELSIF r.step2_days IS NOT NULL AND stale >= r.step2_days THEN
        step_no := 2; days_needed := r.step2_days;
        kind := COALESCE(r.step2_target_kind, 'location_manager'); named := r.step2_target_user_id;
      ELSIF stale >= r.stale_days THEN
        step_no := 1; days_needed := r.stale_days;
        kind := r.target_kind; named := r.target_user_id;
      END IF;
      IF step_no IS NULL THEN CONTINUE; END IF;

      IF EXISTS (SELECT 1 FROM escalation_events e
                  WHERE e.rule_id = r.id AND e.record_id = rec.id AND e.step = step_no) THEN
        CONTINUE;
      END IF;

      target := resolve_escalation_target(kind, named, r.location_id, rec.owner, r.record_type, rec.id);

      INSERT INTO escalation_events (
        rule_id, location_id, record_type, record_id, record_label, record_status,
        step, target_kind, notified_user_id, owner_user_id, last_movement_at, days_stale
      ) VALUES (
        r.id, r.location_id, r.record_type, rec.id, rec.label, rec.status,
        step_no, kind, target, rec.owner, moved, stale
      );
      n_raised := n_raised + 1;

      IF target IS NOT NULL THEN
        INSERT INTO notifications (user_id, type, title, body, entity_type, entity_id, priority)
        VALUES (
          target, 'record_stalled',
          format('%s stalled %s days: %s', initcap(r.record_type::text), stale, rec.label),
          format('No status change, payment, touchpoint or email in %s days (rule "%s", step %s).', stale, r.name, step_no),
          r.record_type::text, rec.id,
          CASE WHEN step_no >= 2 THEN 'high'::notification_priority ELSE 'normal'::notification_priority END
        );
      END IF;
    END LOOP;
  END LOOP;

  raised := n_raised; resolved := n_resolved; RETURN NEXT;
END; $$;

REVOKE ALL ON FUNCTION public.run_escalation_scan() FROM public;
GRANT EXECUTE ON FUNCTION public.run_escalation_scan() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_last_movement(public.escalation_record_type, uuid) TO authenticated, service_role;

SELECT cron.schedule('escalation-scan-daily', '0 13 * * *', $$SELECT public.run_escalation_scan();$$);

-- ===== job_reports =====
CREATE TABLE public.job_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  location_id uuid REFERENCES public.locations(id) ON DELETE SET NULL,
  report_type public.job_report_type NOT NULL,
  language text NOT NULL DEFAULT 'en',
  version integer NOT NULL DEFAULT 1,
  status public.job_report_status NOT NULL DEFAULT 'draft',
  narrative text NOT NULL,
  edited_narrative text,
  snapshot jsonb NOT NULL,
  model text,
  document_id uuid REFERENCES public.documents(id) ON DELETE SET NULL,
  generated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, report_type, language, version)
);
CREATE INDEX idx_job_reports_job ON public.job_reports(job_id, report_type);

GRANT SELECT, INSERT, UPDATE ON public.job_reports TO authenticated;
GRANT ALL ON public.job_reports TO service_role;
ALTER TABLE public.job_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "view job reports" ON public.job_reports
  FOR SELECT TO authenticated USING (public.can_view_job(auth.uid(), job_id));
CREATE POLICY "create job reports" ON public.job_reports
  FOR INSERT TO authenticated
  WITH CHECK (public.can_view_job(auth.uid(), job_id) AND generated_by = auth.uid());
CREATE POLICY "edit job reports" ON public.job_reports
  FOR UPDATE TO authenticated
  USING (public.can_manage_job(auth.uid(), job_id))
  WITH CHECK (public.can_manage_job(auth.uid(), job_id));

CREATE TRIGGER trg_job_reports_updated BEFORE UPDATE ON public.job_reports
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();