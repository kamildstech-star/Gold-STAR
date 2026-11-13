-- Intake office rules: "this state (or ZIP prefix) belongs to that office".
--
-- Mark, on Settings › Sales › Territory: "add in here a address match for
-- intake, that will set certain states to certain offices that overrides the
-- closest match".
--
-- A general intake link (the website button, everyone's standing link) is
-- routed by the property's address (20260903223000): the closest office in
-- the property's state, else the closest office anywhere. Pennsylvania has no
-- office, so a Scranton lead goes to whichever office is nearest on the map —
-- NY-Upstate — whoever actually covers PA. A rule says who does.
--
-- Precedence (the code is matchLocationForAddress in src/lib/intake-routing.ts;
-- the routing itself stays in TypeScript, where the public submit and the
-- inbox re-match share one implementation):
--   1. a person's choice on the intake card (a later migration) — never moved;
--   2. a ZIP-prefix rule, longest prefix first — narrower than a state;
--   3. a state rule;
--   4. the address: nearest office (in-state first), town, state, the default
--      office, nothing.
--
-- This file adds:
--   1. intake_office_rules — read by anyone signed in (the inbox reads them to
--      re-route waiting forms, and they name nothing private), written only by
--      whoever can edit Territory today: is_privileged, the same predicate as
--      markets_manage / zones_manage.
--   2. intake_submissions.location_route_reason / location_route_detail — WHY
--      the address put the form where it is, so the inbox badge can say "from
--      state rule (PA)" instead of a bare "from address".
--
-- Not applied by the agent that wrote it. Safe to re-run. Until it is applied
-- the Territory page says the rules are not live, new forms route exactly as
-- before, and the badge keeps saying "from address".

-- ---------------------------------------------------------------------------
-- 1. The rules
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.intake_office_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_kind text NOT NULL CHECK (match_kind IN ('state', 'zip')),
  match_value text NOT NULL,
  -- Deleting an office takes its rules with it; the address then decides.
  location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- A state is its two-letter code; a ZIP prefix is three to five digits.
  CONSTRAINT intake_office_rules_value_shape CHECK (
    (match_kind = 'state' AND match_value ~ '^[A-Z]{2}$')
    OR (match_kind = 'zip' AND match_value ~ '^[0-9]{3,5}$')
  ),
  -- One office per state, one per prefix: two rules for PA would make the
  -- answer depend on row order.
  CONSTRAINT intake_office_rules_one_per_value UNIQUE (match_kind, match_value)
);

CREATE INDEX IF NOT EXISTS intake_office_rules_location_idx
  ON public.intake_office_rules(location_id);

ALTER TABLE public.intake_office_rules ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.intake_office_rules FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.intake_office_rules TO authenticated;
GRANT ALL ON public.intake_office_rules TO service_role;

DROP POLICY IF EXISTS intake_office_rules_select ON public.intake_office_rules;
CREATE POLICY intake_office_rules_select ON public.intake_office_rules
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS intake_office_rules_manage ON public.intake_office_rules;
CREATE POLICY intake_office_rules_manage ON public.intake_office_rules
  FOR ALL TO authenticated
  USING (public.is_privileged((SELECT auth.uid())))
  WITH CHECK (public.is_privileged((SELECT auth.uid())));

-- Closed to client-portal customers, like every RLS table (see
-- supabase/tests/client-portal-live-audit.sql).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'portal_customer') THEN
    DROP POLICY IF EXISTS portal_customer_denied ON public.intake_office_rules;
    CREATE POLICY portal_customer_denied ON public.intake_office_rules
      AS RESTRICTIVE FOR ALL TO portal_customer USING (false) WITH CHECK (false);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Why the address put a form where it is
-- ---------------------------------------------------------------------------
ALTER TABLE public.intake_submissions
  ADD COLUMN IF NOT EXISTS location_route_reason text,
  ADD COLUMN IF NOT EXISTS location_route_detail text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'intake_submissions_location_route_reason_check'
       AND conrelid = 'public.intake_submissions'::regclass
  ) THEN
    ALTER TABLE public.intake_submissions
      ADD CONSTRAINT intake_submissions_location_route_reason_check
      CHECK (location_route_reason IS NULL OR location_route_reason IN (
        'zip_rule', 'state_rule', 'nearest', 'locality', 'state', 'fallback', 'none'
      ));
  END IF;
END $$;
