CREATE OR REPLACE FUNCTION public.run_escalation_scan()
RETURNS TABLE(raised integer, resolved integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
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
          FROM invoices i WHERE r.record_type::text = 'invoice'
        UNION ALL
        SELECT q.id, q.location_id, q.status::text,
               COALESCE(q.title, 'Estimate'), q.created_by
          FROM quotes q WHERE r.record_type::text = 'estimate'
        UNION ALL
        SELECT j.id, j.location_id, j.status::text,
               COALESCE(j.job_number, j.address, 'Job'), COALESCE(j.crew_chief, j.created_by)
          FROM jobs j WHERE r.record_type::text = 'job'
        UNION ALL
        SELECT a.id, a.location_id, a.stage::text, a.name, COALESCE(a.assigned_rep, a.created_by)
          FROM accounts a WHERE r.record_type::text = 'account'
        UNION ALL
        SELECT l.id, l.location_id, l.pipeline_stage::text,
               COALESCE(l.address, 'Lead'), l.assigned_rep
          FROM fire_leads l WHERE r.record_type::text = 'lead'
        UNION ALL
        -- Only unsatisfied compliance lines are worth escalating; a current
        -- certificate is not a stalled record.
        SELECT c.requirement_id, c.location_id, c.status,
               c.account_name || ' · ' || c.requirement_type,
               COALESCE(a2.assigned_rep, a2.created_by)
          FROM account_compliance_status c
          JOIN accounts a2 ON a2.id = c.account_id
         WHERE r.record_type::text = 'compliance'
           AND c.status <> 'satisfied'
      ) s
      WHERE s.location_id = r.location_id
        AND (cardinality(r.statuses) = 0 OR s.status = ANY (r.statuses))
    LOOP
      moved := record_last_movement(r.record_type, rec.id);
      IF moved IS NULL THEN CONTINUE; END IF;
      stale := GREATEST(0, (EXTRACT(EPOCH FROM (now() - moved)) / 86400)::int);

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
END; $function$;