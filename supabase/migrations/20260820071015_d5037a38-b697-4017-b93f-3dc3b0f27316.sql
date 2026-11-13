-- 1. One-shot "locations I can see" set. Evaluated once per query as an InitPlan
-- instead of calling can_view_location() per row.
CREATE OR REPLACE FUNCTION public.my_visible_location_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
PARALLEL SAFE
SET search_path TO 'public'
AS $$
  SELECT l.id FROM public.locations l
  WHERE public.is_privileged((SELECT auth.uid()))
  UNION
  SELECT lm.location_id FROM public.location_members lm
  WHERE lm.user_id = (SELECT auth.uid())
  UNION
  SELECT lr.location_id
  FROM public.region_members rm
  JOIN public.location_regions lr ON lr.region_id = rm.region_id
  WHERE rm.user_id = (SELECT auth.uid());
$$;

GRANT EXECUTE ON FUNCTION public.my_visible_location_ids() TO authenticated;
REVOKE EXECUTE ON FUNCTION public.my_visible_location_ids() FROM anon, PUBLIC;

-- 2. Mark the hot RLS helpers parallel safe so large scans can use parallel workers.
ALTER FUNCTION public.is_privileged(uuid) PARALLEL SAFE;
ALTER FUNCTION public.is_member_of(uuid, uuid) PARALLEL SAFE;
ALTER FUNCTION public.is_regional_for(uuid, uuid) PARALLEL SAFE;
ALTER FUNCTION public.can_view_location(uuid, uuid) PARALLEL SAFE;
ALTER FUNCTION public.can_manage_location(uuid, uuid) PARALLEL SAFE;
ALTER FUNCTION public.has_role(uuid, public.app_role) PARALLEL SAFE;
ALTER FUNCTION public.has_role_text(uuid, text) PARALLEL SAFE;
ALTER FUNCTION public.is_conversation_member(uuid, uuid) PARALLEL SAFE;
ALTER FUNCTION public.incident_market_allowed(uuid, uuid) PARALLEL SAFE;
ALTER FUNCTION public.is_lead_visible_to_field(uuid, uuid) PARALLEL SAFE;

-- 3. fire_leads: same rules, evaluated once instead of per row.
DROP POLICY IF EXISTS fire_leads_select ON public.fire_leads;
CREATE POLICY fire_leads_select ON public.fire_leads
FOR SELECT TO authenticated
USING (
  assigned_rep = (SELECT auth.uid())
  OR location_id IN (SELECT public.my_visible_location_ids())
  OR (
    (SELECT public.has_role_text((SELECT auth.uid()), 'field_chaser'))
    AND public.is_lead_visible_to_field((SELECT auth.uid()), id)
  )
);

DROP POLICY IF EXISTS fire_leads_update ON public.fire_leads;
CREATE POLICY fire_leads_update ON public.fire_leads
FOR UPDATE TO authenticated
USING (
  assigned_rep = (SELECT auth.uid())
  OR public.can_manage_location((SELECT auth.uid()), location_id)
);

-- 4. jobs: replace per-row can_view_location / is_privileged with the cached set.
DROP POLICY IF EXISTS jobs_select ON public.jobs;
CREATE POLICY jobs_select ON public.jobs
FOR SELECT TO authenticated
USING (
  created_by = (SELECT auth.uid())
  OR crew_chief = (SELECT auth.uid())
  OR (SELECT public.is_privileged((SELECT auth.uid())))
  OR location_id IN (SELECT public.my_visible_location_ids())
  OR EXISTS (
    SELECT 1 FROM public.job_assignments ja
    WHERE ja.job_id = jobs.id AND ja.user_id = (SELECT auth.uid())
  )
);

-- 5. incidents: market check and privilege check are user-level, so hoist them.
DROP POLICY IF EXISTS incidents_select ON public.incidents;
CREATE POLICY incidents_select ON public.incidents
FOR SELECT TO authenticated
USING (
  (SELECT public.is_privileged((SELECT auth.uid())))
  OR (
    public.incident_market_allowed((SELECT auth.uid()), market_id)
    AND (
      accepted_by = (SELECT auth.uid())
      OR created_by = (SELECT auth.uid())
      OR location_id IN (SELECT public.my_visible_location_ids())
    )
  )
);

-- 6. Supporting indexes for the lookups these policies and hot lists perform.
CREATE INDEX IF NOT EXISTS job_assignments_user_job_idx ON public.job_assignments (user_id, job_id);
CREATE INDEX IF NOT EXISTS conversation_members_user_conv_idx ON public.conversation_members (user_id, conversation_id);
CREATE INDEX IF NOT EXISTS region_members_user_idx ON public.region_members (user_id);
CREATE INDEX IF NOT EXISTS location_regions_region_idx ON public.location_regions (region_id, location_id);
CREATE INDEX IF NOT EXISTS user_roles_user_idx ON public.user_roles (user_id);
CREATE INDEX IF NOT EXISTS chaser_territories_user_idx ON public.chaser_territories (user_id);
CREATE INDEX IF NOT EXISTS incidents_status_reported_idx ON public.incidents (status, reported_at DESC);
CREATE INDEX IF NOT EXISTS fire_leads_source_first_seen_idx ON public.fire_leads (source_first_seen_at DESC) WHERE archived_at IS NULL;

ANALYZE public.fire_leads;
ANALYZE public.incidents;
ANALYZE public.jobs;