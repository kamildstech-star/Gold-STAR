CREATE OR REPLACE FUNCTION public.can_create_job(_user_id uuid, _location_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT _location_id IS NOT NULL AND (
    public.is_privileged(_user_id)
    OR (
      public.can_view_location(_user_id, _location_id)
      AND public.has_any_role_text(_user_id, ARRAY[
        'office','location_manager','sales_manager','regional','sales_head',
        'sales_rep','sales_person','outside_sales_rep','field_chaser'
      ])
    )
  );
$function$;

REVOKE EXECUTE ON FUNCTION public.can_create_job(uuid, uuid) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_create_job(uuid, uuid) TO authenticated;

DROP POLICY IF EXISTS jobs_insert ON public.jobs;
CREATE POLICY jobs_insert ON public.jobs
FOR INSERT TO authenticated
WITH CHECK (public.can_create_job((SELECT auth.uid()), location_id));