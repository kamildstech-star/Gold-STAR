-- Put the Job Calculator's cost snapshot behind the database, not behind a page.
--
-- THE FINDING (QC, 2026-09-09): with View As -> Sales Person the Job
-- Calculator still showed Internal Cost and Overall Profit. The screen-side
-- cause was `useCan` answering for the actor rather than the previewed role
-- (fixed in src/lib/permissions.ts). Checking the data behind the screen
-- while there: every saved calculation stores its internal_cost,
-- equipment_profit and overall_profit, and public.job_calculations carried a
-- table-wide SELECT grant for `authenticated` with a row policy of
-- can_view_location OR created_by. So a sales person could read the
-- company's cost and margin on every saved estimate at their office with one
-- PostgREST call, whatever the screen hid. The calculator's rate constants
-- themselves live in application code (src/lib/job-calculator.ts), not in
-- any table — there is no rate table to withhold; this migration is about
-- the stored figures.
--
-- THE DESIGN, the same shape as 20260909100000_line_cost_policy:
--
--   1. REVOKE the table-wide SELECT from `authenticated` (and `anon`) and
--      GRANT SELECT on every column EXCEPT the three cost columns back to
--      `authenticated`. Row visibility is unchanged; only the columns are
--      withheld. customer_price stays readable: it is the quote.
--   2. Expose the three columns only through job_calculation_costs(_id): a
--      SECURITY DEFINER reader that answers solely for holders of
--      `job.view_costs` at the calculation's location — the capability the
--      UI gates the same figures on — and only for a row the caller could
--      see through the row policy anyway. Empty set, never an error, for
--      everyone else.
--
-- Not touched: INSERT / UPDATE / DELETE grants (the client still writes the
-- snapshot on save so rows stay auditable when the constants move; writing
-- a cost is not a leak, and the row policies still govern who may write),
-- the row policies themselves, service_role.
--
-- HAZARD — `select("*")` NOW FAILS on job_calculations: Postgres answers a
-- query touching an ungranted column with "permission denied for table
-- job_calculations". Every client reader selects JOB_CALCULATION_SELECT
-- (src/lib/job-calculations.ts), including the `.select()` after insert and
-- update, and a test pins that list to the GRANT below. EVERY future
-- migration that adds a column to this table must GRANT SELECT on it
-- explicitly; there is no table-level grant to inherit.
--
-- Re-runnable: REVOKE/GRANT are idempotent, CREATE OR REPLACE throughout.
-- Nothing is dropped, RLS stays enabled.

-- ---------------------------------------------------------------------------
-- 1. Column-level SELECT: everything but the cost snapshot.
-- ---------------------------------------------------------------------------
REVOKE SELECT ON public.job_calculations FROM authenticated;
REVOKE SELECT ON public.job_calculations FROM anon;

-- Keep this list in step with JOB_CALCULATION_PUBLIC_COLUMNS in
-- src/lib/job-calculations.ts.
GRANT SELECT (
  id,
  location_id,
  job_id,
  job_date,
  customer_name,
  contact_number,
  email,
  address,
  address_line2,
  locality,
  region,
  postal_code,
  job_type,
  days,
  workers,
  regular_hours,
  after_hours,
  emergency,
  garbage_fee,
  miscellaneous_fee,
  equipment_quantities,
  customer_price,
  created_by,
  created_at,
  updated_at
) ON public.job_calculations TO authenticated;

COMMENT ON COLUMN public.job_calculations.internal_cost IS
  'What the job costs Gold Star, as snapshotted on save. NOT readable by the authenticated role: read it via job_calculation_costs(_calculation_id). Naming this column in a client SELECT (including select *) fails with "permission denied for table job_calculations".';
COMMENT ON COLUMN public.job_calculations.equipment_profit IS
  'Equipment margin snapshotted on save. NOT readable by the authenticated role: read it via job_calculation_costs(_calculation_id).';
COMMENT ON COLUMN public.job_calculations.overall_profit IS
  'Overall margin snapshotted on save. NOT readable by the authenticated role: read it via job_calculation_costs(_calculation_id).';

-- ---------------------------------------------------------------------------
-- 2. The snapshot, for the people allowed to see cost, on rows they can see.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.job_calculation_costs(_calculation_id uuid)
RETURNS TABLE (
  calculation_id uuid,
  internal_cost numeric,
  equipment_profit numeric,
  overall_profit numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.id, c.internal_cost, c.equipment_profit, c.overall_profit
  FROM public.job_calculations c
  WHERE c.id = _calculation_id
    AND (public.can_view_location(auth.uid(), c.location_id) OR c.created_by = auth.uid())
    AND public.has_permission(auth.uid(), 'job.view_costs', c.location_id);
$$;

COMMENT ON FUNCTION public.job_calculation_costs(uuid) IS
  'Stored cost snapshot (internal_cost, equipment_profit, overall_profit) of one job calculation, only for callers holding job.view_costs at its location who can see the row; empty set for everyone else. The columns themselves are not SELECT-granted to authenticated — see 20260909110000_calculator_cost_visibility.sql.';

-- SECURITY DEFINER functions are executable by PUBLIC by default, and
-- Supabase's default privileges hand `anon` an explicit EXECUTE at CREATE
-- time that the PUBLIC revoke does not touch. Revoke both, grant only what
-- the app uses.
REVOKE ALL ON FUNCTION public.job_calculation_costs(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.job_calculation_costs(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.job_calculation_costs(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.job_calculation_costs(uuid) TO service_role;
