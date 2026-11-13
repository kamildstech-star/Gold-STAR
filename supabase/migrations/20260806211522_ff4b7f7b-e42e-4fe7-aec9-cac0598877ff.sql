-- ============================================================
-- 1. Staff directory: names public, email managers-only.
--    Postgres has no per-column RLS, so use column privileges.
-- ============================================================
REVOKE SELECT (email) ON public.profiles FROM authenticated;

-- Managers reach emails through this gated SECURITY DEFINER RPC.
CREATE OR REPLACE FUNCTION public.can_read_staff_email(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.is_privileged(_user_id)
      OR public.has_role(_user_id, 'sales_head')
      OR public.has_role(_user_id, 'location_manager')
      OR public.has_role(_user_id, 'regional')
$$;

REVOKE ALL ON FUNCTION public.can_read_staff_email(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_read_staff_email(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_list_users()
RETURNS TABLE(user_id uuid, full_name text, email text, is_active boolean, roles app_role[], location_ids uuid[], location_roles text[], region_ids uuid[])
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.can_read_staff_email(auth.uid()) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  RETURN QUERY
  SELECT
    p.user_id,
    p.full_name,
    p.email,
    p.is_active,
    COALESCE((SELECT array_agg(ur.role ORDER BY ur.role) FROM public.user_roles ur WHERE ur.user_id = p.user_id), ARRAY[]::app_role[]) AS roles,
    COALESCE((SELECT array_agg(lm.location_id) FROM public.location_members lm WHERE lm.user_id = p.user_id), ARRAY[]::uuid[]) AS location_ids,
    COALESCE((SELECT array_agg(lm.role::text) FROM public.location_members lm WHERE lm.user_id = p.user_id), ARRAY[]::text[]) AS location_roles,
    COALESCE((SELECT array_agg(rm.region_id) FROM public.region_members rm WHERE rm.user_id = p.user_id), ARRAY[]::uuid[]) AS region_ids
  FROM public.profiles p
  ORDER BY p.full_name NULLS LAST, p.email;
END
$$;

-- Directory lookup for manager screens outside the admin area.
CREATE OR REPLACE FUNCTION public.staff_emails(_user_ids uuid[])
RETURNS TABLE(user_id uuid, full_name text, email text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.can_read_staff_email(auth.uid()) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  RETURN QUERY
  SELECT p.user_id, p.full_name, p.email
  FROM public.profiles p
  WHERE _user_ids IS NULL OR p.user_id = ANY(_user_ids);
END
$$;

REVOKE ALL ON FUNCTION public.staff_emails(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_emails(uuid[]) TO authenticated;

-- ============================================================
-- 2. Rep-entered leads land in Ready as pending approval.
-- ============================================================
ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS approved_at timestamptz;
ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES public.profiles(user_id) ON DELETE SET NULL;

-- Who must sign off on a rep-entered lead.
CREATE OR REPLACE FUNCTION public.can_approve_leads(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.has_role(_user_id, 'sales_head')
      OR public.has_role(_user_id, 'owner')
      OR public.has_role(_user_id, 'admin')
      OR public.has_role(_user_id, 'dev')
$$;

REVOKE ALL ON FUNCTION public.can_approve_leads(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_approve_leads(uuid) TO authenticated;

-- Notify approvers (sales head / owner / admin) scoped to the account's location.
CREATE OR REPLACE FUNCTION public.notify_lead_approvers(_account_id uuid, _title text, _body text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _loc uuid;
BEGIN
  SELECT location_id INTO _loc FROM public.accounts WHERE id = _account_id;

  INSERT INTO public.notifications (user_id, type, title, body, entity_type, entity_id, href, priority)
  SELECT DISTINCT ur.user_id, 'approval'::notification_type, _title, _body,
         'account', _account_id, '/accounts/' || _account_id::text, 'high'::notification_priority
  FROM public.user_roles ur
  WHERE ur.role IN ('sales_head','owner','admin')
    AND (
      ur.role IN ('owner','admin')
      OR _loc IS NULL
      OR EXISTS (SELECT 1 FROM public.location_members lm
                 WHERE lm.user_id = ur.user_id AND lm.location_id = _loc)
    );
END
$$;

-- On insert into the first prospecting stage by a non-approver, flag for approval.
CREATE OR REPLACE FUNCTION public.tg_account_needs_approval()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _stage text;
  _rep text;
BEGIN
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

DROP TRIGGER IF EXISTS trg_account_needs_approval ON public.accounts;
CREATE TRIGGER trg_account_needs_approval
  BEFORE INSERT ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.tg_account_needs_approval();

CREATE OR REPLACE FUNCTION public.tg_account_approval_notify()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _rep text;
BEGIN
  IF NEW.approval_state = 'pending' THEN
    SELECT coalesce(p.full_name, 'A rep') INTO _rep FROM public.profiles p WHERE p.user_id = NEW.created_by;
    PERFORM public.notify_lead_approvers(
      NEW.id,
      'New lead awaiting approval',
      coalesce(_rep, 'A rep') || ' entered ' || coalesce(NEW.name, 'a new lead') || '. Approve within 7 days.');
  END IF;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS trg_account_approval_notify ON public.accounts;
CREATE TRIGGER trg_account_approval_notify
  AFTER INSERT ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.tg_account_approval_notify();

-- Approval action. A rep cannot approve their own entry.
CREATE OR REPLACE FUNCTION public.approve_account_lead(_account_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _rec public.accounts%ROWTYPE;
BEGIN
  IF NOT public.can_approve_leads(auth.uid()) THEN
    RAISE EXCEPTION 'not authorized to approve leads';
  END IF;

  SELECT * INTO _rec FROM public.accounts WHERE id = _account_id;
  IF _rec.id IS NULL THEN
    RAISE EXCEPTION 'account not found';
  END IF;
  IF NOT public.can_view_location(auth.uid(), _rec.location_id) THEN
    RAISE EXCEPTION 'not authorized for this location';
  END IF;

  UPDATE public.accounts
     SET approval_state = 'approved',
         approved_by = auth.uid(),
         approved_at = now(),
         approval_due_on = NULL
   WHERE id = _account_id;

  IF _rec.created_by IS NOT NULL THEN
    INSERT INTO public.notifications (user_id, type, title, body, entity_type, entity_id, href)
    VALUES (_rec.created_by, 'approval'::notification_type, 'Lead approved',
            coalesce(_rec.name, 'Your lead') || ' has been approved.',
            'account', _account_id, '/accounts/' || _account_id::text);
  END IF;
END
$$;

REVOKE ALL ON FUNCTION public.approve_account_lead(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_account_lead(uuid) TO authenticated;

-- The 7-day clock: overdue approvals escalate rather than sitting silently.
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

REVOKE ALL ON FUNCTION public.escalate_overdue_lead_approvals() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.escalate_overdue_lead_approvals() TO service_role;

SELECT cron.unschedule('escalate-lead-approvals')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'escalate-lead-approvals');

SELECT cron.schedule('escalate-lead-approvals', '10 7 * * *',
  $cron$SELECT public.escalate_overdue_lead_approvals();$cron$);