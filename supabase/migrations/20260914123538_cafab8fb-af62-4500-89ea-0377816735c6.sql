-- A rep can move their own account to another office, and approve their own
-- lead. This closes both, and pins the column that is only safe by accident.
--
-- WRITTEN, NOT APPLIED. One trigger function and one trigger binding. No
-- table, column, policy, grant or ownership change, and nothing is dropped.

CREATE OR REPLACE FUNCTION public.guard_account_owner_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  actor uuid := auth.uid();
  changed text[] := '{}';
BEGIN
  -- Backend work: cron sweeps, the Graph sync, the automation engine. They run
  -- as service_role with no JWT and already bypass RLS entirely.
  IF actor IS NULL THEN
    RETURN NEW;
  END IF;

  -- Anyone the app already trusts with these writes keeps full update rights.
  IF public.is_privileged(actor)
     OR public.can_manage_location(actor, OLD.location_id)
     OR public.is_sales_lead(actor) THEN
    RETURN NEW;
  END IF;

  IF NEW.assigned_rep IS DISTINCT FROM OLD.assigned_rep THEN
    changed := changed || 'assigned_rep'::text;
  END IF;
  IF NEW.location_id IS DISTINCT FROM OLD.location_id THEN
    changed := changed || 'location_id'::text;
  END IF;
  IF NEW.approval_state IS DISTINCT FROM OLD.approval_state THEN
    changed := changed || 'approval_state'::text;
  END IF;
  IF NEW.approved_by IS DISTINCT FROM OLD.approved_by THEN
    changed := changed || 'approved_by'::text;
  END IF;
  IF NEW.approved_at IS DISTINCT FROM OLD.approved_at THEN
    changed := changed || 'approved_at'::text;
  END IF;
  IF NEW.approval_due_on IS DISTINCT FROM OLD.approval_due_on THEN
    changed := changed || 'approval_due_on'::text;
  END IF;

  IF cardinality(changed) > 0 THEN
    RAISE EXCEPTION
      'Only a manager can change % on an account. Ask the office manager to reassign or approve it.',
      array_to_string(changed, ', ')
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.guard_account_owner_columns() IS
  'BEFORE UPDATE on public.accounts: refuses changes to assigned_rep, location_id and the four approval columns unless the caller is privileged, manages the account''s office, or is a sales lead. RLS decides which rows may be updated; this decides which columns. See 20260914110000.';

REVOKE EXECUTE ON FUNCTION public.guard_account_owner_columns()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS guard_account_owner_columns ON public.accounts;
CREATE TRIGGER guard_account_owner_columns
BEFORE UPDATE ON public.accounts
FOR EACH ROW EXECUTE FUNCTION public.guard_account_owner_columns();