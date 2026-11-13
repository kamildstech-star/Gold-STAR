-- Column privileges only bite once the table-wide SELECT is removed.
REVOKE SELECT ON public.profiles FROM authenticated, anon;

GRANT SELECT (
  user_id, full_name, created_at, updated_at,
  is_active, deactivated_at, deactivated_by, language, is_demo
) ON public.profiles TO authenticated;

GRANT ALL ON public.profiles TO service_role;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'notification_type' AND e.enumlabel = 'lead_approval'
  ) THEN
    ALTER TYPE public.notification_type ADD VALUE 'lead_approval';
  END IF;
END
$$;