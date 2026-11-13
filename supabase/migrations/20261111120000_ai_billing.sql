-- AI BILLING — prepaid AI credits, controlled from the Falcon Console.
--
-- ONE migration, three tables. Purely additive: it touches nothing that
-- already exists, so it is safe on a project that is already in production.
--
--   ai_billing             one row: markup tiers, credit packs, balance,
--                          auto top-up settings and the saved Stripe card
--   ai_credit_ledger       append-only, one row per AI call (kind 'usage'),
--                          per paid top-up ('topup') and per console grant or
--                          deduction ('adjustment'). balance = sum(credits).
--   falcon_bridge_requests replay guard for the falcon-bridge edge function
--
-- 1 credit = 1 billed US cent. A usage row is charged
--   tiers(month_raw_after) − tiers(month_raw_before)
-- where the tiers are marginal bands on the calendar month's running raw
-- provider cost (America/New_York).
--
-- Nobody signed in to the app can grant credits or change tiers or packs.
-- Only the console can, through falcon-bridge, which calls the falcon_*
-- functions with the service role.
--
-- BEFORE APPLYING, edit the two project hooks in section 0. Optionally change
-- the starting tiers and packs in section 2.
--
-- Runs as one transaction under the Supabase migration runner. If you paste it
-- into the SQL editor, wrap it in BEGIN; … COMMIT;.

-- ═════════════════════════════════════════════════════════ 0. PROJECT HOOKS (EDIT)

-- GOLD STAR (GSR): Owner, Admin and Developer may open Settings → AI credits,
-- buy packs, save a card and turn auto top-up on or off. The same three roles
-- the page itself defaults to (page-access.ts, PRIVILEGED). Nobody else.
CREATE OR REPLACE FUNCTION public.can_manage_ai_credits(_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT _user_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.user_roles ur
                  WHERE ur.user_id = _user_id
                    AND ur.role::text IN ('owner', 'admin', 'dev'));
$function$;

-- Low-balance warnings. _level: '25' | '10' (percent of the last top-up left),
-- '0' (ran out) or 'failed' (automatic top-up charge failed).
-- GSR: one in-app notification (the bell) to every Owner and Admin, linking to
-- Settings → AI credits. Developers are left out on purpose: they are not the
-- people who pay. Must never raise: the caller wraps it, and so does this.
CREATE OR REPLACE FUNCTION public.ai_credits_notify(_level text, _balance numeric, _detail text DEFAULT NULL)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _title text;
  _body text;
BEGIN
  _title := CASE _level
    WHEN '0' THEN 'AI credits ran out'
    WHEN 'failed' THEN 'AI credits: automatic top-up failed'
    ELSE 'AI credits are running low'
  END;
  _body := CASE _level
    WHEN '0' THEN 'The AI credit balance is at zero. Buy a pack in Settings → AI credits to keep AI features working.'
    WHEN 'failed' THEN 'The saved card was declined' || COALESCE(' (' || _detail || ')', '') || '. Save a card again in Settings → AI credits.'
    ELSE _level || '% of the last top-up is left (' || round(GREATEST(_balance, 0))::text || ' credits). Top up in Settings → AI credits.'
  END;
  BEGIN
    INSERT INTO public.notifications (user_id, type, title, body, href, priority)
    SELECT DISTINCT ur.user_id, 'automation_escalation'::public.notification_type, _title, _body,
           '/admin/ai-credits',
           (CASE WHEN _level IN ('0', 'failed') THEN 'urgent' ELSE 'high' END)::public.notification_priority
      FROM public.user_roles ur
     WHERE ur.role::text IN ('owner', 'admin');
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'ai_credits_notify could not write notifications: %', SQLERRM;
  END;
  RAISE LOG 'ai_credits_notify level=% balance=% detail=%', _level, round(_balance), _detail;
END;
$function$;

-- ═════════════════════════════════════════════════════════ 1. VALIDATION AND TIER MATHS

-- Tiers: [{"up_to_cents": <int, ascending> | null (last), "multiplier": 1..10}], 1–10 bands.
CREATE OR REPLACE FUNCTION public.ai_billing_tiers_valid(p_tiers jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  _t jsonb;
  _n int;
  _i int := 0;
  _prev numeric := 0;
  _cap numeric;
  _mult numeric;
BEGIN
  IF p_tiers IS NULL OR jsonb_typeof(p_tiers) <> 'array' THEN RETURN false; END IF;
  _n := jsonb_array_length(p_tiers);
  IF _n < 1 OR _n > 10 THEN RETURN false; END IF;
  FOR _t IN SELECT e FROM jsonb_array_elements(p_tiers) WITH ORDINALITY AS x(e, i) ORDER BY i LOOP
    _i := _i + 1;
    IF jsonb_typeof(_t) <> 'object' OR jsonb_typeof(_t -> 'multiplier') IS DISTINCT FROM 'number' THEN RETURN false; END IF;
    _mult := (_t ->> 'multiplier')::numeric;
    IF _mult < 1 OR _mult > 10 THEN RETURN false; END IF;
    IF _i = _n THEN
      IF COALESCE(jsonb_typeof(_t -> 'up_to_cents'), 'null') <> 'null' THEN RETURN false; END IF;
    ELSE
      IF jsonb_typeof(_t -> 'up_to_cents') IS DISTINCT FROM 'number' THEN RETURN false; END IF;
      _cap := (_t ->> 'up_to_cents')::numeric;
      IF _cap <> trunc(_cap) OR _cap <= _prev THEN RETURN false; END IF;
      _prev := _cap;
    END IF;
  END LOOP;
  RETURN true;
END;
$function$;

-- Packs: [{"id": "^[a-z0-9_]{1,40}$", "price_cents": 500..1,000,000, "credits": 1..10,000,000}], 1–8, unique ids.
CREATE OR REPLACE FUNCTION public.ai_credit_packs_valid(p_packs jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT p_packs IS NOT NULL
     AND jsonb_typeof(p_packs) = 'array'
     AND jsonb_array_length(p_packs) BETWEEN 1 AND 8
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_packs) e
        WHERE jsonb_typeof(e) <> 'object'
           OR COALESCE(e ->> 'id', '') !~ '^[a-z0-9_]{1,40}$'
           OR jsonb_typeof(e -> 'price_cents') IS DISTINCT FROM 'number'
           OR jsonb_typeof(e -> 'credits') IS DISTINCT FROM 'number'
           OR (e ->> 'price_cents')::numeric <> trunc((e ->> 'price_cents')::numeric)
           OR (e ->> 'credits')::numeric <> trunc((e ->> 'credits')::numeric)
           OR (e ->> 'price_cents')::numeric NOT BETWEEN 500 AND 1000000
           OR (e ->> 'credits')::numeric NOT BETWEEN 1 AND 10000000)
     AND (SELECT count(DISTINCT e ->> 'id') FROM jsonb_array_elements(p_packs) e) = jsonb_array_length(p_packs);
$function$;

-- Marginal tiers: each band's share of the raw cost × that band's multiplier.
CREATE OR REPLACE FUNCTION public.ai_usage_apply_tiers(p_raw_cents numeric, p_tiers jsonb)
 RETURNS numeric
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  _raw numeric := GREATEST(COALESCE(p_raw_cents, 0), 0);
  _t jsonb;
  _prev numeric := 0;
  _cap numeric;
  _band numeric;
  _total numeric := 0;
BEGIN
  IF NOT public.ai_billing_tiers_valid(p_tiers) THEN
    RAISE EXCEPTION 'invalid AI billing tiers';
  END IF;
  FOR _t IN SELECT e FROM jsonb_array_elements(p_tiers) WITH ORDINALITY AS x(e, i) ORDER BY i LOOP
    _cap := NULLIF(_t ->> 'up_to_cents', '')::numeric;
    _band := LEAST(_raw, COALESCE(_cap, _raw)) - _prev;
    IF _band > 0 THEN
      _total := _total + _band * (_t ->> 'multiplier')::numeric;
    END IF;
    EXIT WHEN _cap IS NULL OR _raw <= _cap;
    _prev := _cap;
  END LOOP;
  RETURN _total;
END;
$function$;

-- Month boundaries, America/New_York. NULL = the current month.
CREATE OR REPLACE FUNCTION public.falcon_month_bounds(p_month date, OUT m date, OUT start_at timestamptz, OUT end_at timestamptz)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT x.m,
         (x.m::timestamp AT TIME ZONE 'America/New_York'),
         ((x.m + interval '1 month')::timestamp AT TIME ZONE 'America/New_York')
    FROM (SELECT date_trunc('month', COALESCE(p_month, (now() AT TIME ZONE 'America/New_York')::date))::date AS m) x;
$function$;

CREATE OR REPLACE FUNCTION public.falcon_operator_ok(p_operator text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT COALESCE(p_operator ~ '^[a-z0-9._%+-]+@falconmarketing\.com$', false);
$function$;

-- ═════════════════════════════════════════════════════════ 2. TABLES

CREATE TABLE IF NOT EXISTS public.ai_billing (
  id                           boolean PRIMARY KEY DEFAULT true CHECK (id),
  -- Pricing (changed only from the console)
  tiers                        jsonb NOT NULL CHECK (public.ai_billing_tiers_valid(tiers)),
  tiers_updated_at             timestamptz NOT NULL DEFAULT now(),
  tiers_updated_by_falcon      text,
  packs                        jsonb NOT NULL CHECK (public.ai_credit_packs_valid(packs)),
  packs_updated_at             timestamptz NOT NULL DEFAULT now(),
  packs_updated_by_falcon      text,
  -- Running state (kept by the functions below)
  balance                      numeric(18,6) NOT NULL DEFAULT 0,
  last_topup_credits           numeric(18,6) NOT NULL DEFAULT 0,
  last_topup_at                timestamptz,
  alerts_sent                  text[] NOT NULL DEFAULT '{}',
  month_start                  date,
  month_raw_cents              numeric(18,6) NOT NULL DEFAULT 0,
  -- Automatic top-up and the saved card (Stripe)
  auto_topup_enabled           boolean NOT NULL DEFAULT false,
  auto_topup_pack_id           text,
  auto_topup_threshold_credits bigint CHECK (auto_topup_threshold_credits IS NULL OR auto_topup_threshold_credits > 0),
  stripe_customer_id           text,
  stripe_payment_method_id     text,
  card_brand                   text,
  card_last4                   text,
  auto_topup_pending_since     timestamptz,
  auto_topup_attempt_id        uuid,
  auto_topup_failed_at         timestamptz,
  auto_topup_failure           text
);

-- Starting tiers and packs (the same as Monitex). The console can change them later.
--   Tiers: first $300 of raw cost ×2.0, $300–$700 ×1.5, above $700 ×1.25.
--   Packs: $100 → 10,000; $250 → 26,000; $500 → 53,500; $1,000 → 110,000 credits.
INSERT INTO public.ai_billing (id, tiers, packs)
VALUES (true,
  '[{"up_to_cents": 30000, "multiplier": 2.0},
    {"up_to_cents": 70000, "multiplier": 1.5},
    {"up_to_cents": null,  "multiplier": 1.25}]'::jsonb,
  '[{"id": "pack_100",  "price_cents": 10000,  "credits": 10000},
    {"id": "pack_250",  "price_cents": 25000,  "credits": 26000},
    {"id": "pack_500",  "price_cents": 50000,  "credits": 53500},
    {"id": "pack_1000", "price_cents": 100000, "credits": 110000}]'::jsonb)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.ai_credit_ledger (
  id                       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at                       timestamptz NOT NULL DEFAULT now(),
  kind                     text NOT NULL CHECK (kind IN ('usage', 'topup', 'adjustment')),
  credits                  numeric(18,6) NOT NULL,
  source                   text,          -- usage: the feature; topup: 'checkout' | 'auto_topup'; adjustment: 'falcon_console'
  -- usage: one row per AI provider call
  feature                  text CHECK (feature IS NULL OR feature ~ '^[a-z][a-z0-9_]{0,63}$'),
  model                    text CHECK (model IS NULL OR length(model) BETWEEN 1 AND 80),
  input_tokens             bigint CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens            bigint CHECK (output_tokens IS NULL OR output_tokens >= 0),
  raw_cost_cents           numeric(16,6) CHECK (raw_cost_cents IS NULL OR raw_cost_cents >= 0),
  billable                 boolean,
  -- topup: a verified Stripe payment
  stripe_event_id          text UNIQUE,
  stripe_payment_intent_id text,
  amount_paid_cents        bigint CHECK (amount_paid_cents IS NULL OR amount_paid_cents > 0),
  pack_id                  text,
  receipt_url              text CHECK (receipt_url IS NULL OR receipt_url ~ '^https://'),
  created_by               uuid,          -- the app user who bought it
  -- adjustment: a console grant or deduction
  falcon_operator          text CHECK (falcon_operator IS NULL OR falcon_operator ~ '^[a-z0-9._%+-]+@falconmarketing\.com$'),
  reason                   text,
  CONSTRAINT ai_credit_ledger_usage_shape CHECK (kind <> 'usage' OR (
    credits <= 0 AND feature IS NOT NULL AND model IS NOT NULL AND raw_cost_cents IS NOT NULL AND billable IS NOT NULL)),
  CONSTRAINT ai_credit_ledger_topup_shape CHECK (kind <> 'topup' OR (
    credits > 0 AND stripe_event_id IS NOT NULL AND stripe_payment_intent_id IS NOT NULL AND amount_paid_cents IS NOT NULL)),
  CONSTRAINT ai_credit_ledger_adjustment_shape CHECK (kind <> 'adjustment' OR (
    credits <> 0 AND length(btrim(COALESCE(reason, ''))) BETWEEN 3 AND 300 AND falcon_operator IS NOT NULL))
);

-- One grant per payment, whichever webhook event names it.
CREATE UNIQUE INDEX IF NOT EXISTS ai_credit_ledger_one_grant_per_payment
  ON public.ai_credit_ledger (stripe_payment_intent_id) WHERE kind = 'topup';
CREATE INDEX IF NOT EXISTS ai_credit_ledger_at_idx ON public.ai_credit_ledger (at);
CREATE INDEX IF NOT EXISTS ai_credit_ledger_kind_at_idx ON public.ai_credit_ledger (kind, at);

CREATE TABLE IF NOT EXISTS public.falcon_bridge_requests (
  request_id uuid PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  action     text NOT NULL,
  operator   text
);

-- ═════════════════════════════════════════════════════════ 3. LEDGER RULES

CREATE OR REPLACE FUNCTION public.ai_credit_ledger_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  RAISE EXCEPTION 'ai_credit_ledger is append-only — add an adjustment instead' USING ERRCODE = '42501';
END;
$function$;

DROP TRIGGER IF EXISTS trg_ai_credit_ledger_append_only ON public.ai_credit_ledger;
CREATE TRIGGER trg_ai_credit_ledger_append_only
  BEFORE UPDATE OR DELETE ON public.ai_credit_ledger
  FOR EACH ROW EXECUTE FUNCTION public.ai_credit_ledger_append_only();
DROP TRIGGER IF EXISTS trg_ai_credit_ledger_no_truncate ON public.ai_credit_ledger;
CREATE TRIGGER trg_ai_credit_ledger_no_truncate
  BEFORE TRUNCATE ON public.ai_credit_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION public.ai_credit_ledger_append_only();

-- Low-balance warnings: at 25 % and 10 % of the last top-up (only while auto
-- top-up is off or has failed) and at zero (always), each once per top-up.
CREATE OR REPLACE FUNCTION public.ai_credits_check_alerts()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _b public.ai_billing;
  _auto boolean;
  _due text[] := ARRAY[]::text[];
BEGIN
  SELECT * INTO _b FROM public.ai_billing WHERE id FOR UPDATE;
  _auto := _b.auto_topup_enabled AND _b.stripe_payment_method_id IS NOT NULL AND _b.auto_topup_failed_at IS NULL;
  IF NOT _auto AND _b.last_topup_credits > 0 THEN
    IF _b.balance <= _b.last_topup_credits * 0.25 AND NOT ('25' = ANY (_b.alerts_sent)) THEN _due := array_append(_due, '25'::text); END IF;
    IF _b.balance <= _b.last_topup_credits * 0.10 AND NOT ('10' = ANY (_b.alerts_sent)) THEN _due := array_append(_due, '10'::text); END IF;
  END IF;
  IF _b.balance <= 0 AND NOT ('0' = ANY (_b.alerts_sent)) THEN _due := array_append(_due, '0'::text); END IF;
  IF cardinality(_due) = 0 THEN RETURN; END IF;
  UPDATE public.ai_billing SET alerts_sent = alerts_sent || _due WHERE id;
  BEGIN
    PERFORM public.ai_credits_notify(_due[cardinality(_due)], _b.balance);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'ai_credits_notify failed: %', SQLERRM;   -- a warning never blocks billing
  END;
END;
$function$;

-- The balance follows the ledger.
CREATE OR REPLACE FUNCTION public.ai_credits_after_ledger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _refill boolean := NEW.kind IN ('topup', 'adjustment') AND NEW.credits > 0;
  _auto_paid boolean := NEW.kind = 'topup' AND NEW.source = 'auto_topup';
BEGIN
  IF NEW.credits = 0 THEN RETURN NEW; END IF;
  UPDATE public.ai_billing
     SET balance = balance + NEW.credits,
         last_topup_credits = CASE WHEN _refill THEN NEW.credits ELSE last_topup_credits END,
         last_topup_at = CASE WHEN _refill THEN NEW.at ELSE last_topup_at END,
         alerts_sent = CASE WHEN _refill THEN ARRAY[]::text[] ELSE alerts_sent END,
         auto_topup_pending_since = CASE WHEN _auto_paid THEN NULL ELSE auto_topup_pending_since END,
         auto_topup_attempt_id = CASE WHEN _auto_paid THEN NULL ELSE auto_topup_attempt_id END
   WHERE id;
  BEGIN
    PERFORM public.ai_credits_check_alerts();
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'ai_credits_check_alerts failed: %', SQLERRM;
  END;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_ai_credits_after_ledger ON public.ai_credit_ledger;
CREATE TRIGGER trg_ai_credits_after_ledger
  AFTER INSERT ON public.ai_credit_ledger
  FOR EACH ROW EXECUTE FUNCTION public.ai_credits_after_ledger();

-- ═════════════════════════════════════════════════════════ 4. SERVER: RECORD USAGE, GATE

-- Record one AI provider call and charge it. Called by _shared/ai-billing.ts
-- with the service role after every successful provider call.
CREATE OR REPLACE FUNCTION public.ai_usage_record(
  p_feature text,
  p_model text,
  p_input_tokens bigint,
  p_output_tokens bigint,
  p_cost_cents numeric,
  p_billable boolean DEFAULT true
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

  INSERT INTO public.ai_credit_ledger (kind, credits, source, feature, model, input_tokens, output_tokens, raw_cost_cents, billable)
  VALUES ('usage', -round(_credits, 6), p_feature, p_feature, left(btrim(p_model), 80),
          GREATEST(COALESCE(p_input_tokens, 0), 0), GREATEST(COALESCE(p_output_tokens, 0), 0), _cost, _billable)
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

-- The balance, asked before spending (only while AI_CREDITS_ENFORCED=true).
CREATE OR REPLACE FUNCTION public.ai_credits_balance()
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT round(balance, 6) FROM public.ai_billing WHERE id;
$function$;

-- ═════════════════════════════════════════════════════════ 5. APP: THE AI CREDITS PAGE

-- Credits only: never raw cost, tiers or tokens.
CREATE OR REPLACE FUNCTION public.ai_credits_overview()
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
    'packs', _b.packs,
    'auto_topup', jsonb_build_object(
      'enabled', _b.auto_topup_enabled,
      'pack_id', _b.auto_topup_pack_id,
      'threshold_credits', _b.auto_topup_threshold_credits,
      'card_brand', _b.card_brand,
      'card_last4', _b.card_last4,
      'pending', _b.auto_topup_pending_since IS NOT NULL AND _b.auto_topup_pending_since > now() - interval '30 minutes',
      'failed_at', _b.auto_topup_failed_at,
      'failure', _b.auto_topup_failure),
    'history', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', h.id, 'at', h.at, 'kind', h.kind, 'credits', round(h.credits),
               'amount_paid_cents', h.amount_paid_cents, 'pack_id', h.pack_id,
               'receipt_url', h.receipt_url, 'source', h.source, 'reason', h.reason) ORDER BY h.id DESC)
        FROM (SELECT * FROM public.ai_credit_ledger WHERE kind <> 'usage' ORDER BY id DESC LIMIT 50) h), '[]'::jsonb));
END;
$function$;

CREATE OR REPLACE FUNCTION public.ai_credits_set_auto_topup(p_enabled boolean, p_pack_id text, p_threshold_credits bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _b public.ai_billing;
BEGIN
  IF NOT public.can_manage_ai_credits(auth.uid()) THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO _b FROM public.ai_billing WHERE id FOR UPDATE;
  IF p_pack_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(_b.packs) e WHERE e ->> 'id' = p_pack_id) THEN
    RAISE EXCEPTION 'unknown pack' USING ERRCODE = '22023';
  END IF;
  IF p_threshold_credits IS NOT NULL AND (p_threshold_credits < 1 OR p_threshold_credits > 10000000) THEN
    RAISE EXCEPTION 'threshold out of range' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(p_enabled, false) AND (p_pack_id IS NULL OR p_threshold_credits IS NULL OR _b.stripe_payment_method_id IS NULL) THEN
    RAISE EXCEPTION 'auto top-up needs a pack, a threshold and a saved card' USING ERRCODE = '22023';
  END IF;
  UPDATE public.ai_billing
     SET auto_topup_enabled = COALESCE(p_enabled, false),
         auto_topup_pack_id = p_pack_id,
         auto_topup_threshold_credits = p_threshold_credits,
         auto_topup_failed_at = NULL,     -- saving again is the way back after a failed charge
         auto_topup_failure = NULL
   WHERE id;
END;
$function$;

-- ═════════════════════════════════════════════════════════ 6. STRIPE (ai-credits and stripe-credits-webhook)

CREATE OR REPLACE FUNCTION public.ai_credits_grant_topup(
  p_event_id text,
  p_payment_intent_id text,
  p_credits bigint,
  p_amount_cents bigint,
  p_pack_id text,
  p_receipt_url text,
  p_user_id uuid,
  p_source text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF p_event_id IS NULL OR p_payment_intent_id IS NULL OR COALESCE(p_credits, 0) <= 0 OR COALESCE(p_amount_cents, 0) <= 0 THEN
    RAISE EXCEPTION 'invalid top-up' USING ERRCODE = '22023';
  END IF;
  -- Idempotent: once per Stripe event, and once per payment.
  IF EXISTS (SELECT 1 FROM public.ai_credit_ledger
              WHERE stripe_event_id = p_event_id
                 OR (kind = 'topup' AND stripe_payment_intent_id = p_payment_intent_id)) THEN
    RETURN jsonb_build_object('granted', false);
  END IF;
  INSERT INTO public.ai_credit_ledger
    (kind, credits, stripe_event_id, stripe_payment_intent_id, amount_paid_cents, pack_id, receipt_url, source, created_by)
  VALUES ('topup', p_credits, p_event_id, p_payment_intent_id, p_amount_cents, p_pack_id,
          CASE WHEN p_receipt_url ~ '^https://' THEN p_receipt_url END,
          CASE WHEN p_source IN ('checkout', 'auto_topup') THEN p_source ELSE 'checkout' END,
          p_user_id)
  ON CONFLICT DO NOTHING;
  RETURN jsonb_build_object('granted', FOUND);
END;
$function$;

CREATE OR REPLACE FUNCTION public.ai_credits_save_customer(p_customer_id text)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  UPDATE public.ai_billing
     SET stripe_customer_id = COALESCE(stripe_customer_id, p_customer_id)
   WHERE id AND p_customer_id ~ '^cus_[A-Za-z0-9]+$';
$function$;

CREATE OR REPLACE FUNCTION public.ai_credits_save_card(p_customer_id text, p_payment_method_id text, p_brand text, p_last4 text, p_user_id uuid)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  UPDATE public.ai_billing
     SET stripe_customer_id = p_customer_id,
         stripe_payment_method_id = p_payment_method_id,
         card_brand = left(p_brand, 30),
         card_last4 = CASE WHEN p_last4 ~ '^[0-9]{4}$' THEN p_last4 END,
         auto_topup_failed_at = NULL,
         auto_topup_failure = NULL
   WHERE id AND p_customer_id ~ '^cus_[A-Za-z0-9]+$' AND p_payment_method_id ~ '^pm_[A-Za-z0-9]+$';
$function$;

-- Claim the one automatic top-up that may run now: enabled, card saved, balance
-- under the threshold, nothing in flight (a claim older than 30 min is presumed
-- lost) and no unresolved failure.
CREATE OR REPLACE FUNCTION public.ai_credits_claim_auto_topup()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _b public.ai_billing;
  _pack jsonb;
  _attempt uuid := gen_random_uuid();
BEGIN
  SELECT * INTO _b FROM public.ai_billing WHERE id FOR UPDATE;
  IF NOT _b.auto_topup_enabled
     OR _b.stripe_payment_method_id IS NULL OR _b.stripe_customer_id IS NULL
     OR _b.auto_topup_failed_at IS NOT NULL
     OR _b.auto_topup_threshold_credits IS NULL
     OR _b.balance >= _b.auto_topup_threshold_credits
     OR (_b.auto_topup_pending_since IS NOT NULL AND _b.auto_topup_pending_since > now() - interval '30 minutes') THEN
    RETURN NULL;
  END IF;
  SELECT e INTO _pack FROM jsonb_array_elements(_b.packs) e WHERE e ->> 'id' = _b.auto_topup_pack_id LIMIT 1;
  IF _pack IS NULL THEN RETURN NULL; END IF;
  UPDATE public.ai_billing SET auto_topup_pending_since = now(), auto_topup_attempt_id = _attempt WHERE id;
  RETURN jsonb_build_object(
    'attempt_id', _attempt,
    'pack', _pack,
    'customer_id', _b.stripe_customer_id,
    'payment_method_id', _b.stripe_payment_method_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.ai_credits_auto_topup_failed(p_event_id text, p_attempt_id uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _already timestamptz;
  _balance numeric;
BEGIN
  SELECT auto_topup_failed_at, balance INTO _already, _balance FROM public.ai_billing WHERE id FOR UPDATE;
  UPDATE public.ai_billing
     SET auto_topup_failed_at = COALESCE(auto_topup_failed_at, now()),
         auto_topup_failure = left(COALESCE(NULLIF(btrim(p_reason), ''), 'card declined'), 200),
         auto_topup_pending_since = NULL,
         auto_topup_attempt_id = NULL
   WHERE id;
  IF _already IS NULL THEN   -- warn once per failure, not once per redelivered event
    BEGIN
      PERFORM public.ai_credits_notify('failed', _balance, left(p_reason, 80));
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'ai_credits_notify failed: %', SQLERRM;
    END;
  END IF;
  PERFORM public.ai_credits_check_alerts();
END;
$function$;

-- ═════════════════════════════════════════════════════════ 7. FALCON CONSOLE BRIDGE (falcon-bridge)

-- true the first time a request id is seen, false on a replay.
CREATE OR REPLACE FUNCTION public.falcon_bridge_claim(p_request_id uuid, p_action text, p_operator text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  DELETE FROM public.falcon_bridge_requests WHERE at < now() - interval '1 day';
  INSERT INTO public.falcon_bridge_requests (request_id, action, operator)
  VALUES (p_request_id, left(p_action, 64), left(p_operator, 200))
  ON CONFLICT (request_id) DO NOTHING;
  RETURN FOUND;
END;
$function$;

CREATE OR REPLACE FUNCTION public.falcon_overview()
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
  SELECT * INTO _b FROM public.ai_billing WHERE id;
  SELECT * INTO _cur FROM public.falcon_month_bounds(NULL);
  SELECT * INTO _prev FROM public.falcon_month_bounds((_cur.m - interval '1 month')::date);
  RETURN jsonb_build_object(
    'month', to_char(_cur.m, 'YYYY-MM'),
    'balance', round(_b.balance, 4),
    'last_topup_credits', round(_b.last_topup_credits, 4),
    'last_topup_at', _b.last_topup_at,
    'alerts_sent', to_jsonb(_b.alerts_sent),
    'used_this_month', COALESCE((SELECT round(-sum(l.credits), 4) FROM public.ai_credit_ledger l
                                  WHERE l.kind = 'usage' AND l.at >= _cur.start_at AND l.at < _cur.end_at), 0),
    'used_last_month', COALESCE((SELECT round(-sum(l.credits), 4) FROM public.ai_credit_ledger l
                                  WHERE l.kind = 'usage' AND l.at >= _prev.start_at AND l.at < _prev.end_at), 0),
    'used_last_7_days', COALESCE((SELECT round(-sum(l.credits), 4) FROM public.ai_credit_ledger l
                                   WHERE l.kind = 'usage' AND l.at >= now() - interval '7 days'), 0),
    'raw_cents_this_month', COALESCE((SELECT round(sum(l.raw_cost_cents), 4) FROM public.ai_credit_ledger l
                                       WHERE l.kind = 'usage' AND l.billable AND l.at >= _cur.start_at AND l.at < _cur.end_at), 0),
    'last_usage_at', (SELECT max(l.at) FROM public.ai_credit_ledger l WHERE l.kind = 'usage'),
    'auto_topup', jsonb_build_object(
      'enabled', _b.auto_topup_enabled,
      'pack_id', _b.auto_topup_pack_id,
      'threshold_credits', _b.auto_topup_threshold_credits,
      'card_on_file', _b.stripe_payment_method_id IS NOT NULL,
      'pending_since', _b.auto_topup_pending_since,
      'failed_at', _b.auto_topup_failed_at,
      'failure', _b.auto_topup_failure));
END;
$function$;

CREATE OR REPLACE FUNCTION public.falcon_usage_month(p_month date DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _cur record;
  _prev record;
  _tiers jsonb;
  _raw numeric;
  _unbilled numeric;
  _billed numeric;
BEGIN
  SELECT * INTO _cur FROM public.falcon_month_bounds(p_month);
  SELECT * INTO _prev FROM public.falcon_month_bounds((_cur.m - interval '1 month')::date);
  SELECT tiers INTO _tiers FROM public.ai_billing WHERE id;
  SELECT COALESCE(sum(raw_cost_cents) FILTER (WHERE billable), 0),
         COALESCE(sum(raw_cost_cents) FILTER (WHERE NOT billable), 0),
         COALESCE(-sum(credits), 0)
    INTO _raw, _unbilled, _billed
    FROM public.ai_credit_ledger
   WHERE kind = 'usage' AND at >= _cur.start_at AND at < _cur.end_at;

  RETURN jsonb_build_object(
    'month', to_char(_cur.m, 'YYYY-MM'),
    'tiers', _tiers,
    'raw_cents', round(_raw, 4),
    'non_billable_raw_cents', round(_unbilled, 4),
    'billed_cents', round(_billed, 4),
    'billed_cents_by_current_tiers', round(public.ai_usage_apply_tiers(_raw, _tiers), 4),
    'previous_raw_cents', COALESCE((SELECT round(sum(raw_cost_cents), 4) FROM public.ai_credit_ledger
                                     WHERE kind = 'usage' AND billable AND at >= _prev.start_at AND at < _prev.end_at), 0),
    'previous_billed_cents', COALESCE((SELECT round(-sum(credits), 4) FROM public.ai_credit_ledger
                                        WHERE kind = 'usage' AND at >= _prev.start_at AND at < _prev.end_at), 0),
    'by_feature', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'feature', f.feature, 'model', f.model, 'billable', f.billable, 'calls', f.calls,
               'raw_cents', round(f.raw, 4), 'billed_cents', round(f.billed, 4),
               'input_tokens', f.i, 'output_tokens', f.o, 'audio_seconds', 0)
             ORDER BY f.raw DESC)
        FROM (SELECT feature, model, billable, count(*) AS calls, sum(raw_cost_cents) AS raw, -sum(credits) AS billed,
                     sum(input_tokens) AS i, sum(output_tokens) AS o
                FROM public.ai_credit_ledger
               WHERE kind = 'usage' AND at >= _cur.start_at AND at < _cur.end_at
               GROUP BY feature, model, billable) f), '[]'::jsonb),
    'by_day', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('day', d.day, 'calls', d.calls,
                                          'raw_cents', round(d.raw, 4), 'billed_cents', round(d.billed, 4))
             ORDER BY d.day)
        FROM (SELECT to_char((at AT TIME ZONE 'America/New_York')::date, 'YYYY-MM-DD') AS day,
                     count(*) AS calls,
                     sum(raw_cost_cents) FILTER (WHERE billable) AS raw,
                     -sum(credits) AS billed
                FROM public.ai_credit_ledger
               WHERE kind = 'usage' AND at >= _cur.start_at AND at < _cur.end_at
               GROUP BY 1) d), '[]'::jsonb));
END;
$function$;

CREATE OR REPLACE FUNCTION public.falcon_money_month(p_month date DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _cur record;
BEGIN
  SELECT * INTO _cur FROM public.falcon_month_bounds(p_month);
  RETURN jsonb_build_object(
    'month', to_char(_cur.m, 'YYYY-MM'),
    'balance', (SELECT round(balance, 4) FROM public.ai_billing WHERE id),
    'purchases', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', l.id, 'at', l.at, 'pack_id', l.pack_id, 'credits', round(l.credits, 4),
               'paid_cents', l.amount_paid_cents, 'source', l.source, 'has_receipt', l.receipt_url IS NOT NULL)
             ORDER BY l.at DESC)
        FROM public.ai_credit_ledger l
       WHERE l.kind = 'topup' AND l.at >= _cur.start_at AND l.at < _cur.end_at), '[]'::jsonb),
    'month_totals', (
      SELECT jsonb_build_object(
        'paid_cents', COALESCE(sum(amount_paid_cents) FILTER (WHERE kind = 'topup'), 0),
        'purchased_credits', COALESCE(round(sum(credits) FILTER (WHERE kind = 'topup'), 4), 0),
        'purchase_count', count(*) FILTER (WHERE kind = 'topup'),
        'granted_credits', COALESCE(round(sum(credits) FILTER (WHERE kind = 'adjustment' AND credits > 0), 4), 0),
        'deducted_credits', COALESCE(round(-sum(credits) FILTER (WHERE kind = 'adjustment' AND credits < 0), 4), 0),
        'used_credits', COALESCE(round(-sum(credits) FILTER (WHERE kind = 'usage'), 4), 0),
        'raw_cents', COALESCE(round(sum(raw_cost_cents) FILTER (WHERE kind = 'usage' AND billable), 4), 0))
        FROM public.ai_credit_ledger
       WHERE at >= _cur.start_at AND at < _cur.end_at),
    'lifetime', (
      SELECT jsonb_build_object(
        'paid_cents', COALESCE(sum(amount_paid_cents) FILTER (WHERE kind = 'topup'), 0),
        'purchased_credits', COALESCE(round(sum(credits) FILTER (WHERE kind = 'topup'), 4), 0),
        'purchase_count', count(*) FILTER (WHERE kind = 'topup'),
        'granted_credits', COALESCE(round(sum(credits) FILTER (WHERE kind = 'adjustment' AND credits > 0), 4), 0),
        'deducted_credits', COALESCE(round(-sum(credits) FILTER (WHERE kind = 'adjustment' AND credits < 0), 4), 0),
        'used_credits', COALESCE(round(-sum(credits) FILTER (WHERE kind = 'usage'), 4), 0),
        'raw_cents', COALESCE(round(sum(raw_cost_cents) FILTER (WHERE kind = 'usage' AND billable), 4), 0),
        'first_at', min(at))
        FROM public.ai_credit_ledger));
END;
$function$;

CREATE OR REPLACE FUNCTION public.falcon_ledger(p_before_id bigint DEFAULT NULL, p_limit integer DEFAULT 50, p_kind text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(jsonb_agg(r ORDER BY (r ->> 'id')::bigint DESC), '[]'::jsonb)
    FROM (
      SELECT jsonb_build_object(
               'id', l.id, 'at', l.at, 'kind', l.kind, 'credits', round(l.credits, 4),
               'source', l.source, 'reason', l.reason, 'pack_id', l.pack_id,
               'amount_paid_cents', l.amount_paid_cents, 'has_receipt', l.receipt_url IS NOT NULL,
               'falcon_operator', l.falcon_operator,
               'by', COALESCE(l.falcon_operator, (SELECT u.email::text FROM auth.users u WHERE u.id = l.created_by))) AS r
        FROM public.ai_credit_ledger l
       WHERE (p_before_id IS NULL OR l.id < p_before_id)
         AND (p_kind IS NULL OR l.kind = p_kind)
       ORDER BY l.id DESC
       LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200)
    ) x;
$function$;

CREATE OR REPLACE FUNCTION public.falcon_settings()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'tiers', tiers,
    'tiers_updated_at', tiers_updated_at,
    'tiers_updated_by_falcon', tiers_updated_by_falcon,
    'packs', packs,
    'packs_updated_at', packs_updated_at,
    'packs_updated_by_falcon', packs_updated_by_falcon,
    'auto_topup_pack_id', auto_topup_pack_id)
    FROM public.ai_billing WHERE id;
$function$;

CREATE OR REPLACE FUNCTION public.falcon_credits_adjust(p_credits numeric, p_reason text, p_operator text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _id bigint;
BEGIN
  IF NOT public.falcon_operator_ok(p_operator) THEN
    RAISE EXCEPTION 'operator must be a falconmarketing.com address' USING ERRCODE = '22023';
  END IF;
  IF p_credits IS NULL OR p_credits = 0 OR abs(p_credits) > 100000000 THEN
    RAISE EXCEPTION 'credits must be a non-zero amount' USING ERRCODE = '22023';
  END IF;
  IF length(btrim(COALESCE(p_reason, ''))) NOT BETWEEN 3 AND 300 THEN
    RAISE EXCEPTION 'a reason of 3 to 300 characters is required' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.ai_credit_ledger (kind, credits, reason, source, falcon_operator)
  VALUES ('adjustment', round(p_credits, 6), btrim(p_reason), 'falcon_console', p_operator)
  RETURNING id INTO _id;
  RETURN jsonb_build_object('id', _id, 'balance', (SELECT round(balance, 4) FROM public.ai_billing WHERE id));
END;
$function$;

CREATE OR REPLACE FUNCTION public.falcon_set_tiers(p_tiers jsonb, p_operator text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.falcon_operator_ok(p_operator) THEN
    RAISE EXCEPTION 'operator must be a falconmarketing.com address' USING ERRCODE = '22023';
  END IF;
  IF NOT public.ai_billing_tiers_valid(p_tiers) THEN
    RAISE EXCEPTION 'invalid tiers' USING ERRCODE = '22023';
  END IF;
  -- Applies to usage from now on. Past ledger rows are never re-priced.
  UPDATE public.ai_billing SET tiers = p_tiers, tiers_updated_at = now(), tiers_updated_by_falcon = p_operator WHERE id;
  RETURN (SELECT jsonb_build_object('tiers', tiers, 'updated_at', tiers_updated_at) FROM public.ai_billing WHERE id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.falcon_set_packs(p_packs jsonb, p_operator text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _auto text;
BEGIN
  IF NOT public.falcon_operator_ok(p_operator) THEN
    RAISE EXCEPTION 'operator must be a falconmarketing.com address' USING ERRCODE = '22023';
  END IF;
  IF NOT public.ai_credit_packs_valid(p_packs) THEN
    RAISE EXCEPTION 'invalid packs' USING ERRCODE = '22023';
  END IF;
  SELECT auto_topup_pack_id INTO _auto FROM public.ai_billing WHERE id FOR UPDATE;
  IF _auto IS NOT NULL AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_packs) e WHERE e ->> 'id' = _auto) THEN
    RAISE EXCEPTION 'pack % is used by automatic top-up; keep it', _auto USING ERRCODE = '22023';
  END IF;
  UPDATE public.ai_billing SET packs = p_packs, packs_updated_at = now(), packs_updated_by_falcon = p_operator WHERE id;
  RETURN (SELECT jsonb_build_object('packs', packs, 'updated_at', packs_updated_at) FROM public.ai_billing WHERE id);
END;
$function$;

-- ═════════════════════════════════════════════════════════ 8. ACCESS

-- Tables: RLS on, no policies, no direct access for anon or signed-in users.
-- Only the SECURITY DEFINER functions above write. The service role may read
-- ai_billing (the ai-credits function reads the packs and Stripe customer).
ALTER TABLE public.ai_billing             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_credit_ledger       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.falcon_bridge_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_billing, public.ai_credit_ledger, public.falcon_bridge_requests
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.ai_billing TO service_role;

-- Functions: Supabase grants EXECUTE on new functions to anon and
-- authenticated by default, so revoke from everyone, then grant back only
-- what each caller needs.
REVOKE ALL ON FUNCTION
  public.can_manage_ai_credits(uuid),
  public.ai_credits_notify(text, numeric, text),
  public.ai_billing_tiers_valid(jsonb),
  public.ai_credit_packs_valid(jsonb),
  public.ai_usage_apply_tiers(numeric, jsonb),
  public.falcon_month_bounds(date),
  public.falcon_operator_ok(text),
  public.ai_credit_ledger_append_only(),
  public.ai_credits_check_alerts(),
  public.ai_credits_after_ledger(),
  public.ai_usage_record(text, text, bigint, bigint, numeric, boolean),
  public.ai_credits_balance(),
  public.ai_credits_overview(),
  public.ai_credits_set_auto_topup(boolean, text, bigint),
  public.ai_credits_grant_topup(text, text, bigint, bigint, text, text, uuid, text),
  public.ai_credits_save_customer(text),
  public.ai_credits_save_card(text, text, text, text, uuid),
  public.ai_credits_claim_auto_topup(),
  public.ai_credits_auto_topup_failed(text, uuid, text),
  public.falcon_bridge_claim(uuid, text, text),
  public.falcon_overview(),
  public.falcon_usage_month(date),
  public.falcon_money_month(date),
  public.falcon_ledger(bigint, integer, text),
  public.falcon_settings(),
  public.falcon_credits_adjust(numeric, text, text),
  public.falcon_set_tiers(jsonb, text),
  public.falcon_set_packs(jsonb, text)
FROM PUBLIC, anon, authenticated, service_role;

-- The app (signed-in users; each function checks can_manage_ai_credits itself).
GRANT EXECUTE ON FUNCTION
  public.ai_credits_overview(),
  public.ai_credits_set_auto_topup(boolean, text, bigint)
TO authenticated;

-- Server code (service role): metering, Stripe functions, falcon-bridge.
GRANT EXECUTE ON FUNCTION
  public.can_manage_ai_credits(uuid),
  public.ai_usage_record(text, text, bigint, bigint, numeric, boolean),
  public.ai_credits_balance(),
  public.ai_credits_grant_topup(text, text, bigint, bigint, text, text, uuid, text),
  public.ai_credits_save_customer(text),
  public.ai_credits_save_card(text, text, text, text, uuid),
  public.ai_credits_claim_auto_topup(),
  public.ai_credits_auto_topup_failed(text, uuid, text),
  public.falcon_bridge_claim(uuid, text, text),
  public.falcon_overview(),
  public.falcon_usage_month(date),
  public.falcon_money_month(date),
  public.falcon_ledger(bigint, integer, text),
  public.falcon_settings(),
  public.falcon_credits_adjust(numeric, text, text),
  public.falcon_set_tiers(jsonb, text),
  public.falcon_set_packs(jsonb, text)
TO service_role;

-- ═════════════════════════════════════════════════════════ 9. READ-BACK (rolls back if wrong)

DO $readback$
DECLARE
  _tiers jsonb;
BEGIN
  IF (SELECT balance FROM public.ai_billing WHERE id) <> 0 THEN
    RAISE EXCEPTION 'AI credits must open at 0 (the console grants the opening balance) — rolled back';
  END IF;
  -- Marginal charging telescopes: $300 then $400 raw = 60,000 + 60,000 = tiers($700).
  SELECT tiers INTO _tiers FROM public.ai_billing WHERE id;
  IF public.ai_usage_apply_tiers(30000, _tiers) + (public.ai_usage_apply_tiers(70000, _tiers) - public.ai_usage_apply_tiers(30000, _tiers))
     <> public.ai_usage_apply_tiers(70000, _tiers) THEN
    RAISE EXCEPTION 'tier maths does not add up — rolled back';
  END IF;
  IF has_table_privilege('authenticated', 'public.ai_credit_ledger', 'SELECT')
     OR has_table_privilege('service_role', 'public.ai_credit_ledger', 'INSERT')
     OR has_table_privilege('authenticated', 'public.ai_billing', 'SELECT')
     OR has_function_privilege('anon', 'public.ai_credits_overview()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.ai_usage_record(text, text, bigint, bigint, numeric, boolean)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.falcon_credits_adjust(numeric, text, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.ai_credits_grant_topup(text, text, bigint, bigint, text, text, uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'AI billing access is wider than intended — rolled back';
  END IF;
  RAISE NOTICE 'AI billing ready: balance 0, enforcement off until AI_CREDITS_ENFORCED=true';
END
$readback$;
