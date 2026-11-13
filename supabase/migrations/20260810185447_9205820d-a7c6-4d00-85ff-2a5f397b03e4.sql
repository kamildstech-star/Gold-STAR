-- Wrap auth.uid() in a scalar subquery so Postgres evaluates it once per
-- statement (initplan) instead of once per row. On ~4,700 fire_leads rows the
-- per-row form was costing ~1.5s per list load.
DROP POLICY IF EXISTS fire_leads_select ON public.fire_leads;
CREATE POLICY fire_leads_select ON public.fire_leads
  FOR SELECT TO authenticated
  USING (
    public.can_view_location((select auth.uid()), location_id)
    OR assigned_rep = (select auth.uid())
    OR (
      public.has_role_text((select auth.uid()), 'field_chaser')
      AND public.is_lead_visible_to_field((select auth.uid()), id)
    )
  );

DROP POLICY IF EXISTS fire_leads_update ON public.fire_leads;
CREATE POLICY fire_leads_update ON public.fire_leads
  FOR UPDATE TO authenticated
  USING (
    public.can_manage_location((select auth.uid()), location_id)
    OR assigned_rep = (select auth.uid())
  );

DROP POLICY IF EXISTS fire_leads_admin_all ON public.fire_leads;
CREATE POLICY fire_leads_admin_all ON public.fire_leads
  FOR ALL TO authenticated
  USING (public.is_privileged((select auth.uid())))
  WITH CHECK (public.is_privileged((select auth.uid())));

CREATE INDEX IF NOT EXISTS fire_leads_location_idx ON public.fire_leads (location_id);
CREATE INDEX IF NOT EXISTS fire_leads_assigned_rep_idx ON public.fire_leads (assigned_rep);
CREATE INDEX IF NOT EXISTS fire_leads_status_incident_idx ON public.fire_leads (status, incident_date DESC);
CREATE INDEX IF NOT EXISTS fire_leads_created_at_idx ON public.fire_leads (created_at DESC);
CREATE INDEX IF NOT EXISTS fire_leads_incident_date_idx ON public.fire_leads (incident_date);
CREATE INDEX IF NOT EXISTS fire_leads_active_idx ON public.fire_leads (created_at DESC) WHERE archived_at IS NULL;

ANALYZE public.fire_leads;