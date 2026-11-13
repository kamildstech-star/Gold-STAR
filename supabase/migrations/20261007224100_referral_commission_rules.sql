-- A commission rule per referring company and per referring person.
--
-- Mark, 7 Oct: "we want to replace the ledger to be replaced with a card
-- called commissions, it will pull the referring company from general, (in
-- admin we need to be able put the rates for each referral), or use the
-- current commission page in admin settings ... commission amount, which will
-- auto calculate as the charges get added, or a flat fee".
--
-- What already exists, and is kept: the `commission_rates` setting
-- (20260918190000), the named roles and people a job's "Came from" is picked
-- from, each a PERCENTAGE. Those stay the fallback. This table is the new,
-- more specific layer: the company or person on the job's General tab
-- (jobs.referred_by_account_id / referred_by_contact_id) can carry its own
-- deal, as a percentage or as a flat fee per job.
--
-- Why a table and not more entries in the setting: a rule points at a real
-- CRM record (an account or a contact), so it needs a foreign key — a renamed
-- company keeps its deal, a deleted one takes its rule with it — and it needs
-- its own row policy, which a key inside app_settings cannot have.
--
-- The base a percentage is taken of is NOT stored here, on purpose. It is the
-- base the job's commission has always used: the job's revenue as
-- job_running_cost reports it (invoiced, else the approved estimate, else the
-- agreed price, else the newest priced estimate). One base for the role rates
-- and the referrer rules means one number on the job, whichever rule applied.

CREATE TABLE IF NOT EXISTS public.referral_commission_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Exactly one of the two: a deal is with a company OR with a person.
  account_id uuid REFERENCES public.accounts(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES public.contacts(id) ON DELETE CASCADE,
  kind text NOT NULL,
  -- A percentage (0–100) of the job's revenue, or a flat dollar fee per job.
  value numeric(12,2) NOT NULL,
  -- Optional window. Blank on both ends is "always"; a renegotiated deal is a
  -- second row starting the day the first one ends, so older jobs keep the
  -- rate they were brought in under.
  effective_from date,
  effective_to date,
  note text,
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT referral_commission_rule_one_payee
    CHECK ((account_id IS NULL) <> (contact_id IS NULL)),
  CONSTRAINT referral_commission_rule_kind
    CHECK (kind IN ('percent', 'flat')),
  CONSTRAINT referral_commission_rule_value_sane
    CHECK (value >= 0 AND (kind <> 'percent' OR value <= 100)),
  CONSTRAINT referral_commission_rule_window_sane
    CHECK (effective_from IS NULL OR effective_to IS NULL OR effective_from <= effective_to)
);

COMMENT ON TABLE public.referral_commission_rules IS
  'Commission deal with one referring company (account_id) or person (contact_id): a percent of job revenue (job_running_cost) or a flat fee per job. Beats the commission_rates source default; a per-job override beats it.';

CREATE INDEX IF NOT EXISTS referral_commission_rules_account_idx
  ON public.referral_commission_rules (account_id) WHERE account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS referral_commission_rules_contact_idx
  ON public.referral_commission_rules (contact_id) WHERE contact_id IS NOT NULL;

-- One deal at a time per payee. Two rules covering the same day would leave
-- "which one applies" to row order, and a commission is not something to
-- leave to row order. A trigger rather than an exclusion constraint because
-- that needs btree_gist, and one extension for one check is a poor trade.
CREATE OR REPLACE FUNCTION public.tg_referral_commission_rules_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Definer so the overlap check sees every rule for the payee, not only the
  -- ones the writer's policy shows; it reads, it never widens a write.
  IF EXISTS (
    SELECT 1 FROM public.referral_commission_rules r
     WHERE r.id <> NEW.id
       AND r.account_id IS NOT DISTINCT FROM NEW.account_id
       AND r.contact_id IS NOT DISTINCT FROM NEW.contact_id
       AND daterange(COALESCE(r.effective_from, '-infinity'::date),
                     COALESCE(r.effective_to, 'infinity'::date), '[]')
        && daterange(COALESCE(NEW.effective_from, '-infinity'::date),
                     COALESCE(NEW.effective_to, 'infinity'::date), '[]')
  ) THEN
    RAISE EXCEPTION 'This % already has a commission rule for those dates. End the old one first.',
      CASE WHEN NEW.account_id IS NOT NULL THEN 'company' ELSE 'person' END
      USING ERRCODE = '23P01';
  END IF;
  NEW.updated_at := now();
  IF TG_OP = 'UPDATE' THEN
    NEW.updated_by := auth.uid();
    NEW.created_by := OLD.created_by;
    NEW.created_at := OLD.created_at;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.tg_referral_commission_rules_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS referral_commission_rules_guard ON public.referral_commission_rules;
CREATE TRIGGER referral_commission_rules_guard
  BEFORE INSERT OR UPDATE ON public.referral_commission_rules
  FOR EACH ROW EXECUTE FUNCTION public.tg_referral_commission_rules_guard();

-- ---------------------------------------------------------------------------
-- Grants. Supabase's default privileges hand a new table to anon; take
-- everything back and give authenticated only the four verbs RLS then narrows.
-- ---------------------------------------------------------------------------
REVOKE ALL ON public.referral_commission_rules FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.referral_commission_rules TO authenticated;
GRANT ALL ON public.referral_commission_rules TO service_role;

ALTER TABLE public.referral_commission_rules ENABLE ROW LEVEL SECURITY;

-- READ: whoever can see a job's commission today. That is the finance roles
-- (job_running_cost answers only can_view_finance), anyone holding
-- job.view_costs (the Billing tab's money gate) or commission.view (the
-- commission screens), and the admins who write the rules. A rep or crew
-- member without those never sees what a referrer is paid.
DROP POLICY IF EXISTS referral_commission_rules_read ON public.referral_commission_rules;
CREATE POLICY referral_commission_rules_read ON public.referral_commission_rules
  FOR SELECT TO authenticated
  USING (
    public.is_privileged((SELECT auth.uid()))
    OR public.can_view_finance((SELECT auth.uid()))
    OR public.has_permission((SELECT auth.uid()), 'job.view_costs', NULL)
    OR public.has_permission((SELECT auth.uid()), 'commission.view', NULL)
  );

-- WRITE: whoever can edit Settings › Commissions today. That page saves the
-- `commission_rates` setting, and app_settings_write is is_privileged
-- (owner, admin, dev); the rules sit on the same page under the same rule.
DROP POLICY IF EXISTS referral_commission_rules_insert ON public.referral_commission_rules;
CREATE POLICY referral_commission_rules_insert ON public.referral_commission_rules
  FOR INSERT TO authenticated
  WITH CHECK (public.is_privileged((SELECT auth.uid())));
DROP POLICY IF EXISTS referral_commission_rules_update ON public.referral_commission_rules;
CREATE POLICY referral_commission_rules_update ON public.referral_commission_rules
  FOR UPDATE TO authenticated
  USING (public.is_privileged((SELECT auth.uid())))
  WITH CHECK (public.is_privileged((SELECT auth.uid())));
DROP POLICY IF EXISTS referral_commission_rules_delete ON public.referral_commission_rules;
CREATE POLICY referral_commission_rules_delete ON public.referral_commission_rules
  FOR DELETE TO authenticated
  USING (public.is_privileged((SELECT auth.uid())));

-- The restrictive trio every RLS table carries (20260929121000's convention).
DROP POLICY IF EXISTS active_profile_required ON public.referral_commission_rules;
CREATE POLICY active_profile_required ON public.referral_commission_rules
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT goldstar_private.profile_is_active(auth.uid())))
  WITH CHECK ((SELECT goldstar_private.profile_is_active(auth.uid())));
DROP POLICY IF EXISTS anonymous_business_access_denied ON public.referral_commission_rules;
CREATE POLICY anonymous_business_access_denied ON public.referral_commission_rules
  AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'portal_customer') THEN
    DROP POLICY IF EXISTS portal_customer_denied ON public.referral_commission_rules;
    CREATE POLICY portal_customer_denied ON public.referral_commission_rules
      AS RESTRICTIVE FOR ALL TO portal_customer USING (false) WITH CHECK (false);
  END IF;
END $$;
