-- First-come-first-served lead claims must bypass the ordinary account UPDATE
-- policy: an unassigned account cannot yet satisfy `assigned_rep = auth.uid()`.
-- The function substitutes a narrow, authenticated, atomic operation instead
-- of widening account UPDATE rights for every column.

CREATE OR REPLACE FUNCTION public.claim_new_lead(_account_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  claimant uuid := auth.uid();
  claimed_id uuid;
BEGIN
  IF claimant IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '28000';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.user_id = claimant
      AND p.is_active IS TRUE
      AND p.approval_status = 'approved'
  ) THEN
    RAISE EXCEPTION 'active approved profile required' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.user_roles r
    WHERE r.user_id = claimant
      AND r.role::text IN (
        'owner', 'admin', 'dev', 'regional', 'location_manager',
        'sales_head', 'sales_manager', 'sales_person', 'sales_rep',
        'outside_sales_rep', 'cold_caller'
      )
  ) THEN
    RAISE EXCEPTION 'sales role required' USING ERRCODE = '42501';
  END IF;

  UPDATE public.accounts a
     SET assigned_rep = claimant
   WHERE a.id = _account_id
     AND a.status = 'prospect'
     AND a.archived_at IS NULL
     AND a.assigned_rep IS NULL
     AND public.can_view_location(claimant, a.location_id)
  RETURNING a.id INTO claimed_id;

  RETURN claimed_id;
END;
$function$;

ALTER FUNCTION public.claim_new_lead(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.claim_new_lead(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_new_lead(uuid) TO authenticated;

COMMENT ON FUNCTION public.claim_new_lead(uuid) IS
  'Atomically assigns one visible, open, unclaimed prospect to the authenticated sales user.';

NOTIFY pgrst, 'reload schema';
