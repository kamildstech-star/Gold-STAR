-- AI credits: who spent them.
--
-- The header's AI credits chip (Owner / Admin / Developer) lists this month's
-- credits per person, like Monitex. Each usage row now carries the signed-in
-- user whose request made the AI call; calls with no user (cron, webhooks,
-- automations) stay NULL and show as "Automations".
--
-- ai_usage_record gains p_user_id (DEFAULT NULL). The old six-argument
-- signature is dropped so a named-argument RPC call is never ambiguous.

ALTER TABLE public.ai_credit_ledger ADD COLUMN IF NOT EXISTS user_id uuid;
CREATE INDEX IF NOT EXISTS ai_credit_ledger_usage_user_at_idx
  ON public.ai_credit_ledger (at, user_id) WHERE kind = 'usage';

DROP FUNCTION IF EXISTS public.ai_usage_record(text, text, bigint, bigint, numeric, boolean);

CREATE OR REPLACE FUNCTION public.ai_usage_record(
  p_feature text,
  p_model text,
  p_input_tokens bigint,
  p_output_tokens bigint,
  p_cost_cents numeric,
  p_billable boolean DEFAULT true,
  p_user_id uuid DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _month date := date_trunc('month', now() AT TIME ZONE 'America/New_York')::date;
  _cost numeric := round(GREATEST(COALESCE(p_cost_cents, 0), 0), 6);
  _billable boolean := COALESCE(p_billable, true);
  _b public.ai_billing;
  _before numeric;
  _after numeric;
  _credits numeric := 0;
  _id bigint;
BEGIN
  -- The row lock serialises concurrent calls, so each one is priced on the
  -- month's raw total exactly as the call before it left it.
  SELECT * INTO _b FROM public.ai_billing WHERE id FOR UPDATE;
  IF _billable AND _cost > 0 THEN
    _before := CASE WHEN _b.month_start = _month THEN _b.month_raw_cents ELSE 0 END;
    _after := _before + _cost;
    _credits := public.ai_usage_apply_tiers(_after, _b.tiers) - public.ai_usage_apply_tiers(_before, _b.tiers);
    UPDATE public.ai_billing SET month_start = _month, month_raw_cents = _after WHERE id;
  END IF;

  INSERT INTO public.ai_credit_ledger (kind, credits, source, feature, model, input_tokens, output_tokens, raw_cost_cents, billable, user_id)
  VALUES ('usage', -round(_credits, 6), p_feature, p_feature, left(btrim(p_model), 80),
          GREATEST(COALESCE(p_input_tokens, 0), 0), GREATEST(COALESCE(p_output_tokens, 0), 0), _cost, _billable, p_user_id)
  RETURNING id INTO _id;

  SELECT * INTO _b FROM public.ai_billing WHERE id;
  RETURN jsonb_build_object(
    'id', _id,
    'credits', round(_credits, 6),
    'balance', round(_b.balance, 6),
    'auto_topup_due',
      _b.auto_topup_enabled
      AND _b.stripe_payment_method_id IS NOT NULL
      AND _b.auto_topup_failed_at IS NULL
      AND _b.auto_topup_threshold_credits IS NOT NULL
      AND _b.balance < _b.auto_topup_threshold_credits
      AND (_b.auto_topup_pending_since IS NULL OR _b.auto_topup_pending_since < now() - interval '30 minutes'));
END;
$function$;

-- The header chip: balance, this month and last month, and this month per
-- person. Credits only, like ai_credits_overview.
CREATE OR REPLACE FUNCTION public.ai_credits_usage_by_user()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _b public.ai_billing;
  _cur record;
  _prev record;
BEGIN
  IF NOT public.can_manage_ai_credits(auth.uid()) THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO _b FROM public.ai_billing WHERE id;
  SELECT * INTO _cur FROM public.falcon_month_bounds(NULL);
  SELECT * INTO _prev FROM public.falcon_month_bounds((_cur.m - interval '1 month')::date);
  RETURN jsonb_build_object(
    'month', to_char(_cur.m, 'YYYY-MM'),
    'balance', floor(_b.balance),
    'last_topup_credits', floor(_b.last_topup_credits),
    'used_this_month', COALESCE((SELECT round(-sum(l.credits)) FROM public.ai_credit_ledger l
                                  WHERE l.kind = 'usage' AND l.at >= _cur.start_at AND l.at < _cur.end_at), 0),
    'used_last_month', COALESCE((SELECT round(-sum(l.credits)) FROM public.ai_credit_ledger l
                                  WHERE l.kind = 'usage' AND l.at >= _prev.start_at AND l.at < _prev.end_at), 0),
    'users', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('user_id', u.user_id, 'name', u.name, 'credits', u.credits)
                       ORDER BY u.credits DESC, u.name)
        FROM (SELECT l.user_id,
                     CASE WHEN l.user_id IS NULL THEN NULL
                          ELSE COALESCE(NULLIF(btrim(p.full_name), ''), p.email, 'Former user') END AS name,
                     round(-sum(l.credits)) AS credits
                FROM public.ai_credit_ledger l
                LEFT JOIN public.profiles p ON p.user_id = l.user_id
               WHERE l.kind = 'usage' AND l.at >= _cur.start_at AND l.at < _cur.end_at
               GROUP BY l.user_id, p.full_name, p.email) u), '[]'::jsonb));
END;
$function$;

REVOKE ALL ON FUNCTION public.ai_usage_record(text, text, bigint, bigint, numeric, boolean, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ai_usage_record(text, text, bigint, bigint, numeric, boolean, uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.ai_credits_usage_by_user() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_usage_record(text, text, bigint, bigint, numeric, boolean, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.ai_credits_usage_by_user() TO authenticated;
