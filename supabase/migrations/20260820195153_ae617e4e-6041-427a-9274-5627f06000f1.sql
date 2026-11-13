CREATE OR REPLACE FUNCTION public.global_activity(
  _from timestamptz DEFAULT (now() - interval '30 days'),
  _to timestamptz DEFAULT now(),
  _modules text[] DEFAULT NULL,
  _event_types text[] DEFAULT NULL,
  _actor uuid DEFAULT NULL,
  _record uuid DEFAULT NULL,
  _location uuid DEFAULT NULL,
  _search text DEFAULT NULL,
  _limit integer DEFAULT 200,
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
BEGIN
  IF NOT public.is_privileged(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorised to read global activity';
  END IF;

  RETURN QUERY
  WITH src AS (
    SELECT c.changed_at AS occurred_at, 'jobs'::text AS module, 'record.field_changed'::text AS event_type,
           c.changed_by AS actor_id, 'user'::text AS via,
           'Job field "' || c.field || '" changed' AS summary,
           jsonb_build_object('field', c.field, 'before', c.old_value, 'after', c.new_value) AS detail,
           'job'::text AS record_type, c.job_id AS record_id, j.job_number AS record_label, j.location_id
    FROM job_field_changes c LEFT JOIN jobs j ON j.id = c.job_id

    UNION ALL
    SELECT h.changed_at, 'jobs', 'status.changed', h.changed_by, 'user',
           'Job status ' || COALESCE(h.from_status::text, 'new') || ' -> ' || h.to_status::text,
           jsonb_build_object('before', h.from_status, 'after', h.to_status),
           'job', h.job_id, j.job_number, j.location_id
    FROM job_status_history h LEFT JOIN jobs j ON j.id = h.job_id

    UNION ALL
    SELECT n.created_at, 'jobs', 'note.created', n.author_id, 'user',
           'Job note added', jsonb_build_object('body', left(n.body, 400)),
           'job', n.job_id, j.job_number, j.location_id
    FROM job_notes n LEFT JOIN jobs j ON j.id = n.job_id

    UNION ALL
    SELECT s.changed_at, 'accounts', 'stage.changed', s.changed_by, 'user',
           'Account stage ' || COALESCE(s.from_stage::text, 'new') || ' -> ' || COALESCE(s.to_stage::text, '?'),
           jsonb_build_object('before', s.from_stage::text, 'after', s.to_stage::text, 'reason', s.reason),
           'account', s.account_id, a.name, a.location_id
    FROM account_stage_history s LEFT JOIN accounts a ON a.id = s.account_id

    UNION ALL
    SELECT n.created_at, 'accounts', 'note.created', n.created_by, 'user',
           'Account note added', jsonb_build_object('body', left(n.body, 400)),
           'account', n.account_id, a.name, a.location_id
    FROM account_notes n LEFT JOIN accounts a ON a.id = n.account_id

    UNION ALL
    SELECT l.changed_at, 'pipeline', 'stage.changed', l.changed_by, 'user',
           'Lead stage ' || COALESCE(l.from_stage::text, 'new') || ' -> ' || COALESCE(l.to_stage::text, '?'),
           jsonb_build_object('before', l.from_stage::text, 'after', l.to_stage::text),
           'lead', l.lead_id, NULL::text, NULL::uuid
    FROM lead_stage_history l

    UNION ALL
    SELECT e.occurred_at, 'pipeline', 'lead.' || e.event_type::text, e.actor_id, 'user',
           'Lead ' || replace(e.event_type::text, '_', ' '), COALESCE(e.payload, '{}'::jsonb),
           'lead', e.lead_id, NULL::text, NULL::uuid
    FROM lead_events e

    UNION ALL
    SELECT r.started_at, 'automation', 'automation.run', r.triggered_by, 'automation',
           'Automation run: ' || COALESCE(ru.name, 'rule') ||
             ' (' || COALESCE(r.matched_count, 0) || ' matched, ' || COALESCE(r.action_count, 0) || ' actions)',
           jsonb_build_object('evaluated', r.evaluated_count, 'matched', r.matched_count,
                              'actions', r.action_count, 'error', r.error),
           'automation_rule', r.rule_id, ru.name, NULL::uuid
    FROM automation_runs r LEFT JOIN automation_rules ru ON ru.id = r.rule_id

    UNION ALL
    SELECT ae.created_at, 'automation', 'automation.action', NULL::uuid, 'automation',
           'Automation action ' || ae.action_kind::text || COALESCE(' — ' || ae.reason, ''),
           jsonb_build_object('rule', ru.name, 'reason', ae.reason, 'action', ae.action_kind),
           ae.record_type, ae.record_id, ae.record_label, ae.location_id
    FROM automation_events ae LEFT JOIN automation_rules ru ON ru.id = ae.rule_id

    UNION ALL
    SELECT au.created_at, 'assistant', 'assistant.' || au.feature, COALESCE(au.effective_user_id, au.actor_user_id), 'assistant',
           'Assistant ' || au.feature || COALESCE(': ' || left(au.question, 160), ''),
           jsonb_build_object('outcome', au.outcome, 'model', au.model,
                              'redactions', au.redactions, 'response', left(au.response_preview, 400)),
           NULL::text, NULL::uuid, NULL::text, NULL::uuid
    FROM assistant_audit au

    UNION ALL
    SELECT de.created_at, 'documents', 'document.' || de.event_type::text, de.actor_id, 'user',
           'Document ' || replace(de.event_type::text, '_', ' ') || COALESCE(' — ' || d.title, ''),
           COALESCE(de.detail, '{}'::jsonb), 'document', de.document_id, d.title, d.location_id
    FROM document_events de LEFT JOIN documents d ON d.id = de.document_id

    UNION ALL
    SELECT p.sent_at, 'documents', 'document.packet_sent', p.created_by, 'user',
           'Document packet sent to ' || COALESCE(p.recipient_email, p.recipient_name, 'recipient'),
           jsonb_build_object('subject', p.subject, 'recipient', p.recipient_email),
           'job', p.job_id, p.subject, p.location_id
    FROM document_send_packets p WHERE p.sent_at IS NOT NULL

    UNION ALL
    SELECT sg.signed_at, 'documents', 'document.signed', sg.captured_by, 'user',
           'Signed by ' || COALESCE(sg.signer_name, 'signer'),
           jsonb_build_object('signer', sg.signer_name, 'role', sg.signer_role, 'provider', sg.provider),
           'document', sg.document_id, d.title, d.location_id
    FROM document_signatures sg LEFT JOIN documents d ON d.id = sg.document_id
    WHERE sg.signed_at IS NOT NULL

    UNION ALL
    SELECT rs.sent_at, 'billing', 'revision.sent', rs.sent_by, 'user',
           initcap(rv.kind) || ' v' || rv.version || ' sent to ' || rs.recipient,
           jsonb_build_object('version', rv.version, 'channel', rs.channel, 'total', rv.total),
           rv.kind, rv.record_id, rv.kind || ' v' || rv.version, rv.location_id
    FROM record_revision_sends rs JOIN record_revisions rv ON rv.id = rs.revision_id

    UNION ALL
    SELECT me.created_at, 'billing', 'money.' || me.event_type::text, me.created_by, 'user',
           'Money event ' || replace(me.event_type::text, '_', ' '),
           jsonb_build_object('amount', me.amount, 'reference', me.reference, 'notes', me.notes),
           'job', me.job_id, me.reference, me.location_id
    FROM money_events me

    UNION ALL
    SELECT ip.created_at, 'billing', 'payment.recorded', ip.created_by, 'user',
           'Payment recorded on ' || COALESCE(i.invoice_number, 'invoice'),
           jsonb_build_object('amount', ip.amount, 'method', ip.method, 'reference', ip.reference),
           'invoice', ip.invoice_id, i.invoice_number, i.location_id
    FROM invoice_payments ip LEFT JOIN invoices i ON i.id = ip.invoice_id

    UNION ALL
    SELECT rc.occurred_at, 'admin', 'permission.changed', rc.actor_id, 'user',
           'Permission change: ' || rc.entity || ' ' || rc.action,
           jsonb_build_object('before', rc.old_value, 'after', rc.new_value, 'entity', rc.entity),
           'user', rc.target_user_id, pr.full_name, NULL::uuid
    FROM role_change_audit rc LEFT JOIN profiles pr ON pr.user_id = rc.target_user_id

    UNION ALL
    SELECT ia.started_at, 'admin', 'view_as.started', ia.actor_id, 'user',
           'Started View As ' || COALESCE(pr.full_name, ia.preview_role::text),
           jsonb_build_object('preview_role', ia.preview_role, 'ended_at', ia.ended_at,
                              'ended_reason', ia.ended_reason),
           'user', ia.target_user_id, pr.full_name, NULL::uuid
    FROM impersonation_audit ia LEFT JOIN profiles pr ON pr.user_id = ia.target_user_id

    UNION ALL
    SELECT ic.created_at, 'integrations', 'credential.' || ic.action, ic.actor_id, 'user',
           'Integration credential ' || ic.action || ': ' || ic.provider || ' / ' || ic.key_name,
           jsonb_build_object('provider', ic.provider, 'key', ic.key_name, 'actor_email', ic.actor_email),
           NULL::text, NULL::uuid, ic.provider, NULL::uuid
    FROM integration_credential_audit ic

    UNION ALL
    SELECT le.created_at, 'admin', 'layout.' || le.action, le.actor_id, 'user',
           'Layout ' || le.action || ' for ' || le.scope || ' (' || COALESCE(le.role_key, 'all roles') || ')',
           jsonb_build_object('scope', le.scope, 'role', le.role_key, 'affected_users', le.affected_users),
           NULL::text, NULL::uuid, le.scope, NULL::uuid
    FROM layout_default_events le

    UNION ALL
    SELECT ea.created_at, 'admin', 'data.exported', ea.user_id, 'user',
           'Exported ' || ea.record_count || ' ' || ea.entity || ' from ' || ea.surface,
           jsonb_build_object('format', ea.format, 'filters', ea.filters, 'count', ea.record_count),
           NULL::text, NULL::uuid, ea.entity, NULL::uuid
    FROM export_audit ea

    UNION ALL
    SELECT dr.created_at, 'accounts', 'deal.reassigned', dr.created_by, 'user',
           'Account reassigned', jsonb_build_object('before', dr.from_user_id, 'after', dr.to_user_id,
                                                    'reason', dr.reason, 'note', dr.reason_note),
           'account', dr.account_id, a.name, a.location_id
    FROM deal_reassignments dr LEFT JOIN accounts a ON a.id = dr.account_id

    UNION ALL
    SELECT al.occurred_at, al.module, al.event_type, al.actor_id, al.via,
           al.summary, al.detail, al.record_type, al.record_id, al.record_label, al.location_id
    FROM activity_log al
  )
  SELECT s.occurred_at, s.module, s.event_type, s.actor_id,
         p.full_name AS actor_name, s.via, s.summary, s.detail,
         s.record_type, s.record_id, s.record_label, s.location_id
  FROM src s
  LEFT JOIN profiles p ON p.user_id = s.actor_id
  WHERE s.occurred_at IS NOT NULL
    AND s.occurred_at >= _from
    AND s.occurred_at <= _to
    AND (_modules IS NULL OR s.module = ANY(_modules))
    AND (_event_types IS NULL OR s.event_type = ANY(_event_types))
    AND (_actor IS NULL OR s.actor_id = _actor)
    AND (_record IS NULL OR s.record_id = _record)
    AND (_location IS NULL OR s.location_id = _location)
    AND (
      _search IS NULL OR _search = '' OR
      s.summary ILIKE '%' || _search || '%' OR
      s.event_type ILIKE '%' || _search || '%' OR
      COALESCE(s.record_label, '') ILIKE '%' || _search || '%' OR
      COALESCE(p.full_name, '') ILIKE '%' || _search || '%' OR
      s.detail::text ILIKE '%' || _search || '%'
    )
  ORDER BY s.occurred_at DESC
  LIMIT GREATEST(1, LEAST(_limit, 5000))
  OFFSET GREATEST(0, _offset);
END;
$$;