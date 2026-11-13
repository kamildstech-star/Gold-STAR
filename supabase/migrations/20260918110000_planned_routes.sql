-- Routes a rep planned, kept.
--
-- WRITTEN, NOT APPLIED. One new table with RLS and two indexes. Nothing else
-- changes and nothing is dropped. The app works without it: `fetchPlannedRoutes`
-- in src/lib/planned-routes.ts treats a missing table as "no history yet" and
-- the planner hides its Past routes card and Save button.
--
-- Mark, on the Routes page: "also maybe add some past routes so we can see
-- history". Until now a planned route lived in the browser's memory and was
-- gone the moment the rep handed it to Maps; the History tab is visit history
-- (touchpoints), which says where a rep WENT, not what they set out to do.
-- This table is the plan: the stops in the order they were driven, the start
-- and end, when it left, and whether Google put it in order. Set beside the
-- visits logged that day it answers "plan versus what happened".
--
-- A row is written when the rep taps Open in Maps (the moment a route is
-- driven) or Save route. The stops are a jsonb snapshot -- name, address,
-- pin -- so a route still reads after an account is renamed or deleted; the
-- ids are there for reloading it into the planner.
--
-- `planned_for` is a plain date in the rep's own calendar, set from the
-- departure they chose; it is compared against "2026-09-17"-style day keys in
-- code, so it must never become a timestamp.

CREATE TABLE IF NOT EXISTS public.planned_routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by uuid NOT NULL DEFAULT auth.uid(),
  location_id uuid REFERENCES public.locations(id) ON DELETE SET NULL,
  planned_for date NOT NULL,
  departure_at timestamptz,
  name text NOT NULL,
  -- {kind:'current'|'office'|'address', label, lat, lon}
  start_point jsonb NOT NULL,
  -- the same shape, or {kind:'last-stop'}
  end_point jsonb NOT NULL,
  -- [{account_id | job_id, kind, name, address, lat, lon, leg_minutes}], in driven order
  stops jsonb NOT NULL DEFAULT '[]'::jsonb,
  optimised boolean NOT NULL DEFAULT false,
  total_minutes integer,
  total_km numeric(8,2),
  opened_in_maps_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS planned_routes_by_rep
  ON public.planned_routes (created_by, planned_for DESC);
CREATE INDEX IF NOT EXISTS planned_routes_by_office
  ON public.planned_routes (location_id, planned_for DESC);

ALTER TABLE public.planned_routes ENABLE ROW LEVEL SECURITY;

-- The rep sees their own. A manager of the office sees the office's, the same
-- audience the Routes page already lets pick another rep's book: privileged,
-- regional, the office's location/sales manager (can_manage_location), and
-- the Sales Head. A plain rep in the same office does not see a colleague's
-- plans -- that is why this is can_manage_location and not can_view_location.
CREATE POLICY "planned_routes_read" ON public.planned_routes
  FOR SELECT TO authenticated
  USING (
    created_by = auth.uid()
    OR public.can_manage_location(auth.uid(), location_id)
    OR public.has_role(auth.uid(), 'sales_head')
  );

-- Only ever written as yourself.
CREATE POLICY "planned_routes_insert" ON public.planned_routes
  FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid());

CREATE POLICY "planned_routes_update" ON public.planned_routes
  FOR UPDATE TO authenticated
  USING (created_by = auth.uid())
  WITH CHECK (created_by = auth.uid());

CREATE POLICY "planned_routes_delete" ON public.planned_routes
  FOR DELETE TO authenticated
  USING (created_by = auth.uid());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.planned_routes TO authenticated;
GRANT ALL ON public.planned_routes TO service_role;
