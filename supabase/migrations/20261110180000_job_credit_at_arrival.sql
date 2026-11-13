-- Commission by account stage at job arrival (phase 4 of the health model).
--
-- Melly, GSR Edits, "Commission":
--
--   "A job that comes in attached to a rep pays that rep, based on where the
--    account was sitting when the job arrived. If the account was in Ready or
--    Active Outreach, the manager approves or declines. If it was in
--    Conversation Established or already a client, it pays automatically.
--
--    This holds even if the rep had nothing to do with the actual job. If a
--    rep courted a property manager for a year and the first call comes in at
--    two in the morning and dispatch handles the whole thing, the rep gets
--    paid. The relationship produced the job.
--
--    Credit locks the day the job is signed. Losing an account only affects
--    future jobs. There is never a clawback, which means the engineers do not
--    have to build reversal logic anywhere."
--
-- WHAT CHANGES. The engine (compute_job_commissions, 20260820084452) paid the
-- job's account-rep assignment, else whoever created the job — dispatch, on
-- that two-in-the-morning call. It now pays the rep the ACCOUNT was assigned
-- to when the job arrived, snapshotted onto the job by a trigger the moment
-- the job is inserted (or first linked to an account) and never rewritten:
-- reassigning the account later changes nothing on jobs already signed.
--
-- The stage is snapshotted beside the rep and decides the payout's starting
-- status: Conversation Established or an active client auto-approves; Ready,
-- Active Outreach and anything else waits for the manager's approve/decline
-- on the payouts screen, as every payout did before this migration.
--
-- Jobs that predate this migration carry no snapshot and are paid exactly as
-- before. No backfill: guessing who owned an account a year ago from today's
-- assignment is the clawback-in-reverse the spec forbids.

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS credit_rep_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS credit_stage_key text,
  ADD COLUMN IF NOT EXISTS credit_requires_approval boolean,
  ADD COLUMN IF NOT EXISTS credit_locked_at timestamptz;

COMMENT ON COLUMN public.jobs.credit_rep_id IS
  'The rep the account was assigned to when the job arrived. Locked at arrival; the commission engine pays this person. Melly: "Credit locks the day the job is signed."';
COMMENT ON COLUMN public.jobs.credit_stage_key IS
  'Pipeline stage key of the account when the job arrived (ready, active_outreach, conversation_established, active_client, ...).';
COMMENT ON COLUMN public.jobs.credit_requires_approval IS
  'True when the account was in Ready or Active Outreach (or no further) at arrival: the manager approves or declines the payout. False pays automatically.';

CREATE INDEX IF NOT EXISTS jobs_credit_rep_idx
  ON public.jobs (credit_rep_id) WHERE credit_rep_id IS NOT NULL;

-- ------------------------------------------------------------ the snapshot

-- The account's rep and stage right now, as a job arriving this second would
-- see them. "Already a client" is the Active Clients board's own rule: an
-- active/onboarding status, a health stage, or a won pipeline stage.
CREATE OR REPLACE FUNCTION public.job_credit_snapshot(_account_id uuid)
RETURNS TABLE(rep uuid, stage_key text, requires_approval boolean)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH a AS (
    SELECT acc.assigned_rep, acc.status, acc.health_stage_id, acc.stage,
           s.key AS pipeline_key
      FROM public.accounts acc
      LEFT JOIN public.pipeline_stages s ON s.id = acc.stage_id
     WHERE acc.id = _account_id
  ),
  k AS (
    SELECT a.assigned_rep,
           CASE
             WHEN a.status IN ('active', 'onboarding')
                  OR a.health_stage_id IS NOT NULL
                  OR COALESCE(a.pipeline_key, a.stage) IN ('active_client', 'won')
               THEN 'active_client'
             ELSE COALESCE(a.pipeline_key, NULLIF(a.stage, ''), 'ready')
           END AS stage_key
      FROM a
  )
  SELECT k.assigned_rep,
         k.stage_key,
         k.stage_key NOT IN ('conversation_established', 'active_client')
    FROM k;
$$;
REVOKE ALL ON FUNCTION public.job_credit_snapshot(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.job_credit_snapshot(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.tg_jobs_credit_lock()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  snap record;
BEGIN
  -- Locked: nothing moves the credit after the day it was set.
  IF TG_OP = 'UPDATE' AND OLD.credit_locked_at IS NOT NULL THEN
    NEW.credit_rep_id := OLD.credit_rep_id;
    NEW.credit_stage_key := OLD.credit_stage_key;
    NEW.credit_requires_approval := OLD.credit_requires_approval;
    NEW.credit_locked_at := OLD.credit_locked_at;
    RETURN NEW;
  END IF;

  IF NEW.account_id IS NULL THEN RETURN NEW; END IF;
  -- Unlocked and already on this account (nobody was assigned when it
  -- arrived): a plain re-save is not the job arriving again. Only a job
  -- being LINKED to an account takes the snapshot after insert.
  IF TG_OP = 'UPDATE' AND NEW.account_id IS NOT DISTINCT FROM OLD.account_id THEN
    RETURN NEW;
  END IF;

  SELECT * INTO snap FROM public.job_credit_snapshot(NEW.account_id);
  -- No rep on the account: nothing to credit, and nothing to lock, so a rep
  -- assigned before the job is first linked still gets it.
  IF snap.rep IS NULL THEN RETURN NEW; END IF;

  NEW.credit_rep_id := snap.rep;
  NEW.credit_stage_key := snap.stage_key;
  NEW.credit_requires_approval := snap.requires_approval;
  NEW.credit_locked_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_jobs_credit_lock() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS jobs_credit_lock ON public.jobs;
CREATE TRIGGER jobs_credit_lock
  BEFORE INSERT OR UPDATE OF account_id, credit_rep_id, credit_stage_key, credit_requires_approval, credit_locked_at
  ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.tg_jobs_credit_lock();

-- ----------------------------------------------------------------- engine

-- Same function as 20260820084452 with three changes, each marked CREDIT:
--   1. the payee is the job's locked credit rep when there is one;
--   2. a new payout starts 'approved' when the stage at arrival says it pays
--      automatically, 'pending' otherwise;
--   3. an auto-approved payout (approved_by IS NULL) keeps following the
--      job's money like a pending one — nobody signed off on that number —
--      while a payout a person approved or paid is never recalculated.
CREATE OR REPLACE FUNCTION public.compute_job_commissions(_job_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  j public.jobs%ROWTYPE;
  v_reps uuid[];
  v_rep uuid;
  v_split numeric;
  v_plan public.commission_plans%ROWTYPE;
  v_tier public.commission_tiers%ROWTYPE;
  v_basis numeric;
  v_cost numeric;
  v_volume numeric;
  v_rate numeric;
  v_amount numeric;
  v_on date;
  v_count int := 0;
  v_auto boolean;
BEGIN
  SELECT * INTO j FROM public.jobs WHERE id = _job_id;
  IF NOT FOUND THEN RETURN 0; END IF;

  v_on := COALESCE(j.completion_date, j.start_date, j.created_at::date);

  -- CREDIT 1: the rep the account had when the job arrived, when locked.
  IF j.credit_rep_id IS NOT NULL THEN
    v_reps := ARRAY[j.credit_rep_id];
  ELSE
    SELECT array_agg(DISTINCT a.user_id) INTO v_reps
      FROM public.job_assignments a
     WHERE a.job_id = _job_id AND a.role = 'account_rep';
    IF v_reps IS NULL OR array_length(v_reps, 1) IS NULL THEN
      v_reps := CASE WHEN j.created_by IS NULL THEN '{}'::uuid[] ELSE ARRAY[j.created_by] END;
    END IF;
  END IF;
  IF array_length(v_reps, 1) IS NULL THEN RETURN 0; END IF;

  -- CREDIT 2: pays automatically only when the stage at arrival says so.
  v_auto := j.credit_rep_id IS NOT NULL AND j.credit_requires_approval IS FALSE;

  v_split := round(100.0 / array_length(v_reps, 1), 2);

  SELECT COALESCE(SUM(COALESCE(c.direct_cost,0) + COALESCE(c.materials_cost,0)
                    + COALESCE(c.subcontractor_cost,0) + COALESCE(c.equipment_cost,0)), 0)
    INTO v_cost FROM public.job_cost_lines c WHERE c.job_id = _job_id;

  FOREACH v_rep IN ARRAY v_reps LOOP
    SELECT * INTO v_plan FROM public.commission_plans p
     WHERE p.user_id = v_rep
       AND p.effective_from <= v_on
       AND (p.effective_to IS NULL OR p.effective_to >= v_on)
     ORDER BY p.effective_from DESC
     LIMIT 1;
    IF NOT FOUND THEN CONTINUE; END IF;

    v_basis := CASE v_plan.basis
      WHEN 'billed' THEN COALESCE(j.billed_amount, j.approved_amount, j.agreed_price, 0)
      WHEN 'gross_profit' THEN COALESCE(j.billed_amount, j.approved_amount, j.agreed_price, 0) - v_cost
      ELSE COALESCE(j.collected_amount, 0)
    END;

    IF v_basis IS NULL OR v_basis <= 0 OR j.status = 'cancelled' THEN
      -- CREDIT 3: an auto-approved row is the engine's own number; drop it too.
      DELETE FROM public.commission_payouts
       WHERE job_id = _job_id AND user_id = v_rep AND kind = 'commission'
         AND (status = 'pending' OR (status = 'approved' AND approved_by IS NULL));
      CONTINUE;
    END IF;

    SELECT COALESCE(SUM(COALESCE(x.billed_amount, x.approved_amount, x.agreed_price, 0)), 0)
      INTO v_volume
      FROM public.jobs x
     WHERE x.status <> 'cancelled'
       AND date_part('year', COALESCE(x.completion_date, x.created_at::date)) = date_part('year', v_on)
       AND (
         x.credit_rep_id = v_rep
         OR (x.credit_rep_id IS NULL AND (
           EXISTS (SELECT 1 FROM public.job_assignments a
                    WHERE a.job_id = x.id AND a.role = 'account_rep' AND a.user_id = v_rep)
           OR (x.created_by = v_rep
               AND NOT EXISTS (SELECT 1 FROM public.job_assignments a2
                                WHERE a2.job_id = x.id AND a2.role = 'account_rep'))
         ))
       );

    SELECT * INTO v_tier FROM public.commission_tiers t
     WHERE t.active
       AND t.min_amount <= v_volume
       AND (t.work_component IS NULL OR t.work_component = v_plan.work_component)
       AND t.effective_from <= v_on
       AND (t.effective_to IS NULL OR t.effective_to >= v_on)
     ORDER BY t.min_amount DESC, t.sort_order DESC
     LIMIT 1;

    v_rate := COALESCE(v_tier.rate_percent, v_plan.rate_percent);
    v_amount := round((COALESCE(v_plan.flat_amount, 0)
                      + v_basis * COALESCE(v_rate, 0) / 100.0) * v_split / 100.0, 2);

    IF v_amount <= 0 THEN
      DELETE FROM public.commission_payouts
       WHERE job_id = _job_id AND user_id = v_rep AND kind = 'commission'
         AND (status = 'pending' OR (status = 'approved' AND approved_by IS NULL));
      CONTINUE;
    END IF;

    INSERT INTO public.commission_payouts AS cp (
      user_id, location_id, kind, amount, status, approved_at, period_start, period_end,
      job_id, basis, basis_amount, rate_percent, split_percent, tier_key,
      expected_pay_date, source, note, is_demo
    ) VALUES (
      v_rep, j.location_id, 'commission', v_amount,
      CASE WHEN v_auto THEN 'approved' ELSE 'pending' END,
      CASE WHEN v_auto THEN now() ELSE NULL END,
      date_trunc('month', v_on)::date,
      (date_trunc('month', v_on) + interval '1 month - 1 day')::date,
      _job_id, v_plan.basis, v_basis, v_rate, v_split, v_tier.key,
      (date_trunc('month', v_on) + interval '1 month 14 days')::date,
      'engine', v_plan.note, j.is_demo
    )
    ON CONFLICT (job_id, user_id, kind) WHERE job_id IS NOT NULL
    DO UPDATE SET
      amount = EXCLUDED.amount,
      basis = EXCLUDED.basis,
      basis_amount = EXCLUDED.basis_amount,
      rate_percent = EXCLUDED.rate_percent,
      split_percent = EXCLUDED.split_percent,
      tier_key = EXCLUDED.tier_key,
      location_id = EXCLUDED.location_id,
      expected_pay_date = EXCLUDED.expected_pay_date,
      updated_at = now()
    WHERE cp.status = 'pending' OR (cp.status = 'approved' AND cp.approved_by IS NULL);

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;
-- Same grants as 20260908010058: the engine runs from its trigger and the
-- finance-gated recompute, never from a client directly.
REVOKE ALL ON FUNCTION public.compute_job_commissions(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.compute_job_commissions(uuid) TO service_role;
