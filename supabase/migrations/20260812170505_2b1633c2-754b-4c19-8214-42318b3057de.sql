-- Regions ADD locations; they never restrict and they never depend on a role.
-- Previously this returned false unless the user held the 'regional' role, so a
-- region membership silently did nothing for everyone else.
CREATE OR REPLACE FUNCTION public.is_regional_for(_user_id uuid, _location_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT _user_id IS NOT NULL AND _location_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.region_members rm
    JOIN public.location_regions lr ON lr.region_id = rm.region_id
    WHERE rm.user_id = _user_id AND lr.location_id = _location_id
  );
$function$;

-- Manage rights: a direct member needs a managing role, OR the user covers the
-- location through a region. Kept as a union so a region can only ever add.
CREATE OR REPLACE FUNCTION public.can_manage_location(_user_id uuid, _location_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT _location_id IS NOT NULL AND (
    public.is_privileged(_user_id)
    OR (public.is_member_of(_user_id, _location_id)
        AND public.has_any_role_text(_user_id, ARRAY['office','location_manager','sales_manager']))
    OR (public.is_regional_for(_user_id, _location_id)
        AND public.has_any_role_text(_user_id, ARRAY['office','location_manager','sales_manager','regional']))
  );
$function$;