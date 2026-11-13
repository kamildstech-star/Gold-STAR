-- TM1 (27 Oct 2026): every T&M rate code carries a CLIENT rate and a COST rate.
--
-- WRITTEN, NOT APPLIED. Run by hand after 20261026140000_tm_rate_code_rates.sql
-- (adds `rate`) and 20261027130000_seller_billing_not_costs.sql (adds
-- can_view_job_costs / job.view_billing, used by the next migration).
--
--   rate        what the code BILLS the customer at (already there).
--   cost_rate   what it COSTS Gold Star, fully loaded — labor including
--               overhead, distinct from a person's base pay (labour_rates).
--               NULL = not entered yet; the job-costing view says "enter cost".
--   unit        hr / day / each / pct / person_day — how `rate` and
--               `cost_rate` are read.
--   small_tools whether a labor code's hours carry the Small Tools fee.
--
-- Seeded from David's sample "Lallypak Week 1" (T&M Pro workbook + Daily
-- Supply List): the supply and equipment prices it bills, and EO, the one
-- title it bills that the catalogue lacked. Only where nothing is set, so a
-- rate typed in Settings is never overwritten by a re-run. No cost rate is
-- known from the sample: every cost_rate starts NULL.
--
-- cost_rate is INTERNAL. Everyone signed in reads the catalogue (the sign-in
-- sheet and the supply list need the codes), so the column is withheld from
-- `authenticated` by column grants and read through tm_rate_code_costs(),
-- which answers only finance or job.view_costs holders. The same pattern as
-- estimate_catalog_items.default_cost (20260909090000).

ALTER TABLE public.tm_rate_codes
  ADD COLUMN IF NOT EXISTS cost_rate numeric(10,2),
  ADD COLUMN IF NOT EXISTS unit text,
  ADD COLUMN IF NOT EXISTS small_tools boolean NOT NULL DEFAULT true;

DO $$ BEGIN
  ALTER TABLE public.tm_rate_codes
    ADD CONSTRAINT tm_rate_codes_cost_rate_nonnegative CHECK (cost_rate IS NULL OR cost_rate >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.tm_rate_codes
    ADD CONSTRAINT tm_rate_codes_unit_known
    CHECK (unit IS NULL OR unit IN ('hr', 'day', 'each', 'pct', 'person_day'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN public.tm_rate_codes.cost_rate IS
  'Internal fully-loaded cost per unit (labor includes overhead). NULL = not entered. Never on a customer document; read via tm_rate_code_costs().';
COMMENT ON COLUMN public.tm_rate_codes.unit IS
  'hr | day | each | pct | person_day — how rate and cost_rate are read.';
COMMENT ON COLUMN public.tm_rate_codes.small_tools IS
  'Labor codes: whether the Small Tools fee is charged on this title''s labor.';

-- The title the sample bills that the catalogue did not have.
INSERT INTO public.tm_rate_codes (code, section, label, sort_order)
VALUES ('EO', 'labor', 'Equipment Operator', 95)
ON CONFLICT (code) DO NOTHING;

-- Units by section; the general charges by what they are.
UPDATE public.tm_rate_codes SET unit = 'hr'   WHERE unit IS NULL AND section = 'labor';
UPDATE public.tm_rate_codes SET unit = 'each' WHERE unit IS NULL AND section IN ('consumable', 'ppe');
UPDATE public.tm_rate_codes SET unit = 'day'  WHERE unit IS NULL AND section IN ('equipment', 'vehicle');
UPDATE public.tm_rate_codes SET unit = 'pct'  WHERE unit IS NULL AND code IN ('GEN-SMALLTOOLS', 'GEN-OP');
UPDATE public.tm_rate_codes SET unit = 'person_day' WHERE unit IS NULL AND code = 'GEN-PERDIEM';
UPDATE public.tm_rate_codes SET unit = 'each' WHERE unit IS NULL;

-- In the sample, management titles carry no Small Tools fee: Project
-- Consultant (PCT), Project Estimator (PE) and Sr. Project Manager (SPM) are
-- at $0 on every day but one SPM day. Field titles are at 3%.
UPDATE public.tm_rate_codes SET small_tools = false
 WHERE code IN ('PCT', 'PE', 'SPM', 'PM', 'APM', 'CE', 'PCR');

-- What the sample bills, by code.
UPDATE public.tm_rate_codes AS t
   SET rate = s.rate
  FROM (VALUES
    ('EO', 97.00),
    ('104', 150.00),  -- 6 Mil Poly, per roll
    ('106', 108.48),  -- HEPA filter (for HEPA vac)
    ('122', 63.72),   -- Cleaning Rags, box of 100
    ('142', 47.60),   -- Contractor trash bags, box of 50
    ('146', 15.94),   -- Super 77 Spray Adhesive
    ('148', 11.49),   -- Duct tape
    ('150', 12.69),   -- Painter's tape
    ('153', 100.00),  -- UnSmoke Degreaser, per gal
    ('200', 5.95),    -- Face Mask, per pair
    ('203', 38.00),   -- Fall protection harness, per day
    ('205', 19.44),   -- Nitrile Gloves, per box
    ('207', 0.47),    -- Disposable gloves, per pair
    ('329', 48.50),   -- HEPA Vacuum, per day
    ('401', 150.00),  -- Cargo Van, per day
    ('405', 102.60),  -- Personal Company Vehicle, per day
    ('GEN-PERDIEM', 45.00),
    ('GEN-OP', 20.00)
  ) AS s(code, rate)
 WHERE t.code = s.code
   AND t.rate IS NULL;

-- cost_rate: not readable by a plain signed-in user ----------------------
REVOKE SELECT ON public.tm_rate_codes FROM authenticated, anon;
GRANT SELECT (code, label, section, unit_note, sort_order, active, created_at, updated_at,
              updated_by, rate, unit, small_tools)
  ON public.tm_rate_codes TO authenticated;

CREATE OR REPLACE FUNCTION public.tm_rate_code_costs()
RETURNS TABLE (code text, cost_rate numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT t.code, t.cost_rate
    FROM public.tm_rate_codes t
   WHERE public.can_view_finance(auth.uid())
      OR public.has_permission(auth.uid(), 'job.view_costs', NULL);
$$;
REVOKE ALL ON FUNCTION public.tm_rate_code_costs() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tm_rate_code_costs() TO authenticated, service_role;

-- Writing a cost rate: the catalogue's own editors (is_privileged), through
-- the existing update policy; the column UPDATE grant is unchanged.
