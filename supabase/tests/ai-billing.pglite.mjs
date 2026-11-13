// Run with: node supabase/tests/ai-billing.pglite.mjs <existing PGlite dist/index.js>
//
// The Falcon AI billing kit's own check (reference/tests/ai-billing-sql.check.mjs),
// run against GSR's migration 20261111120000_ai_billing.sql: charging, top-ups,
// alerts, auto top-up, the console bridge shapes and who may call what. Before
// the kit swaps in its test doubles for the two project hooks, GSR's real hooks
// are checked too: Owner/Admin/Developer may manage, a warning reaches every
// Owner and Admin in the bell.
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const { PGlite } = await import(pathToFileURL(process.argv[2]).href)
const MIGRATION = readFileSync(new URL('../migrations/20261111120000_ai_billing.sql', import.meta.url), 'utf8')
const BY_USER = readFileSync(new URL('../migrations/20261111130000_ai_billing_usage_by_user.sql', import.meta.url), 'utf8')

const ADMIN = 'a0000000-0000-4000-8000-000000000001'
const OTHER = 'a0000000-0000-4000-8000-000000000002'
const OWNER = 'owner@falconmarketing.com'

// A stand-in for the bits of Supabase the migration relies on, including its
// default grants (new tables and functions are open to anon/authenticated).
const SUPABASE = `
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
INSERT INTO auth.users VALUES ('${ADMIN}', 'admin@client.test'), ('${OTHER}', 'user@client.test');
-- GSR tables the project hooks use.
CREATE TABLE public.user_roles (user_id uuid NOT NULL, role text NOT NULL);
CREATE TYPE public.notification_type AS ENUM ('automation_escalation');
CREATE TYPE public.notification_priority AS ENUM ('low', 'normal', 'high', 'urgent');
CREATE TABLE public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL,
  type public.notification_type NOT NULL, title text NOT NULL, body text,
  entity_type text, entity_id uuid, href text,
  priority public.notification_priority NOT NULL DEFAULT 'normal');
CREATE TABLE public.profiles (user_id uuid PRIMARY KEY, full_name text, email text);
`

// Contract keys (contract/console-types.ts).
const OVERVIEW_KEYS = ['alerts_sent', 'auto_topup', 'balance', 'last_topup_at', 'last_topup_credits', 'last_usage_at', 'month',
  'raw_cents_this_month', 'used_last_7_days', 'used_last_month', 'used_this_month']
const AUTO_KEYS = ['card_on_file', 'enabled', 'failed_at', 'failure', 'pack_id', 'pending_since', 'threshold_credits']
const USAGE_KEYS = ['billed_cents', 'billed_cents_by_current_tiers', 'by_day', 'by_feature', 'month', 'non_billable_raw_cents',
  'previous_billed_cents', 'previous_raw_cents', 'raw_cents', 'tiers']
const FEATURE_KEYS = ['audio_seconds', 'billable', 'billed_cents', 'calls', 'feature', 'input_tokens', 'model', 'output_tokens', 'raw_cents']
const DAY_KEYS = ['billed_cents', 'calls', 'day', 'raw_cents']
const MONEY_KEYS = ['balance', 'lifetime', 'month', 'month_totals', 'purchases']
const TOTALS_KEYS = ['deducted_credits', 'granted_credits', 'paid_cents', 'purchase_count', 'purchased_credits', 'raw_cents', 'used_credits']
const LEDGER_KEYS = ['amount_paid_cents', 'at', 'by', 'credits', 'falcon_operator', 'has_receipt', 'id', 'kind', 'pack_id', 'reason', 'source']
const SETTINGS_KEYS = ['auto_topup_pack_id', 'packs', 'packs_updated_at', 'packs_updated_by_falcon', 'tiers', 'tiers_updated_at', 'tiers_updated_by_falcon']
const keys = (o) => Object.keys(o).sort()

const db = new PGlite()
const q = async (sql, params = []) => (await db.query(sql, params)).rows
const one = async (sql, params = []) => (await q(sql, params))[0]
const val = async (sql, params = []) => Object.values(await one(sql, params))[0]
const fails = async (p, pattern) => {
  try { await p } catch (e) { if (pattern) assert.match(String(e.message), pattern); return }
  assert.fail(`expected an error${pattern ? ` matching ${pattern}` : ''}`)
}
async function as(role, uid, fn) {
  await db.exec(`SELECT set_config('request.jwt.claim.sub', '${uid ?? ''}', false); SET ROLE ${role};`)
  try { return await fn() } finally { await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claim.sub', '', false);`) }
}
const svc = (sql, params) => as('service_role', null, () => val(sql, params))
const balance = async () => Number(await val('SELECT balance FROM public.ai_billing'))
const record = (feature, cost, billable = true, model = 'gpt-test') =>
  svc('SELECT public.ai_usage_record($1, $2, 100, 50, $3, $4)', [feature, model, cost, billable])

let passed = 0
async function check(name, fn) {
  await fn()
  passed++
  console.log(`  ok  ${name}`)
}

await db.exec(SUPABASE)
await db.exec(MIGRATION)

// GSR's own hooks, before the kit replaces them with test doubles.
const DEV = 'a0000000-0000-4000-8000-000000000003'
const REP = 'a0000000-0000-4000-8000-000000000004'
await db.exec(`INSERT INTO public.user_roles VALUES
  ('${ADMIN}', 'admin'), ('${OTHER}', 'owner'), ('${DEV}', 'dev'), ('${REP}', 'sales_rep')`)
await check('GSR: Owner, Admin and Developer may manage AI credits; a sales rep may not', async () => {
  for (const [id, ok] of [[ADMIN, true], [OTHER, true], [DEV, true], [REP, false]]) {
    assert.equal(await val(`SELECT public.can_manage_ai_credits('${id}')`), ok)
  }
  assert.equal(await val('SELECT public.can_manage_ai_credits(NULL)'), false)
})
await check('GSR: a warning reaches every Owner and Admin in the bell, not developers', async () => {
  await db.exec(`SELECT public.ai_credits_notify('0', 0, NULL)`)
  const rows = await q('SELECT user_id::text, priority::text, href FROM public.notifications ORDER BY user_id')
  assert.deepEqual(rows.map((r) => r.user_id), [ADMIN, OTHER])
  assert.ok(rows.every((r) => r.priority === 'urgent' && r.href === '/admin/ai-credits'))
  await db.exec(`SELECT public.ai_credits_notify('25', 2500, NULL)`)
  assert.equal(await val(`SELECT count(*)::int FROM public.notifications WHERE priority = 'high'`), 2)
  await db.exec('DELETE FROM public.notifications; DELETE FROM public.user_roles')
})
// Test doubles for the two project hooks: ADMIN may manage; warnings are captured.
await db.exec(`
  CREATE TABLE public._notes (level text, balance numeric, detail text);
  CREATE OR REPLACE FUNCTION public.can_manage_ai_credits(_user_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$ SELECT _user_id = '${ADMIN}'::uuid $$;
  CREATE OR REPLACE FUNCTION public.ai_credits_notify(_level text, _balance numeric, _detail text DEFAULT NULL) RETURNS void
    LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $$ INSERT INTO public._notes VALUES (_level, _balance, _detail) $$;
`)

await check('opens at balance 0 with the starting tiers and packs', async () => {
  assert.equal(await balance(), 0)
  assert.equal((await val('SELECT jsonb_array_length(tiers) FROM public.ai_billing')), 3)
  assert.equal((await val('SELECT jsonb_array_length(packs) FROM public.ai_billing')), 4)
})

await check('a billable call is charged at the marginal tier (150¢ raw ×2 = 300 credits)', async () => {
  const r = await record('summary', 150)
  assert.equal(Number(r.credits), 300)
  assert.equal(await balance(), -300)
})

await check('crossing a tier boundary charges each band at its own rate, and the month adds up', async () => {
  const r = await record('summary', 29900) // month raw 150 → 30,050
  // tiers(30,050) − tiers(150) = (60,000 + 50×1.5) − 300
  assert.equal(Number(r.credits), 59775)
  const used = Number(await val("SELECT -sum(credits) FROM public.ai_credit_ledger WHERE kind = 'usage'"))
  const expected = Number(await val('SELECT public.ai_usage_apply_tiers(30050, tiers) FROM public.ai_billing'))
  assert.equal(used, expected)
})

await check('a non-billable call is recorded at cost but charges nothing', async () => {
  const before = await balance()
  const r = await record('dev_tooling', 1000, false)
  assert.equal(Number(r.credits), 0)
  assert.equal(await balance(), before)
})

await check('a new month starts pricing from the first band again', async () => {
  await db.exec("UPDATE public.ai_billing SET month_start = month_start - interval '1 month'")
  const r = await record('summary', 100)
  assert.equal(Number(r.credits), 200)
})

await check('console grant: needs a console operator, a non-zero amount and a reason', async () => {
  await fails(svc("SELECT public.falcon_credits_adjust(100, 'Opening balance', 'x@client.test')"), /operator/)
  await fails(svc(`SELECT public.falcon_credits_adjust(0, 'Opening balance', '${OWNER}')`), /non-zero/)
  await fails(svc(`SELECT public.falcon_credits_adjust(100, 'x', '${OWNER}')`), /reason/)
  const before = await balance()
  const r = await svc(`SELECT public.falcon_credits_adjust(100000, 'Opening balance', '${OWNER}')`)
  assert.equal(Number(r.balance), before + 100000)
})

await check('Stripe top-up: granted once per event and once per payment', async () => {
  const before = await balance()
  const grant = (evt, pi) => svc(
    `SELECT public.ai_credits_grant_topup($1, $2, 10000, 10000, 'pack_100', 'https://pay.stripe.com/r/1', '${ADMIN}', 'checkout')`, [evt, pi])
  assert.equal((await grant('evt_1', 'pi_1')).granted, true)
  assert.equal((await grant('evt_1', 'pi_1')).granted, false)
  assert.equal((await grant('evt_2', 'pi_1')).granted, false)
  assert.equal(await balance(), before + 10000)
  assert.equal(Number(await val('SELECT last_topup_credits FROM public.ai_billing')), 10000)
})

await check('low-balance warnings fire once at 25 %, 10 % and zero of the last top-up', async () => {
  // A flat ×1 rate, so spending N raw cents removes exactly N credits.
  await svc(`SELECT public.falcon_set_tiers('[{"up_to_cents": null, "multiplier": 1}]', '${OWNER}')`)
  const spendTo = async (target) => {
    const b = await balance()
    if (b > target) await record('summary', b - target)
  }
  // The last refill was the 10,000-credit pack, so the warnings are at 2,500, 1,000 and 0.
  await db.exec('DELETE FROM public._notes')
  await spendTo(2600)
  assert.equal((await q('SELECT 1 FROM public._notes')).length, 0)
  await spendTo(2400)
  await spendTo(2300)
  await spendTo(900)
  await spendTo(0)
  const levels = (await q('SELECT level FROM public._notes')).map((r) => r.level)
  assert.deepEqual(levels, ['25', '10', '0'])
})

await check('the ledger is append-only', async () => {
  await fails(db.exec('UPDATE public.ai_credit_ledger SET credits = 0'), /append-only/)
  await fails(db.exec('DELETE FROM public.ai_credit_ledger'), /append-only/)
})

await check('no direct table access for anyone; the service role reads ai_billing only', async () => {
  for (const role of ['anon', 'authenticated']) {
    await fails(as(role, ADMIN, () => q('SELECT * FROM public.ai_credit_ledger')), /permission denied/)
    await fails(as(role, ADMIN, () => q('SELECT * FROM public.ai_billing')), /permission denied/)
  }
  await fails(as('service_role', null, () => q("INSERT INTO public.ai_credit_ledger (kind, credits, reason, falcon_operator) VALUES ('adjustment', 5, 'free', 'a@falconmarketing.com')")), /permission denied/)
  assert.ok(await as('service_role', null, () => one('SELECT packs, stripe_customer_id FROM public.ai_billing')))
})

await check('signed-in users cannot record usage, grant credits or call the console functions', async () => {
  await fails(as('authenticated', ADMIN, () => q("SELECT public.ai_usage_record('summary', 'm', 1, 1, 1, true)")), /permission denied/)
  await fails(as('authenticated', ADMIN, () => q(`SELECT public.falcon_credits_adjust(5, 'free credits', '${OWNER}')`)), /permission denied/)
  await fails(as('authenticated', ADMIN, () => q(`SELECT public.ai_credits_grant_topup('e', 'p', 5, 5, NULL, NULL, NULL, 'checkout')`)), /permission denied/)
  await fails(as('authenticated', ADMIN, () => q('SELECT public.falcon_overview()')), /permission denied/)
  await fails(as('anon', null, () => q('SELECT public.ai_credits_overview()')), /permission denied/)
})

await check('the app page: allowed users only, credits only (no raw cost or tiers)', async () => {
  await fails(as('authenticated', OTHER, () => q('SELECT public.ai_credits_overview()')), /not permitted/)
  const o = await as('authenticated', ADMIN, () => val('SELECT public.ai_credits_overview()'))
  assert.deepEqual(keys(o), ['auto_topup', 'balance', 'history', 'last_topup_credits', 'month', 'packs', 'used_last_month', 'used_this_month'])
  assert.ok(!JSON.stringify(o).includes('raw_cost') && !JSON.stringify(o).includes('multiplier'))
})

await check('automatic top-up: due, claimed once, failure warns once and is cleared by saving again', async () => {
  await svc("SELECT public.ai_credits_save_customer('cus_TEST1')")
  await svc(`SELECT public.ai_credits_save_card('cus_TEST1', 'pm_TEST1', 'visa', '4242', '${ADMIN}')`)
  await fails(as('authenticated', OTHER, () => q("SELECT public.ai_credits_set_auto_topup(true, 'pack_100', 5000)")), /not permitted/)
  await as('authenticated', ADMIN, () => q("SELECT public.ai_credits_set_auto_topup(true, 'pack_100', 5000)"))
  const r = await record('summary', 1)
  assert.equal(r.auto_topup_due, true)
  const claim = await svc('SELECT public.ai_credits_claim_auto_topup()')
  assert.equal(claim.pack.id, 'pack_100')
  assert.equal(claim.customer_id, 'cus_TEST1')
  assert.equal(await svc('SELECT public.ai_credits_claim_auto_topup()'), null) // one in flight
  await db.exec('DELETE FROM public._notes')
  await svc(`SELECT public.ai_credits_auto_topup_failed('evt_f', '${claim.attempt_id}', 'card_declined')`)
  await svc(`SELECT public.ai_credits_auto_topup_failed('evt_f', '${claim.attempt_id}', 'card_declined')`)
  assert.equal((await q("SELECT 1 FROM public._notes WHERE level = 'failed'")).length, 1)
  assert.ok(await val('SELECT auto_topup_failed_at FROM public.ai_billing'))
  assert.equal((await record('summary', 1)).auto_topup_due, false)
  await as('authenticated', ADMIN, () => q("SELECT public.ai_credits_set_auto_topup(true, 'pack_100', 5000)"))
  assert.equal(await val('SELECT auto_topup_failed_at FROM public.ai_billing'), null)
  // A paid auto top-up clears the in-flight marker.
  const claim2 = await svc('SELECT public.ai_credits_claim_auto_topup()')
  assert.ok(claim2)
  await svc(`SELECT public.ai_credits_grant_topup('evt_a', 'pi_a', 10000, 10000, 'pack_100', NULL, NULL, 'auto_topup')`)
  assert.equal(await val('SELECT auto_topup_pending_since FROM public.ai_billing'), null)
})

await check('console tiers and packs: validated; the auto top-up pack cannot be removed', async () => {
  await fails(svc(`SELECT public.falcon_set_tiers('[{"up_to_cents": 100, "multiplier": 2}]', '${OWNER}')`), /invalid tiers/)
  const t = await svc(`SELECT public.falcon_set_tiers('[{"up_to_cents": null, "multiplier": 1.5}]', '${OWNER}')`)
  assert.equal(t.tiers[0].multiplier, 1.5)
  await fails(svc(`SELECT public.falcon_set_packs('[{"id": "pack_x", "price_cents": 1000, "credits": 1000}]', '${OWNER}')`), /auto/)
  const p = await svc(`SELECT public.falcon_set_packs('[{"id": "pack_100", "price_cents": 10000, "credits": 10500}]', '${OWNER}')`)
  assert.equal(p.packs[0].credits, 10500)
  const s = await svc('SELECT public.falcon_settings()')
  assert.deepEqual(keys(s), SETTINGS_KEYS)
  assert.equal(s.packs_updated_by_falcon, OWNER)
})

await check('console read shapes match the bridge contract', async () => {
  const o = await svc('SELECT public.falcon_overview()')
  assert.deepEqual(keys(o), OVERVIEW_KEYS)
  assert.deepEqual(keys(o.auto_topup), AUTO_KEYS)
  const u = await svc('SELECT public.falcon_usage_month(NULL)')
  assert.deepEqual(keys(u), USAGE_KEYS)
  assert.deepEqual(keys(u.by_feature[0]), FEATURE_KEYS)
  assert.deepEqual(keys(u.by_day[0]), DAY_KEYS)
  assert.ok(u.non_billable_raw_cents > 0)
  const m = await svc('SELECT public.falcon_money_month(NULL)')
  assert.deepEqual(keys(m), MONEY_KEYS)
  assert.deepEqual(keys(m.month_totals), TOTALS_KEYS)
  assert.deepEqual(keys(m.lifetime), [...TOTALS_KEYS, 'first_at'].sort())
  const l = await svc("SELECT public.falcon_ledger(NULL, 5, 'topup')")
  assert.deepEqual(keys(l[0]), LEDGER_KEYS)
  const bought = (await svc("SELECT public.falcon_ledger(NULL, 200, 'topup')")).find((r) => r.pack_id && r.by)
  assert.equal(bought.by, 'admin@client.test')
  const adj = (await svc("SELECT public.falcon_ledger(NULL, 5, 'adjustment')"))[0]
  assert.equal(adj.by, OWNER)
})

await check('bridge replay guard: a request id is accepted once', async () => {
  const id = 'c0000000-0000-4000-8000-000000000001'
  assert.equal(await svc(`SELECT public.falcon_bridge_claim('${id}', 'overview', NULL)`), true)
  assert.equal(await svc(`SELECT public.falcon_bridge_claim('${id}', 'overview', NULL)`), false)
})

// GSR: who spent the credits (migration 20261111130000), applied on top.
await db.exec(BY_USER)
await check('GSR: usage carries its user; the header chip lists this month per person', async () => {
  await db.exec(`INSERT INTO public.profiles VALUES ('${ADMIN}', 'Ada Admin', 'admin@client.test')`)
  // The six-argument call the live server sent before still works.
  await record('general', 10)
  await svc(`SELECT public.ai_usage_record('polaris', 'gpt-test', 1, 1, 50, true, '${ADMIN}')`)
  await svc(`SELECT public.ai_usage_record('polaris', 'gpt-test', 1, 1, 25, true, '${OTHER}')`)
  const o = await as('authenticated', ADMIN, () => val('SELECT public.ai_credits_usage_by_user()'))
  assert.deepEqual(keys(o), ['balance', 'last_topup_credits', 'month', 'used_last_month', 'used_this_month', 'users'])
  const by = Object.fromEntries(o.users.map((u) => [u.user_id ?? 'none', u]))
  assert.equal(by[ADMIN].name, 'Ada Admin')
  assert.equal(by[OTHER].name, 'Former user')
  assert.equal(by.none.name, null)
  assert.ok(by[ADMIN].credits > 0)
  // Per-person rows round separately, so they add up to the month within a credit each.
  const sum = o.users.reduce((t, u) => t + Number(u.credits), 0)
  assert.ok(Math.abs(sum - Number(o.used_this_month)) <= o.users.length)
  await fails(as('authenticated', OTHER, () => val('SELECT public.ai_credits_usage_by_user()')), /not permitted/)
  await fails(as('anon', null, () => val('SELECT public.ai_credits_usage_by_user()')))
  await fails(as('authenticated', ADMIN, () =>
    val(`SELECT public.ai_usage_record('polaris', 'x', 1, 1, 1, true, '${ADMIN}')`)))
})

await db.close()
console.log(`ai-billing.pglite: ${passed} checks passed`)
