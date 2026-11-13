ALTER TABLE public.commission_payouts
  ADD COLUMN IF NOT EXISTS basis_amount numeric,
  ADD COLUMN IF NOT EXISTS rate_percent numeric,
  ADD COLUMN IF NOT EXISTS split_percent numeric NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS tier_key text,
  ADD COLUMN IF NOT EXISTS basis text,
  ADD COLUMN IF NOT EXISTS expected_pay_date date,
  ADD COLUMN IF NOT EXISTS approved_by uuid,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS paid_at timestamptz,
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';

CREATE UNIQUE INDEX IF NOT EXISTS commission_payouts_job_user_kind_uniq
  ON public.commission_payouts (job_id, user_id, kind)
  WHERE job_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS commission_payouts_user_idx ON public.commission_payouts (user_id, period_start DESC);

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
BEGIN
  SELECT * INTO j FROM public.jobs WHERE id = _job_id;
  IF NOT FOUND THEN RETURN 0; END IF;

  v_on := COALESCE(j.completion_date, j.start_date, j.created_at::date);

  SELECT array_agg(DISTINCT a.user_id) INTO v_reps
    FROM public.job_assignments a
   WHERE a.job_id = _job_id AND a.role = 'account_rep';

  IF v_reps IS NULL OR array_length(v_reps, 1) IS NULL THEN
    v_reps := CASE WHEN j.created_by IS NULL THEN '{}'::uuid[] ELSE ARRAY[j.created_by] END;
  END IF;
  IF array_length(v_reps, 1) IS NULL THEN RETURN 0; END IF;

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
      DELETE FROM public.commission_payouts
       WHERE job_id = _job_id AND user_id = v_rep AND kind = 'commission' AND status = 'pending';
      CONTINUE;
    END IF;

    SELECT COALESCE(SUM(COALESCE(x.billed_amount, x.approved_amount, x.agreed_price, 0)), 0)
      INTO v_volume
      FROM public.jobs x
     WHERE x.status <> 'cancelled'
       AND date_part('year', COALESCE(x.completion_date, x.created_at::date)) = date_part('year', v_on)
       AND (
         EXISTS (SELECT 1 FROM public.job_assignments a
                  WHERE a.job_id = x.id AND a.role = 'account_rep' AND a.user_id = v_rep)
         OR (x.created_by = v_rep
             AND NOT EXISTS (SELECT 1 FROM public.job_assignments a2
                              WHERE a2.job_id = x.id AND a2.role = 'account_rep'))
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
       WHERE job_id = _job_id AND user_id = v_rep AND kind = 'commission' AND status = 'pending';
      CONTINUE;
    END IF;

    INSERT INTO public.commission_payouts AS cp (
      user_id, location_id, kind, amount, status, period_start, period_end,
      job_id, basis, basis_amount, rate_percent, split_percent, tier_key,
      expected_pay_date, source, note, is_demo
    ) VALUES (
      v_rep, j.location_id, 'commission', v_amount, 'pending',
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
    WHERE cp.status = 'pending';

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.jobs_commission_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.compute_job_commissions(NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS jobs_commission_sync_trg ON public.jobs;
CREATE TRIGGER jobs_commission_sync_trg
AFTER INSERT OR UPDATE OF status, collected_amount, billed_amount, approved_amount, agreed_price, location_id, completion_date
ON public.jobs
FOR EACH ROW EXECUTE FUNCTION public.jobs_commission_sync();

CREATE OR REPLACE FUNCTION public.recompute_all_commissions()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE r record; n int := 0;
BEGIN
  FOR r IN SELECT id FROM public.jobs LOOP
    n := n + public.compute_job_commissions(r.id);
  END LOOP;
  RETURN n;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_commission_payout_status(_id uuid, _status text)
RETURNS public.commission_payouts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE row public.commission_payouts;
BEGIN
  IF NOT public.can_view_finance(auth.uid()) THEN
    RAISE EXCEPTION 'Not permitted to change commission payouts';
  END IF;
  IF _status NOT IN ('pending','approved','paid','void') THEN
    RAISE EXCEPTION 'Unknown status %', _status;
  END IF;

  UPDATE public.commission_payouts SET
    status = _status,
    approved_by = CASE WHEN _status IN ('approved','paid') THEN auth.uid() ELSE approved_by END,
    approved_at = CASE WHEN _status IN ('approved','paid') THEN COALESCE(approved_at, now()) ELSE NULL END,
    paid_at = CASE WHEN _status = 'paid' THEN COALESCE(paid_at, now()) ELSE NULL END,
    issued_on = CASE WHEN _status = 'paid' THEN COALESCE(issued_on, CURRENT_DATE) ELSE issued_on END,
    updated_at = now()
  WHERE id = _id
  RETURNING * INTO row;

  RETURN row;
END;
$$;

CREATE OR REPLACE FUNCTION public.commission_overview(_user_id uuid, _from date, _to date)
RETURNS TABLE(signed_volume numeric, collected_volume numeric, salary_period numeric, pay_type text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_days numeric;
BEGIN
  IF _user_id <> auth.uid() AND NOT public.can_view_finance(auth.uid()) THEN
    RAISE EXCEPTION 'Not permitted';
  END IF;
  v_days := GREATEST(1, (_to - _from) + 1);

  RETURN QUERY
  WITH mine AS (
    SELECT x.* FROM public.jobs x
     WHERE x.status <> 'cancelled'
       AND COALESCE(x.completion_date, x.created_at::date) BETWEEN _from AND _to
       AND (
         EXISTS (SELECT 1 FROM public.job_assignments a
                  WHERE a.job_id = x.id AND a.role = 'account_rep' AND a.user_id = _user_id)
         OR (x.created_by = _user_id
             AND NOT EXISTS (SELECT 1 FROM public.job_assignments a2
                              WHERE a2.job_id = x.id AND a2.role = 'account_rep'))
       )
  )
  SELECT
    (SELECT COALESCE(SUM(COALESCE(m.billed_amount, m.approved_amount, m.agreed_price, 0)), 0) FROM mine m),
    (SELECT COALESCE(SUM(COALESCE(m.collected_amount, 0)), 0) FROM mine m),
    (SELECT COALESCE(
        CASE WHEN p.salary_basis = 'hourly'
          THEN COALESCE(p.hourly_rate,0) * COALESCE(p.hours_per_week,40) / 7.0 * v_days
          ELSE COALESCE(p.base_salary_annual,0) / 365.0 * v_days END, 0)
       FROM public.pay_structures p
      WHERE p.user_id = _user_id
        AND p.effective_from <= _to
        AND (p.effective_to IS NULL OR p.effective_to >= _from)
      ORDER BY p.effective_from DESC LIMIT 1),
    (SELECT p.pay_type::text FROM public.pay_structures p
      WHERE p.user_id = _user_id
        AND p.effective_from <= _to
        AND (p.effective_to IS NULL OR p.effective_to >= _from)
      ORDER BY p.effective_from DESC LIMIT 1);
END;
$$;

GRANT EXECUTE ON FUNCTION public.compute_job_commissions(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.recompute_all_commissions() TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_commission_payout_status(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.commission_overview(uuid, date, date) TO authenticated;