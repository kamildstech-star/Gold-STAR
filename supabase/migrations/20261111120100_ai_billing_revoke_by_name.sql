-- AI billing: the same REVOKE as 20261111120000_ai_billing.sql section 8,
-- written one function per statement. That migration revokes everything in a
-- single REVOKE listing all the functions, which the database applies
-- correctly (its read-back checks it) but the repo's anon-surface guard
-- (src/lib/security/migration-surface.ts) only recognises per function. No
-- change in the database: every line here is already true.
--
-- Also closes the two raffle trigger functions from 20261110210000, which the
-- same guard flagged: trigger functions are never called directly, so
-- nobody needs EXECUTE on them.

REVOKE ALL ON FUNCTION public.can_manage_ai_credits(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ai_credits_notify(text, numeric, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ai_billing_tiers_valid(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ai_credit_packs_valid(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ai_usage_apply_tiers(numeric, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.falcon_month_bounds(date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.falcon_operator_ok(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ai_credit_ledger_append_only() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ai_credits_check_alerts() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ai_credits_after_ledger() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ai_usage_record(text, text, bigint, bigint, numeric, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ai_credits_balance() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ai_credits_overview() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ai_credits_set_auto_topup(boolean, text, bigint) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ai_credits_grant_topup(text, text, bigint, bigint, text, text, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ai_credits_save_customer(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ai_credits_save_card(text, text, text, text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ai_credits_claim_auto_topup() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ai_credits_auto_topup_failed(text, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.falcon_bridge_claim(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.falcon_overview() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.falcon_usage_month(date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.falcon_money_month(date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.falcon_ledger(bigint, integer, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.falcon_settings() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.falcon_credits_adjust(numeric, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.falcon_set_tiers(jsonb, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.falcon_set_packs(jsonb, text) FROM PUBLIC, anon;

REVOKE ALL ON FUNCTION public.tg_raffle_prize_guard() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.tg_raffle_winner_status() FROM PUBLIC, anon;
