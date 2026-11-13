ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES public.profiles(user_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rejected_reason text;

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_approval_status_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_approval_status_check
  CHECK (approval_status IN ('pending','approved','rejected'));

-- Everyone already in the system predates the gate.
UPDATE public.profiles SET approval_status = 'approved', approved_at = COALESCE(approved_at, created_at)
WHERE approval_status = 'pending';

ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'user_signup';

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_name text;
BEGIN
  v_name := COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name');

  INSERT INTO public.profiles (user_id, email, full_name, approval_status)
  VALUES (NEW.id, NEW.email, v_name, 'pending')
  ON CONFLICT (user_id) DO NOTHING;

  -- Tell every admin/owner a signup is waiting. Never blocks the signup.
  BEGIN
    INSERT INTO public.notifications (user_id, type, title, body, entity_type, entity_id, href, priority)
    SELECT ur.user_id,
           'user_signup'::notification_type,
           'New signup awaiting approval',
           COALESCE(v_name, NEW.email) || ' signed up and needs a role and location.',
           'profile',
           NEW.id,
           '/admin/users',
           'high'::notification_priority
    FROM public.user_roles ur
    WHERE ur.role IN ('admin','owner')
    GROUP BY ur.user_id;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN NEW;
END;
$function$;

DROP FUNCTION IF EXISTS public.admin_list_users();
CREATE FUNCTION public.admin_list_users()
RETURNS TABLE (
  user_id uuid,
  full_name text,
  email text,
  is_active boolean,
  approval_status text,
  roles app_role[],
  location_ids uuid[],
  location_roles text[],
  region_ids uuid[]
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
    p.approval_status,
    COALESCE((SELECT array_agg(ur.role ORDER BY ur.role) FROM public.user_roles ur WHERE ur.user_id = p.user_id), ARRAY[]::app_role[]) AS roles,
    COALESCE((SELECT array_agg(lm.location_id) FROM public.location_members lm WHERE lm.user_id = p.user_id), ARRAY[]::uuid[]) AS location_ids,
    COALESCE((SELECT array_agg(lm.role::text) FROM public.location_members lm WHERE lm.user_id = p.user_id), ARRAY[]::text[]) AS location_roles,
    COALESCE((SELECT array_agg(rm.region_id) FROM public.region_members rm WHERE rm.user_id = p.user_id), ARRAY[]::uuid[]) AS region_ids
  FROM public.profiles p
  ORDER BY (p.approval_status = 'pending') DESC, p.full_name NULLS LAST, p.email;
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_list_users() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_users() TO authenticated;