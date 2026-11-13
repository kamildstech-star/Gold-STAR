-- Generic change logger: records what changed on a row, before -> after.
CREATE OR REPLACE FUNCTION public.log_row_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_module text := TG_ARGV[0];
  v_record_type text := TG_ARGV[1];
  v_id_col text := TG_ARGV[2];
  v_label_col text := TG_ARGV[3];
  v_row jsonb;
  v_old jsonb;
  v_changes jsonb := '{}'::jsonb;
  v_detail jsonb;
  v_summary text;
  v_actor uuid := auth.uid();
  k text;
BEGIN
  IF TG_OP = 'DELETE' THEN v_row := to_jsonb(OLD); ELSE v_row := to_jsonb(NEW); END IF;

  IF TG_OP = 'UPDATE' THEN
    v_old := to_jsonb(OLD);
    FOR k IN SELECT jsonb_object_keys(v_row) LOOP
      IF k IN ('updated_at', 'created_at', 'search_vector') THEN CONTINUE; END IF;
      IF v_row -> k IS DISTINCT FROM v_old -> k THEN
        v_changes := v_changes || jsonb_build_object(
          k, jsonb_build_object('before', v_old -> k, 'after', v_row -> k));
      END IF;
    END LOOP;
    IF v_changes = '{}'::jsonb THEN RETURN NEW; END IF;
  END IF;

  v_summary := initcap(replace(v_record_type, '_', ' ')) || ' ' ||
    CASE TG_OP WHEN 'INSERT' THEN 'created' WHEN 'UPDATE' THEN 'edited' ELSE 'deleted' END ||
    CASE WHEN v_label_col IS NOT NULL AND v_row ->> v_label_col IS NOT NULL
         THEN ' — ' || (v_row ->> v_label_col) ELSE '' END ||
    CASE WHEN TG_OP = 'UPDATE'
         THEN ' (' || array_to_string(ARRAY(SELECT jsonb_object_keys(v_changes)), ', ') || ')'
         ELSE '' END;

  v_detail := jsonb_build_object('table', TG_TABLE_NAME, 'row_id', v_row ->> 'id');
  IF TG_OP = 'UPDATE' THEN v_detail := v_detail || jsonb_build_object('changes', v_changes); END IF;
  -- Parent keys let a child row surface on the parent record's timeline.
  FOREACH k IN ARRAY ARRAY['job_id','account_id','contact_id','estimate_id','invoice_id','project_id','lead_id'] LOOP
    IF v_row ? k AND v_row ->> k IS NOT NULL THEN
      v_detail := v_detail || jsonb_build_object(k, v_row ->> k);
    END IF;
  END LOOP;

  INSERT INTO public.activity_log (
    occurred_at, module, event_type, actor_id, via, summary, detail,
    record_type, record_id, record_label, location_id)
  VALUES (
    now(), v_module,
    v_record_type || '.' || lower(TG_OP),
    v_actor,
    CASE WHEN v_actor IS NULL THEN 'system' ELSE 'user' END,
    v_summary, v_detail,
    v_record_type,
    NULLIF(v_row ->> v_id_col, '')::uuid,
    CASE WHEN v_label_col IS NOT NULL THEN v_row ->> v_label_col ELSE NULL END,
    CASE WHEN v_row ? 'location_id' THEN NULLIF(v_row ->> 'location_id', '')::uuid ELSE NULL END);

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS log_activity_estimates ON public.estimates;
CREATE TRIGGER log_activity_estimates
AFTER UPDATE OR DELETE ON public.estimates
FOR EACH ROW EXECUTE FUNCTION public.log_row_activity('billing', 'estimate', 'id', 'title');

DROP TRIGGER IF EXISTS log_activity_invoices ON public.invoices;
CREATE TRIGGER log_activity_invoices
AFTER UPDATE OR DELETE ON public.invoices
FOR EACH ROW EXECUTE FUNCTION public.log_row_activity('billing', 'invoice', 'id', 'invoice_number');

DROP TRIGGER IF EXISTS log_activity_contacts ON public.contacts;
CREATE TRIGGER log_activity_contacts
AFTER INSERT OR UPDATE OR DELETE ON public.contacts
FOR EACH ROW EXECUTE FUNCTION public.log_row_activity('contacts', 'contact', 'id', 'full_name');

-- Per-record activity feed. Same shape as global_activity, scoped to one record.
CREATE OR REPLACE FUNCTION public.record_activity(
  _record_type text,
  _record_id uuid,
  _search text DEFAULT NULL,
  _limit integer DEFAULT 400,
  _offset integer DEFAULT 0
)
RETURNS TABLE (
  occurred_at timestamptz,
  module text,
  event_type text,
  actor_id uuid,
  actor_name text,
  via text,
  summary text,
  detail jsonb,
  record_type text,
  record_id uuid,
  record_label text,
  location_id uuid
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_job uuid;
  v_account uuid;
  v_contact uuid;
  v_estimate uuid;
  v_invoice uuid;
  v_ok boolean := false;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  IF _record_type = 'job' THEN
    v_job := _record_id;
  ELSIF _record_type = 'contact' THEN
    v_contact := _record_id;
  ELSIF _record_type = 'account' THEN
    v_account := _record_id;
  ELSIF _record_type = 'estimate' THEN
    v_estimate := _record_id;
    SELECT e.job_id INTO v_job FROM estimates e WHERE e.id = _record_id;
  ELSIF _record_type = 'invoice' THEN
    v_invoice := _record_id;
    SELECT i.job_id INTO v_job FROM invoices i WHERE i.id = _record_id;
  ELSE
    RAISE EXCEPTION 'Unsupported record type %', _record_type;
  END IF;

  IF public.is_privileged(v_uid) THEN
    v_ok := true;
  ELSIF v_job IS NOT NULL THEN
    v_ok := public.can_view_job(v_uid, v_job);
  ELSIF v_contact IS NOT NULL THEN
    v_ok := public.can_view_contact_row(v_uid, v_contact);
  ELSIF v_account IS NOT NULL THEN
    SELECT public.can_view_location(v_uid, a.location_id) INTO v_ok FROM accounts a WHERE a.id = _record_id;
  ELSIF v_estimate IS NOT NULL THEN
    SELECT public.can_view_location(v_uid, e.location_id) INTO v_ok FROM estimates e WHERE e.id = _record_id;
  ELSIF v_invoice IS NOT NULL THEN
    SELECT public.can_view_location(v_uid, i.location_id) INTO v_ok FROM invoices i WHERE i.id = _record_id;
  END IF;

  IF NOT COALESCE(v_ok, false) THEN
    RAISE EXCEPTION 'Not authorised to read this record history';
  END IF;

  RETURN QUERY
  WITH src AS (
    -- Field-level job edits
    SELECT c.changed_at AS occurred_at, 'jobs'::text AS module, 'job.field_changed'::text AS event_type,
           c.changed_by AS actor_id, 'user'::text AS via,
           'Field "' || c.field || '" changed' AS summary,
           jsonb_build_object('field', c.field, 'before', c.old_value, 'after', c.new_value) AS detail,
           'job'::text AS record_type, c.job_id AS record_id, NULL::text AS record_label, NULL::uuid AS location_id
    FROM job_field_changes c WHERE v_job IS NOT NULL AND c.job_id = v_job

    UNION ALL
    SELECT h.changed_at, 'jobs', 'job.status_changed', h.changed_by, 'user',
           'Status ' || COALESCE(h.from_status::text, 'new') || ' → ' || h.to_status::text,
           jsonb_build_object('before', h.from_status, 'after', h.to_status),
           'job', h.job_id, NULL::text, NULL::uuid
    FROM job_status_history h WHERE v_job IS NOT NULL AND h.job_id = v_job

    UNION ALL
    SELECT n.created_at, 'jobs', 'note.created', n.author_id, 'user',
           'Note added', jsonb_build_object('body', n.body), 'job', n.job_id, NULL::text, NULL::uuid
    FROM job_notes n WHERE v_job IS NOT NULL AND n.job_id = v_job

    UNION ALL
    SELECT sn.created_at, 'jobs', 'note.section', sn.author_id, 'user',
           'Note on ' || sn.section_key, jsonb_build_object('body', sn.body, 'section', sn.section_key),
           'job', sn.job_id, NULL::text, NULL::uuid
    FROM job_section_notes sn WHERE v_job IS NOT NULL AND sn.job_id = v_job

    UNION ALL
    SELECT ja.created_at, 'jobs', 'crew.assigned', NULL::uuid, 'user',
           'Crew assigned: ' || COALESCE(p.full_name, 'user') || ' (' || ja.role::text || ')',
           jsonb_build_object('user', p.full_name, 'role', ja.role),
           'job', ja.job_id, p.full_name, NULL::uuid
    FROM job_assignments ja LEFT JOIN profiles p ON p.user_id = ja.user_id
    WHERE v_job IS NOT NULL AND ja.job_id = v_job

    UNION ALL
    SELECT ph.created_at, 'photos', 'photo.uploaded', ph.uploader_id, 'user',
           'Photo uploaded', jsonb_build_object('path', ph.storage_path_original, 'captured_at', ph.captured_at),
           'job', pr.job_id, NULL::text, pr.location_id
    FROM photos ph JOIN projects pr ON pr.id = ph.project_id
    WHERE v_job IS NOT NULL AND pr.job_id = v_job AND ph.deleted_at IS NULL

    UNION ALL
    SELECT ph.deleted_at, 'photos', 'photo.deleted', ph.deleted_by, 'user',
           'Photo deleted' || COALESCE(' — ' || ph.deleted_reason, ''),
           jsonb_build_object('path', ph.storage_path_original, 'reason', ph.deleted_reason),
           'job', pr.job_id, NULL::text, pr.location_id
    FROM photos ph JOIN projects pr ON pr.id = ph.project_id
    WHERE v_job IS NOT NULL AND pr.job_id = v_job AND ph.deleted_at IS NOT NULL

    UNION ALL
    SELECT d.created_at, 'documents', 'document.created', d.created_by, 'user',
           'Document generated — ' || d.name, jsonb_build_object('status', d.status, 'type', d.doc_type),
           'document', d.id, d.name, d.location_id
    FROM documents d
    WHERE (v_job IS NOT NULL AND d.job_id = v_job)
       OR (v_contact IS NOT NULL AND d.contact_id = v_contact)
       OR (v_account IS NOT NULL AND d.account_id = v_account)

    UNION ALL
    SELECT de.created_at, 'documents', 'document.' || de.event_type::text, de.actor_id, 'user',
           'Document ' || replace(de.event_type::text, '_', ' ') || COALESCE(' — ' || d.name, ''),
           COALESCE(de.detail, '{}'::jsonb), 'document', de.document_id, d.name, d.location_id
    FROM document_events de JOIN documents d ON d.id = de.document_id
    WHERE (v_job IS NOT NULL AND d.job_id = v_job)
       OR (v_contact IS NOT NULL AND d.contact_id = v_contact)
       OR (v_account IS NOT NULL AND d.account_id = v_account)

    UNION ALL
    SELECT sg.signed_at, 'documents', 'document.signed', sg.captured_by, 'user',
           'Signed by ' || COALESCE(sg.signer_name, 'signer'),
           jsonb_build_object('signer', sg.signer_name, 'role', sg.signer_role, 'provider', sg.provider),
           'document', sg.document_id, d.name, d.location_id
    FROM document_signatures sg JOIN documents d ON d.id = sg.document_id
    WHERE sg.signed_at IS NOT NULL
      AND ((v_job IS NOT NULL AND d.job_id = v_job)
        OR (v_contact IS NOT NULL AND d.contact_id = v_contact)
        OR (v_account IS NOT NULL AND d.account_id = v_account))

    UNION ALL
    SELECT pk.sent_at, 'documents', 'document.packet_sent', pk.created_by, 'user',
           'Document packet sent to ' || COALESCE(pk.recipient_email, pk.recipient_name, 'recipient'),
           jsonb_build_object('subject', pk.subject, 'recipient', pk.recipient_email),
           'job', pk.job_id, pk.subject, pk.location_id
    FROM document_send_packets pk
    WHERE pk.sent_at IS NOT NULL
      AND ((v_job IS NOT NULL AND pk.job_id = v_job) OR (v_account IS NOT NULL AND pk.account_id = v_account))

    UNION ALL
    SELECT e.created_at, 'billing', 'estimate.created', e.created_by, 'user',
           'Estimate created — ' || COALESCE(e.title, e.job_number, 'estimate'),
           jsonb_build_object('status', e.status, 'total', e.total),
           'estimate', e.id, e.title, e.location_id
    FROM estimates e
    WHERE (v_estimate IS NOT NULL AND e.id = v_estimate) OR (v_job IS NOT NULL AND e.job_id = v_job)

    UNION ALL
    SELECT i.created_at, 'billing', 'invoice.created', i.created_by, 'user',
           'Invoice created — ' || COALESCE(i.invoice_number, 'invoice'),
           jsonb_build_object('status', i.status, 'total', i.total, 'from_estimate', i.estimate_id),
           'invoice', i.id, i.invoice_number, i.location_id
    FROM invoices i
    WHERE (v_invoice IS NOT NULL AND i.id = v_invoice) OR (v_job IS NOT NULL AND i.job_id = v_job)

    UNION ALL
    SELECT rv.created_at, 'billing', rv.kind || '.version_created', rv.created_by, 'user',
           initcap(rv.kind) || ' v' || rv.version || ' created',
           jsonb_build_object('version', rv.version, 'total', rv.total, 'changes', rv.change_summary),
           rv.kind, rv.record_id, rv.kind || ' v' || rv.version, rv.location_id
    FROM record_revisions rv
    WHERE (v_estimate IS NOT NULL AND rv.record_id = v_estimate)
       OR (v_invoice IS NOT NULL AND rv.record_id = v_invoice)
       OR (v_job IS NOT NULL AND rv.record_id IN (
             SELECT e2.id FROM estimates e2 WHERE e2.job_id = v_job
             UNION ALL SELECT i2.id FROM invoices i2 WHERE i2.job_id = v_job))

    UNION ALL
    SELECT rs.sent_at, 'billing', 'revision.sent', rs.sent_by, 'user',
           initcap(rv.kind) || ' v' || rv.version || ' sent to ' || rs.recipient,
           jsonb_build_object('version', rv.version, 'channel', rs.channel, 'total', rv.total),
           rv.kind, rv.record_id, rv.kind || ' v' || rv.version, rv.location_id
    FROM record_revision_sends rs JOIN record_revisions rv ON rv.id = rs.revision_id
    WHERE (v_estimate IS NOT NULL AND rv.record_id = v_estimate)
       OR (v_invoice IS NOT NULL AND rv.record_id = v_invoice)
       OR (v_job IS NOT NULL AND rv.record_id IN (
             SELECT e2.id FROM estimates e2 WHERE e2.job_id = v_job
             UNION ALL SELECT i2.id FROM invoices i2 WHERE i2.job_id = v_job))

    UNION ALL
    SELECT ip.created_at, 'billing', 'payment.recorded', ip.created_by, 'user',
           'Payment recorded on ' || COALESCE(i.invoice_number, 'invoice'),
           jsonb_build_object('amount', ip.amount, 'method', ip.method, 'reference', ip.reference),
           'invoice', ip.invoice_id, i.invoice_number, i.location_id
    FROM invoice_payments ip JOIN invoices i ON i.id = ip.invoice_id
    WHERE (v_invoice IS NOT NULL AND ip.invoice_id = v_invoice) OR (v_job IS NOT NULL AND i.job_id = v_job)

    UNION ALL
    SELECT me.created_at, 'billing', 'money.' || me.event_type::text, me.created_by, 'user',
           'Money event ' || replace(me.event_type::text, '_', ' '),
           jsonb_build_object('amount', me.amount, 'reference', me.reference, 'notes', me.notes),
           'job', me.job_id, me.reference, me.location_id
    FROM money_events me
    WHERE (v_job IS NOT NULL AND me.job_id = v_job)
       OR (v_invoice IS NOT NULL AND me.invoice_id = v_invoice)
       OR (v_account IS NOT NULL AND me.account_id = v_account)

    UNION ALL
    SELECT te.created_at, 'time', 'time_entry.submitted', te.user_id, 'user',
           'Time entry submitted (' || COALESCE(te.minutes, 0) || ' min)',
           jsonb_build_object('minutes', te.minutes, 'status', te.status, 'type', te.entry_type),
           'job', te.job_id, NULL::text, NULL::uuid
    FROM time_entries te WHERE v_job IS NOT NULL AND te.job_id = v_job

    UNION ALL
    SELECT te.approved_at, 'time', 'time_entry.approved', te.approved_by, 'user',
           'Time entry approved (' || COALESCE(te.minutes, 0) || ' min)',
           jsonb_build_object('minutes', te.minutes, 'status', te.status),
           'job', te.job_id, NULL::text, NULL::uuid
    FROM time_entries te WHERE v_job IS NOT NULL AND te.job_id = v_job AND te.approved_at IS NOT NULL

    UNION ALL
    SELECT ep.placed_at, 'equipment', 'equipment.placed', ep.placed_by, 'user',
           'Equipment placed — ' || COALESCE(eq.name, eq.equipment_type::text, 'unit'),
           jsonb_build_object('equipment', eq.name, 'expected_retrieval', ep.expected_retrieval_date),
           'job', ep.job_id, eq.name, NULL::uuid
    FROM equipment_placements ep LEFT JOIN equipment eq ON eq.id = ep.equipment_id
    WHERE v_job IS NOT NULL AND ep.job_id = v_job

    UNION ALL
    SELECT ep.retrieved_at, 'equipment', 'equipment.retrieved', ep.retrieved_by, 'user',
           'Equipment retrieved — ' || COALESCE(eq.name, eq.equipment_type::text, 'unit'),
           jsonb_build_object('equipment', eq.name, 'condition', ep.return_condition),
           'job', ep.job_id, eq.name, NULL::uuid
    FROM equipment_placements ep LEFT JOIN equipment eq ON eq.id = ep.equipment_id
    WHERE v_job IS NOT NULL AND ep.job_id = v_job AND ep.retrieved_at IS NOT NULL

    UNION ALL
    SELECT sr.created_at, 'supplies', 'supply_request.created', sr.requester_id, 'user',
           'Supply request raised', jsonb_build_object('status', sr.status, 'note', sr.note, 'needed_by', sr.needed_by),
           'job', sr.job_id, NULL::text, sr.location_id
    FROM supply_requests sr WHERE v_job IS NOT NULL AND sr.job_id = v_job

    UNION ALL
    SELECT sr.decided_at, 'supplies', 'supply_request.decided', sr.decided_by, 'user',
           'Supply request ' || sr.status::text,
           jsonb_build_object('status', sr.status, 'denial_reason', sr.denial_reason),
           'job', sr.job_id, NULL::text, sr.location_id
    FROM supply_requests sr WHERE v_job IS NOT NULL AND sr.job_id = v_job AND sr.decided_at IS NOT NULL

    UNION ALL
    SELECT GREATEST(ia.created_at, ia.updated_at), 'jobs', 'questionnaire.answered', ia.answered_by, 'user',
           'Questionnaire answer — ' || COALESCE(qq.label, 'question'),
           jsonb_build_object('answer', COALESCE(ia.answer_text, ia.answer_bool::text, ia.answer_date::text),
                              'source', ia.source),
           'job', ia.job_id, NULL::text, NULL::uuid
    FROM job_intake_answers ia LEFT JOIN intake_questions qq ON qq.id = ia.question_id
    WHERE v_job IS NOT NULL AND ia.job_id = v_job

    UNION ALL
    SELECT jr.created_at, 'jobs', 'work_order.generated', jr.generated_by, 'user',
           'Work order / report generated (v' || jr.version || ', ' || jr.language || ')',
           jsonb_build_object('type', jr.report_type, 'status', jr.status, 'language', jr.language),
           'job', jr.job_id, NULL::text, jr.location_id
    FROM job_reports jr WHERE v_job IS NOT NULL AND jr.job_id = v_job

    UNION ALL
    SELECT jr.approved_at, 'jobs', 'work_order.approved', jr.approved_by, 'user',
           'Work order approved (v' || jr.version || ')',
           jsonb_build_object('type', jr.report_type, 'language', jr.language),
           'job', jr.job_id, NULL::text, jr.location_id
    FROM job_reports jr WHERE v_job IS NOT NULL AND jr.job_id = v_job AND jr.approved_at IS NOT NULL

    UNION ALL
    SELECT COALESCE(tr.corrected_at, tr.created_at), 'jobs', 'translation.saved',
           COALESCE(tr.corrected_by, tr.created_by), 'user',
           'Translation ' || tr.lang || ' — ' || tr.field,
           jsonb_build_object('lang', tr.lang, 'field', tr.field, 'source', tr.source, 'text', left(tr.text, 400)),
           'job', v_job, NULL::text, NULL::uuid
    FROM translations tr
    WHERE v_job IS NOT NULL AND tr.entity_type = 'job' AND tr.entity_id = v_job

    UNION ALL
    SELECT t.created_at, 'tasks', 'task.created', t.created_by,
           CASE WHEN t.automation_rule_id IS NOT NULL THEN 'automation' ELSE 'user' END,
           'Task created — ' || t.title,
           jsonb_build_object('due', t.due_date, 'priority', t.priority, 'reason', t.automation_reason),
           'task', t.id, t.title, t.location_id
    FROM tasks t
    WHERE (v_job IS NOT NULL AND t.job_id = v_job)
       OR (v_contact IS NOT NULL AND t.contact_id = v_contact)
       OR (v_account IS NOT NULL AND t.account_id = v_account)

    UNION ALL
    SELECT t.completed_at, 'tasks', 'task.completed', t.assignee, 'user',
           'Task completed — ' || t.title, jsonb_build_object('priority', t.priority),
           'task', t.id, t.title, t.location_id
    FROM tasks t
    WHERE t.completed_at IS NOT NULL
      AND ((v_job IS NOT NULL AND t.job_id = v_job)
        OR (v_contact IS NOT NULL AND t.contact_id = v_contact)
        OR (v_account IS NOT NULL AND t.account_id = v_account))

    UNION ALL
    SELECT COALESCE(em.sent_at, em.created_at), 'email', 'email.' || em.status::text, em.sent_by, 'user',
           'Email ' || em.status::text || ' — ' || COALESCE(em.subject, '(no subject)'),
           jsonb_build_object('to', em.to_emails, 'subject', em.subject, 'opened_at', em.opened_at),
           'email', em.id, em.subject, em.location_id
    FROM email_messages em
    WHERE (v_job IS NOT NULL AND em.job_id = v_job)
       OR (v_contact IS NOT NULL AND em.contact_id = v_contact)
       OR (v_invoice IS NOT NULL AND em.invoice_id = v_invoice)
       OR (v_account IS NOT NULL AND em.account_id = v_account)

    UNION ALL
    SELECT ca.occurred_at, 'calls', 'call.logged', ca.author_id, 'user',
           'Call ' || COALESCE(ca.outcome, 'logged') ||
             CASE WHEN ca.duration_seconds IS NOT NULL THEN ' (' || ca.duration_seconds || 's)' ELSE '' END,
           jsonb_build_object('channel', ca.channel, 'outcome', ca.outcome, 'notes', ca.notes,
                              'recording', ca.recording_url),
           'contact', ca.contact_id, NULL::text, NULL::uuid
    FROM contact_attempts ca
    WHERE (v_contact IS NOT NULL AND ca.contact_id = v_contact)
       OR (v_account IS NOT NULL AND ca.account_id = v_account)

    UNION ALL
    SELECT tp.created_at, 'accounts', 'touchpoint.' || tp.touchpoint_type::text, tp.created_by, 'user',
           'Touchpoint ' || replace(tp.touchpoint_type::text, '_', ' '),
           jsonb_build_object('notes', tp.notes), 'account', tp.account_id, NULL::text, NULL::uuid
    FROM touchpoints tp
    WHERE (v_account IS NOT NULL AND tp.account_id = v_account)
       OR (v_contact IS NOT NULL AND tp.contact_id = v_contact)

    UNION ALL
    SELECT ae.created_at, 'automation', 'automation.action', NULL::uuid, 'automation',
           'Automation action ' || ae.action_kind::text || COALESCE(' — ' || ae.reason, ''),
           jsonb_build_object('rule', ru.name, 'reason', ae.reason),
           ae.record_type, ae.record_id, ae.record_label, ae.location_id
    FROM automation_events ae LEFT JOIN automation_rules ru ON ru.id = ae.rule_id
    WHERE ae.record_id IN (v_job, v_account, v_contact, v_estimate, v_invoice)

    UNION ALL
    SELECT al.occurred_at, al.module, al.event_type, al.actor_id, al.via,
           al.summary, al.detail, al.record_type, al.record_id, al.record_label, al.location_id
    FROM activity_log al
    WHERE al.record_id IN (v_job, v_account, v_contact, v_estimate, v_invoice)
       OR (v_job IS NOT NULL AND al.detail ->> 'job_id' = v_job::text)
       OR (v_account IS NOT NULL AND al.detail ->> 'account_id' = v_account::text)
       OR (v_contact IS NOT NULL AND al.detail ->> 'contact_id' = v_contact::text)
       OR (v_estimate IS NOT NULL AND al.detail ->> 'estimate_id' = v_estimate::text)
       OR (v_invoice IS NOT NULL AND al.detail ->> 'invoice_id' = v_invoice::text)
  )
  SELECT s.occurred_at, s.module, s.event_type, s.actor_id,
         p.full_name AS actor_name, s.via, s.summary, s.detail,
         s.record_type, s.record_id, s.record_label, s.location_id
  FROM src s
  LEFT JOIN profiles p ON p.user_id = s.actor_id
  WHERE s.occurred_at IS NOT NULL
    AND (
      _search IS NULL OR _search = '' OR
      s.summary ILIKE '%' || _search || '%' OR
      s.event_type ILIKE '%' || _search || '%' OR
      COALESCE(s.record_label, '') ILIKE '%' || _search || '%' OR
      COALESCE(p.full_name, '') ILIKE '%' || _search || '%' OR
      s.detail::text ILIKE '%' || _search || '%'
    )
  ORDER BY s.occurred_at DESC
  LIMIT GREATEST(1, LEAST(_limit, 2000))
  OFFSET GREATEST(0, _offset);
END;
$$;