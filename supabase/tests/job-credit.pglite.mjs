// Run with: node supabase/tests/job-credit.pglite.mjs <PGlite dist/index.js>
// In-memory fixtures only. No connection string, network access or live writes.
//
// Commission by account stage at job arrival (20261110180000). Melly: "A job
// that comes in attached to a rep pays that rep, based on where the account
// was sitting when the job arrived. If the account was in Ready or Active
// Outreach, the manager approves or declines. If it was in Conversation
// Established or already a client, it pays automatically. ... Credit locks
// the day the job is signed. Losing an account only affects future jobs."
//
// The migration is READ FROM THE FILE, so the trigger and the engine under
// test are the ones that ship. The tables around them are the smallest stubs
// that let the two functions run.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
const migration = readFileSync(
  new URL("../migrations/20261110180000_job_credit_at_arrival.sql", import.meta.url),
  "utf8",
);

let assertions = 0;
const check = (value, what) => {
  assert.equal(value, true, what);
  assertions++;
};
const one = async (sql) => (await db.query(sql)).rows[0];

const rep = "11111111-1111-4111-8111-111111111111";
const rep2 = "22222222-2222-4222-8222-222222222222";
const dispatch = "33333333-3333-4333-8333-333333333333";
const manager = "44444444-4444-4444-8444-444444444444";
const office = "66666666-6666-4666-8666-666666666666";
const pipeline = "77777777-7777-4777-8777-777777777777";
const stage = (n) => `aaaaaaaa-aaaa-4aaa-8aaa-00000000000${n}`;
const acct = (n) => `bbbbbbbb-bbbb-4bbb-8bbb-00000000000${n}`;
const job = (n) => `cccccccc-cccc-4ccc-8ccc-00000000000${n}`;

try {
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    INSERT INTO auth.users VALUES ('${rep}'), ('${rep2}'), ('${dispatch}'), ('${manager}');

    CREATE TABLE public.pipeline_stages (id uuid PRIMARY KEY, pipeline_id uuid, key text, is_active boolean DEFAULT true);
    INSERT INTO public.pipeline_stages VALUES
      ('${stage(1)}', '${pipeline}', 'ready', true),
      ('${stage(2)}', '${pipeline}', 'active_outreach', true),
      ('${stage(3)}', '${pipeline}', 'conversation_established', true),
      ('${stage(4)}', '${pipeline}', 'active_client', true);

    CREATE TABLE public.accounts (
      id uuid PRIMARY KEY, name text, assigned_rep uuid, status text DEFAULT 'prospect',
      health_stage_id uuid, stage text, stage_id uuid, location_id uuid
    );
    INSERT INTO public.accounts (id, name, assigned_rep, status, stage, stage_id, location_id) VALUES
      ('${acct(1)}', 'Outreach Co', '${rep}', 'prospect', 'active_outreach', '${stage(2)}', '${office}'),
      ('${acct(2)}', 'Client Co',   '${rep}', 'active',   'active_client',   '${stage(4)}', '${office}'),
      ('${acct(3)}', 'Talking Co',  '${rep}', 'prospect', 'conversation_established', '${stage(3)}', '${office}'),
      ('${acct(4)}', 'Nobody Co',   NULL,     'prospect', 'ready',           '${stage(1)}', '${office}');

    CREATE TABLE public.jobs (
      id uuid PRIMARY KEY, account_id uuid, location_id uuid, status text DEFAULT 'new',
      created_by uuid, created_at timestamptz DEFAULT now(), start_date date, completion_date date,
      billed_amount numeric, approved_amount numeric, agreed_price numeric, collected_amount numeric,
      is_demo boolean DEFAULT false
    );
    CREATE TABLE public.job_assignments (job_id uuid, role text, user_id uuid);
    CREATE TABLE public.job_cost_lines (job_id uuid, direct_cost numeric, materials_cost numeric, subcontractor_cost numeric, equipment_cost numeric);
    CREATE TABLE public.commission_plans (
      id uuid DEFAULT gen_random_uuid(), user_id uuid, basis text DEFAULT 'billed', rate_percent numeric,
      flat_amount numeric, work_component text, note text, effective_from date DEFAULT '2020-01-01', effective_to date
    );
    INSERT INTO public.commission_plans (user_id, basis, rate_percent) VALUES ('${rep}', 'billed', 10), ('${rep2}', 'billed', 10), ('${dispatch}', 'billed', 5);
    CREATE TABLE public.commission_tiers (
      key text, active boolean, min_amount numeric, work_component text, effective_from date, effective_to date,
      rate_percent numeric, sort_order int
    );
    CREATE TABLE public.commission_payouts (
      id uuid DEFAULT gen_random_uuid() PRIMARY KEY, user_id uuid, location_id uuid, kind text, amount numeric,
      status text, approved_at timestamptz, approved_by uuid, period_start date, period_end date, job_id uuid,
      basis text, basis_amount numeric, rate_percent numeric, split_percent numeric, tier_key text,
      expected_pay_date date, source text, note text, is_demo boolean, updated_at timestamptz DEFAULT now()
    );
    CREATE UNIQUE INDEX commission_payouts_job_user_kind ON public.commission_payouts (job_id, user_id, kind) WHERE job_id IS NOT NULL;
  `);

  await db.exec(migration);

  // The engine's trigger (20260820084452), reproduced so money moves re-run it.
  await db.exec(`
    CREATE FUNCTION public.jobs_commission_sync() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM public.compute_job_commissions(NEW.id); RETURN NEW; END $$;
    CREATE TRIGGER jobs_commission_sync_trg AFTER INSERT OR UPDATE OF status, collected_amount, billed_amount, approved_amount, agreed_price
      ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.jobs_commission_sync();
  `);

  /* ---- 1. Active Outreach: credited to the rep, waits for the manager ---- */
  await db.exec(`INSERT INTO public.jobs (id, account_id, location_id, created_by, billed_amount)
                 VALUES ('${job(1)}', '${acct(1)}', '${office}', '${dispatch}', 10000)`);
  let j = await one(`SELECT credit_rep_id, credit_stage_key, credit_requires_approval, credit_locked_at FROM public.jobs WHERE id = '${job(1)}'`);
  check(j.credit_rep_id === rep, "the job is credited to the account's rep, not to dispatch who created it");
  check(j.credit_stage_key === "active_outreach", "the stage at arrival is snapshotted");
  check(j.credit_requires_approval === true, "Active Outreach needs the manager");
  check(j.credit_locked_at !== null, "the credit is locked at arrival");

  let p = await one(`SELECT user_id, status, amount, approved_by FROM public.commission_payouts WHERE job_id = '${job(1)}'`);
  check(p.user_id === rep, "the engine pays the credited rep");
  check(p.status === "pending", "and the payout waits for approval");
  check(Number(p.amount) === 1000, "10% of 10,000");
  check((await one(`SELECT count(*)::int AS n FROM public.commission_payouts WHERE job_id = '${job(1)}' AND user_id = '${dispatch}'`)).n === 0,
    "dispatch, who created the job, is not paid");

  /* ---- 2. Losing the account only affects future jobs ------------------- */
  await db.exec(`UPDATE public.accounts SET assigned_rep = '${rep2}' WHERE id = '${acct(1)}'`);
  await db.exec(`UPDATE public.jobs SET billed_amount = 12000 WHERE id = '${job(1)}'`);
  j = await one(`SELECT credit_rep_id FROM public.jobs WHERE id = '${job(1)}'`);
  check(j.credit_rep_id === rep, "reassigning the account leaves the signed job's credit alone");
  p = await one(`SELECT user_id, amount FROM public.commission_payouts WHERE job_id = '${job(1)}'`);
  check(p.user_id === rep && Number(p.amount) === 1200, "the payout follows the money and stays with the original rep");
  await db.exec(`UPDATE public.jobs SET credit_rep_id = '${rep2}', credit_stage_key = 'active_client' WHERE id = '${job(1)}'`);
  j = await one(`SELECT credit_rep_id, credit_stage_key FROM public.jobs WHERE id = '${job(1)}'`);
  check(j.credit_rep_id === rep && j.credit_stage_key === "active_outreach", "a direct write to the credit columns is ignored once locked");

  // The next job on that account goes to the new rep.
  await db.exec(`INSERT INTO public.jobs (id, account_id, location_id, created_by, billed_amount)
                 VALUES ('${job(2)}', '${acct(1)}', '${office}', '${dispatch}', 5000)`);
  check((await one(`SELECT credit_rep_id FROM public.jobs WHERE id = '${job(2)}'`)).credit_rep_id === rep2,
    "a job arriving after the reassignment is credited to the new rep");

  /* ---- 3. A client pays automatically, and the engine's own number follows the money ---- */
  await db.exec(`INSERT INTO public.jobs (id, account_id, location_id, created_by, billed_amount)
                 VALUES ('${job(3)}', '${acct(2)}', '${office}', '${dispatch}', 20000)`);
  j = await one(`SELECT credit_stage_key, credit_requires_approval FROM public.jobs WHERE id = '${job(3)}'`);
  check(j.credit_stage_key === "active_client" && j.credit_requires_approval === false, "an active client pays automatically");
  p = await one(`SELECT status, amount, approved_at, approved_by FROM public.commission_payouts WHERE job_id = '${job(3)}'`);
  check(p.status === "approved" && p.approved_by === null && p.approved_at !== null, "the payout starts approved by the engine, with nobody's name on it");
  await db.exec(`UPDATE public.jobs SET billed_amount = 25000 WHERE id = '${job(3)}'`);
  p = await one(`SELECT amount FROM public.commission_payouts WHERE job_id = '${job(3)}'`);
  check(Number(p.amount) === 2500, "an auto-approved payout still follows the job's money");
  await db.exec(`UPDATE public.commission_payouts SET approved_by = '${manager}' WHERE job_id = '${job(3)}'`);
  await db.exec(`UPDATE public.jobs SET billed_amount = 30000 WHERE id = '${job(3)}'`);
  p = await one(`SELECT amount FROM public.commission_payouts WHERE job_id = '${job(3)}'`);
  check(Number(p.amount) === 2500, "once a person has approved it, the number never moves again");

  /* ---- 4. Conversation Established pays automatically too ------------- */
  await db.exec(`INSERT INTO public.jobs (id, account_id, location_id, created_by, billed_amount)
                 VALUES ('${job(4)}', '${acct(3)}', '${office}', '${dispatch}', 1000)`);
  p = await one(`SELECT status FROM public.commission_payouts WHERE job_id = '${job(4)}'`);
  check(p.status === "approved", "Conversation Established pays automatically");

  /* ---- 5. No rep on the account: nothing locked, the old rule applies ---- */
  await db.exec(`INSERT INTO public.jobs (id, account_id, location_id, created_by, billed_amount)
                 VALUES ('${job(5)}', '${acct(4)}', '${office}', '${dispatch}', 4000)`);
  j = await one(`SELECT credit_rep_id, credit_locked_at FROM public.jobs WHERE id = '${job(5)}'`);
  check(j.credit_rep_id === null && j.credit_locked_at === null, "an unassigned account credits nobody and locks nothing");
  p = await one(`SELECT user_id, status FROM public.commission_payouts WHERE job_id = '${job(5)}'`);
  check(p.user_id === dispatch && p.status === "pending", "the creator is paid as before, pending as before");
  // A rep assigned before the job is first linked gets it.
  await db.exec(`UPDATE public.accounts SET assigned_rep = '${rep2}' WHERE id = '${acct(4)}'`);
  await db.exec(`UPDATE public.jobs SET account_id = '${acct(4)}' WHERE id = '${job(5)}'`);
  check((await one(`SELECT credit_rep_id FROM public.jobs WHERE id = '${job(5)}'`)).credit_rep_id === null,
    "re-saving the same account does not retroactively lock (account_id unchanged)");
  await db.exec(`INSERT INTO public.jobs (id, location_id, created_by, billed_amount) VALUES ('${job(6)}', '${office}', '${dispatch}', 100)`);
  await db.exec(`UPDATE public.jobs SET account_id = '${acct(4)}' WHERE id = '${job(6)}'`);
  check((await one(`SELECT credit_rep_id FROM public.jobs WHERE id = '${job(6)}'`)).credit_rep_id === rep2,
    "a job linked to an account later is credited at that moment");

  /* ---- 6. Cancelled: the engine's own rows go, a person's stay ---------- */
  await db.exec(`UPDATE public.jobs SET status = 'cancelled' WHERE id = '${job(4)}'`);
  check((await one(`SELECT count(*)::int AS n FROM public.commission_payouts WHERE job_id = '${job(4)}'`)).n === 0,
    "cancelling a job removes the engine's auto-approved payout");
  await db.exec(`UPDATE public.jobs SET status = 'cancelled' WHERE id = '${job(3)}'`);
  check((await one(`SELECT count(*)::int AS n FROM public.commission_payouts WHERE job_id = '${job(3)}'`)).n === 1,
    "but never a payout a person approved — there is no clawback");

  /* ---- re-runnable ------------------------------------------------------ */
  await db.exec(migration);
  check((await one(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = 'public.jobs'::regclass AND tgname = 'jobs_credit_lock'`)).n === 1,
    "replaying the migration leaves exactly one credit trigger");

  console.log(`job-credit.pglite: ${assertions} assertions passed`);
} finally {
  await db.close();
}
