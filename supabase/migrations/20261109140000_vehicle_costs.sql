-- ---------------------------------------------------------------------------
-- Per-vehicle insurance and finance/lease costs (5 Nov review, T8).
--
-- David: each vehicle in Fleet should store what is paid for its insurance
-- and for its finance or lease — a fixed amount per vehicle, insurance
-- usually by the year, finance by the month. One row per vehicle, beside the
-- paperwork dates (vehicle_due_items) and the maintenance log; the same
-- people see and change it (can_view_vehicle / can_manage_vehicle).
--
-- 20261109150000 (T9) sums these into the overhead engine.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.vehicle_costs (
  vehicle_id uuid PRIMARY KEY REFERENCES public.vehicles(id) ON DELETE CASCADE,
  insurance_amount numeric(12,2) CHECK (insurance_amount IS NULL OR insurance_amount >= 0),
  insurance_period text NOT NULL DEFAULT 'yearly'
    CHECK (insurance_period IN ('monthly', 'yearly')),
  ownership text NOT NULL DEFAULT 'owned'
    CHECK (ownership IN ('owned', 'financed', 'leased')),
  -- The finance or lease payment; ignored while the vehicle is owned.
  finance_amount numeric(12,2) CHECK (finance_amount IS NULL OR finance_amount >= 0),
  finance_period text NOT NULL DEFAULT 'monthly'
    CHECK (finance_period IN ('monthly', 'yearly')),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.vehicle_costs IS
  'What a vehicle costs to insure and to finance or lease, with the period each is paid in (5 Nov, T8). Fed into the overhead engine by fleet_overhead_sync (20261109150000).';

GRANT SELECT, INSERT, UPDATE, DELETE ON public.vehicle_costs TO authenticated;
GRANT ALL ON public.vehicle_costs TO service_role;
ALTER TABLE public.vehicle_costs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS vehicle_costs_select ON public.vehicle_costs;
CREATE POLICY vehicle_costs_select ON public.vehicle_costs
  FOR SELECT TO authenticated
  USING (public.can_view_vehicle((SELECT auth.uid()), vehicle_id));

DROP POLICY IF EXISTS vehicle_costs_write ON public.vehicle_costs;
CREATE POLICY vehicle_costs_write ON public.vehicle_costs
  FOR ALL TO authenticated
  USING (public.can_manage_vehicle((SELECT auth.uid()), vehicle_id))
  WITH CHECK (public.can_manage_vehicle((SELECT auth.uid()), vehicle_id));

DROP POLICY IF EXISTS active_profile_required ON public.vehicle_costs;
CREATE POLICY active_profile_required ON public.vehicle_costs
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT goldstar_private.profile_is_active(auth.uid())))
  WITH CHECK ((SELECT goldstar_private.profile_is_active(auth.uid())));

DROP POLICY IF EXISTS anonymous_business_access_denied ON public.vehicle_costs;
CREATE POLICY anonymous_business_access_denied ON public.vehicle_costs
  AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

DROP TRIGGER IF EXISTS touch_vehicle_costs ON public.vehicle_costs;
CREATE TRIGGER touch_vehicle_costs BEFORE UPDATE ON public.vehicle_costs
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

-- ROLLBACK: DROP TABLE public.vehicle_costs;
