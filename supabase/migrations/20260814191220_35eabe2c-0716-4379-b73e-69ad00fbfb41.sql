INSERT INTO public.app_settings (key, value)
VALUES ('leads', jsonb_build_object('require_approval', false))
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.leads_require_approval()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT (value->>'require_approval')::boolean FROM public.app_settings WHERE key = 'leads'),
    false);
$$;

REVOKE ALL ON FUNCTION public.leads_require_approval() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.leads_require_approval() TO authenticated;

-- Approval flagging now respects the setting.
CREATE OR REPLACE FUNCTION public.tg_account_needs_approval()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _stage text;
BEGIN
  IF NOT public.leads_require_approval() THEN
    RETURN NEW;
  END IF;

  SELECT ps.name INTO _stage FROM public.pipeline_stages ps WHERE ps.id = NEW.stage_id;

  IF NEW.created_by IS NOT NULL
     AND lower(coalesce(_stage,'')) = 'ready'
     AND NOT public.can_approve_leads(NEW.created_by)
     AND coalesce(NEW.approval_state, 'not_required') = 'not_required' THEN
    NEW.approval_state := 'pending';
    NEW.approval_due_on := (current_date + 7);
  END IF;
  RETURN NEW;
END
$$;

-- Notify: approval request when the gate is on, plain FYI when it is off.
CREATE OR REPLACE FUNCTION public.tg_account_approval_notify()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _rep text;
  _stage text;
BEGIN
  SELECT coalesce(p.full_name, 'A rep') INTO _rep FROM public.profiles p WHERE p.user_id = NEW.created_by;

  IF NEW.approval_state = 'pending' THEN
    PERFORM public.notify_lead_approvers(
      NEW.id,
      'New lead awaiting approval',
      coalesce(_rep, 'A rep') || ' entered ' || coalesce(NEW.name, 'a new lead') || '. Approve within 7 days.');
    RETURN NULL;
  END IF;

  IF NOT public.leads_require_approval() AND NEW.created_by IS NOT NULL THEN
    SELECT ps.name INTO _stage FROM public.pipeline_stages ps WHERE ps.id = NEW.stage_id;
    IF lower(coalesce(_stage,'')) = 'ready' AND NOT public.can_approve_leads(NEW.created_by) THEN
      PERFORM public.notify_lead_approvers(
        NEW.id,
        'New lead created',
        coalesce(_rep, 'A rep') || ' added ' || coalesce(NEW.name, 'a new lead') || '. No approval needed.');
    END IF;
  END IF;

  RETURN NULL;
END
$$;

-- Escalation only runs while the gate is on.
CREATE OR REPLACE FUNCTION public.escalate_overdue_lead_approvals()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _n integer := 0;
  _r record;
BEGIN
  IF NOT public.leads_require_approval() THEN
    RETURN 0;
  END IF;

  FOR _r IN
    UPDATE public.accounts
       SET approval_state = 'escalated'
     WHERE approval_state = 'pending'
       AND approval_due_on IS NOT NULL
       AND approval_due_on < current_date
    RETURNING id, name
  LOOP
    PERFORM public.notify_lead_approvers(
      _r.id,
      'Lead approval overdue',
      coalesce(_r.name, 'A lead') || ' has been awaiting approval for more than 7 days.');
    _n := _n + 1;
  END LOOP;

  RETURN _n;
END
$$;