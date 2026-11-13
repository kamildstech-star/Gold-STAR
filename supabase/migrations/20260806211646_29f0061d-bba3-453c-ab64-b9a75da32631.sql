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
  SELECT DISTINCT ur.user_id, 'lead_approval'::notification_type, _title, _body,
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
    VALUES (_rec.created_by, 'lead_approval'::notification_type, 'Lead approved',
            coalesce(_rec.name, 'Your lead') || ' has been approved.',
            'account', _account_id, '/accounts/' || _account_id::text);
  END IF;
END
$$;