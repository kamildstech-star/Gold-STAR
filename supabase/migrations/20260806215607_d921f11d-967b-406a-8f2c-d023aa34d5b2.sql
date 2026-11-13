CREATE TABLE IF NOT EXISTS public.account_focus_dismissals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  suggestion_key text NOT NULL,
  dismissed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, user_id, suggestion_key)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.account_focus_dismissals TO authenticated;
GRANT ALL ON public.account_focus_dismissals TO service_role;

ALTER TABLE public.account_focus_dismissals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own focus dismissals"
  ON public.account_focus_dismissals FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.account_focus(_account_id uuid)
RETURNS TABLE (
  suggestion_key text,
  severity text,
  title text,
  detail text,
  action text,
  sort_order int
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
WITH a AS (
  SELECT * FROM public.accounts WHERE id = _account_id
),
last_touch AS (
  SELECT max(occurred_at) AS at FROM public.touchpoints WHERE account_id = _account_id
),
last_inbound AS (
  SELECT max(occurred_at) AS at FROM public.captured_communications
  WHERE account_id = _account_id AND direction = 'inbound'
),
last_outbound AS (
  SELECT max(occurred_at) AS at FROM public.captured_communications
  WHERE account_id = _account_id AND direction = 'outbound'
),
rot AS (
  SELECT w.rot_days
  FROM a
  JOIN public.automation_stage_windows w
    ON w.stage_id = a.stage_id AND w.is_active
  LIMIT 1
),
s AS (
  SELECT 'cadence_overdue' AS suggestion_key,
         'warn' AS severity,
         CASE WHEN lt.at IS NULL THEN 'No touch ever recorded'
              ELSE 'Quarterly touch is overdue' END AS title,
         CASE WHEN lt.at IS NULL THEN 'Nothing has been captured against this account.'
              ELSE 'Last touch ' || (date_part('day', now() - lt.at))::int || ' days ago; the cadence is quarterly.' END AS detail,
         'log_touch' AS action,
         10 AS sort_order
  FROM a CROSS JOIN last_touch lt
  WHERE lt.at IS NULL OR lt.at < now() - interval '90 days'

  UNION ALL
  SELECT 'annual_meeting', 'warn',
         CASE WHEN a.annual_meeting_due_on < current_date THEN 'Annual in-person meeting is past due'
              ELSE 'Annual in-person meeting window is open' END,
         'Due ' || to_char(a.annual_meeting_due_on, 'DD Mon YYYY')
           || COALESCE(' · last in person ' || to_char(a.last_in_person_at, 'DD Mon YYYY'), ' · no in-person meeting on record'),
         'book_meeting', 20
  FROM a
  WHERE a.annual_meeting_due_on IS NOT NULL
    AND a.annual_meeting_due_on <= current_date + 14

  UNION ALL
  SELECT 'stage_rot', 'warn',
         'Stalled in this stage',
         (date_part('day', now() - a.stage_changed_at))::int || ' days in stage; the stage window is ' || r.rot_days || ' days.',
         'advance_stage', 30
  FROM a JOIN rot r ON true
  WHERE a.stage_changed_at IS NOT NULL
    AND r.rot_days IS NOT NULL
    AND a.stage_changed_at < now() - make_interval(days => r.rot_days)

  UNION ALL
  SELECT 'no_decision_maker', 'info',
         'No decision maker identified',
         CASE WHEN (SELECT count(*) FROM public.contacts c WHERE c.account_id = _account_id AND c.archived_at IS NULL) = 0
              THEN 'This account has no contacts at all.'
              ELSE 'Contacts exist, but none is marked as the decision maker.' END,
         'add_contact', 40
  FROM a
  WHERE NOT EXISTS (
    SELECT 1 FROM public.contacts c
    WHERE c.account_id = _account_id AND c.archived_at IS NULL AND c.decision_role = 'decision_maker'
  )

  UNION ALL
  SELECT 'gift_policy_conflict', 'danger',
         'Gift policy conflict',
         (SELECT count(*) FROM public.contacts c
           WHERE c.account_id = _account_id AND c.archived_at IS NULL AND c.gift_policy = 'prohibited')
           || ' contact(s) here may not accept gifts. Exclude them from any send.',
         'view_contacts', 5
  FROM a
  WHERE EXISTS (
    SELECT 1 FROM public.contacts c
    WHERE c.account_id = _account_id AND c.archived_at IS NULL AND c.gift_policy = 'prohibited'
  )

  UNION ALL
  SELECT 'tasks_overdue', 'warn',
         'Overdue tasks on this account',
         (SELECT count(*) FROM public.tasks t
           WHERE t.account_id = _account_id AND t.status IN ('open','in_progress') AND t.due_date < current_date)
           || ' task(s) past their due date.',
         'view_tasks', 15
  FROM a
  WHERE EXISTS (
    SELECT 1 FROM public.tasks t
    WHERE t.account_id = _account_id AND t.status IN ('open','in_progress') AND t.due_date < current_date
  )

  UNION ALL
  SELECT 'no_reply', 'info',
         'Outbound with no reply',
         'Last outbound ' || to_char(o.at, 'DD Mon') || COALESCE(', last reply ' || to_char(i.at, 'DD Mon YYYY'), ', no reply on record')
           || '. Outbound alone does not satisfy the cadence.',
         'call', 25
  FROM a CROSS JOIN last_outbound o LEFT JOIN last_inbound i ON true
  WHERE o.at IS NOT NULL AND (i.at IS NULL OR i.at < o.at) AND o.at < now() - interval '5 days'

  UNION ALL
  SELECT 'approval_pending', 'warn',
         'Awaiting Sales Head approval',
         COALESCE('Approval due ' || to_char(a.approval_due_on, 'DD Mon YYYY') || '.', 'No approval deadline set.'),
         'none', 1
  FROM a
  WHERE a.approval_state = 'pending'

  UNION ALL
  SELECT 'open_fire_lead', 'info',
         'Open fire-damage record linked',
         (SELECT count(*) FROM public.fire_leads f
           WHERE f.account_id = _account_id AND f.status = 'open' AND f.rescind_date IS NULL)
           || ' open record(s) tied to this account.',
         'view_leads', 35
  FROM a
  WHERE EXISTS (
    SELECT 1 FROM public.fire_leads f
    WHERE f.account_id = _account_id AND f.status = 'open' AND f.rescind_date IS NULL
  )
)
SELECT s.suggestion_key, s.severity, s.title, s.detail, s.action, s.sort_order
FROM s
WHERE NOT EXISTS (
  SELECT 1 FROM public.account_focus_dismissals d
  WHERE d.account_id = _account_id
    AND d.user_id = auth.uid()
    AND d.suggestion_key = s.suggestion_key
)
ORDER BY s.sort_order;
$$;

GRANT EXECUTE ON FUNCTION public.account_focus(uuid) TO authenticated;