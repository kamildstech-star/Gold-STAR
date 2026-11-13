CREATE OR REPLACE FUNCTION public.needs_you_today(_user_id uuid, _all boolean DEFAULT false)
RETURNS TABLE(
  item_key text,
  kind text,
  title text,
  account_id uuid,
  account_name text,
  subtitle text,
  due_at timestamptz,
  entity_id uuid,
  action text
)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  -- Meetings today and tomorrow
  SELECT 'meeting:' || e.id::text, 'meeting',
         COALESCE(e.subject, 'Meeting'),
         e.account_id,
         COALESCE(a.name, 'No account'),
         COALESCE(to_char(e.starts_at, 'Dy HH24:MI'), '') || COALESCE(' · ' || c.full_name, ''),
         e.starts_at, e.id, 'open_meeting'
  FROM calendar_events e
  LEFT JOIN accounts a ON a.id = e.account_id
  LEFT JOIN contacts c ON c.id = e.contact_id
  WHERE COALESCE(e.is_cancelled, false) = false
    AND e.starts_at >= date_trunc('day', now())
    AND e.starts_at < date_trunc('day', now()) + interval '2 days'
    AND (_all OR e.user_id = _user_id)

  UNION ALL
  -- Tasks due today or overdue
  SELECT 'task:' || t.id::text, 'task', t.title,
         t.account_id, COALESCE(a.name, '—'),
         CASE WHEN t.due_date < current_date THEN 'Overdue' ELSE 'Due today' END,
         (t.due_date::timestamptz + COALESCE(t.due_time, '17:00'::time)),
         t.id, 'complete_task'
  FROM tasks t
  LEFT JOIN accounts a ON a.id = t.account_id
  WHERE t.status IN ('open','in_progress')
    AND t.due_date IS NOT NULL
    AND t.due_date <= current_date
    AND (_all OR t.assignee = _user_id)

  UNION ALL
  -- Cadence touch overdue (quarterly)
  SELECT 'cadence:' || a.id::text, 'cadence', 'Touch overdue',
         a.id, a.name,
         COALESCE('Last touch ' || to_char(lt.at, 'DD Mon YYYY'), 'No touch ever recorded'),
         COALESCE(lt.at, a.created_at) + interval '90 days',
         a.id, 'log_touch'
  FROM accounts a
  LEFT JOIN LATERAL (
    SELECT max(occurred_at) AS at FROM touchpoints tp WHERE tp.account_id = a.id
  ) lt ON true
  WHERE a.archived_at IS NULL
    AND a.status IN ('prospect','onboarding','active')
    AND COALESCE(lt.at, a.created_at) < now() - interval '90 days'
    AND (_all OR a.assigned_rep = _user_id)

  UNION ALL
  -- Annual in-person meeting window
  SELECT 'annual:' || a.id::text, 'annual', 'Annual in-person meeting',
         a.id, a.name,
         'Window open · due ' || to_char(a.annual_meeting_due_on, 'DD Mon YYYY'),
         a.annual_meeting_due_on::timestamptz,
         a.id, 'book_meeting'
  FROM accounts a
  WHERE a.archived_at IS NULL
    AND a.annual_meeting_due_on IS NOT NULL
    AND a.annual_meeting_due_on <= current_date + 14
    AND a.annual_meeting_due_on >= current_date - 14
    AND (_all OR a.assigned_rep = _user_id)

  UNION ALL
  -- Deals rotting past their stage window
  SELECT 'rot:' || a.id::text, 'rot', 'Stalled in stage',
         a.id, a.name,
         (date_part('day', now() - a.stage_changed_at))::int || ' days in stage (window ' || w.rot_days || 'd)',
         a.stage_changed_at + make_interval(days => w.rot_days),
         a.id, 'open_account'
  FROM accounts a
  JOIN automation_stage_windows w ON w.stage_id = a.stage_id AND w.is_active
  WHERE a.archived_at IS NULL
    AND a.stage_changed_at IS NOT NULL
    AND w.rot_days IS NOT NULL
    AND a.stage_changed_at < now() - make_interval(days => w.rot_days)
    AND (_all OR a.assigned_rep = _user_id)

  UNION ALL
  -- Lead approvals past the 7-day mark (approvers only)
  SELECT 'approval:' || a.id::text, 'approval', 'Lead approval overdue',
         a.id, a.name,
         'Approval due ' || to_char(a.approval_due_on, 'DD Mon YYYY'),
         a.approval_due_on::timestamptz,
         a.id, 'approve_lead'
  FROM accounts a
  WHERE a.archived_at IS NULL
    AND a.approval_state IN ('pending','escalated')
    AND a.approval_due_on IS NOT NULL
    AND a.approval_due_on <= current_date
    AND public.can_approve_leads(_user_id)
$function$;

REVOKE ALL ON FUNCTION public.needs_you_today(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.needs_you_today(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.needs_you_today(uuid, boolean) TO service_role;