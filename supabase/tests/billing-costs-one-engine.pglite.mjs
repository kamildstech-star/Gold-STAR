// Run with: node supabase/tests/billing-costs-one-engine.pglite.mjs <existing PGlite dist/index.js>
// In-memory fixtures only. No connection string, network access or live writes.
//
// Billing & Costs, prompt 5 (migration 20261103120000, READ FROM THE FILE):
// one revenue rule, one equipment-day rule and one labor rate in SQL.
//
// What it proves, to the cent:
//   1. job_revenue walks the running cost's ladder: non-draft invoices
//      (approved, else billed) → approved estimates → agreed price → sent →
//      draft estimate → cost-line revenue; a draft invoice is not revenue;
//   2. job_profitability takes that revenue, counts equipment in Eastern
//      calendar days (drop-off = day 1) instead of CEIL of 24-hour periods,
//      and leaves rejected time out of labor cost.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const ENGINE = readFileSync(
  new URL("../migrations/20261103120000_billing_costs_one_engine.sql", import.meta.url),
  "utf8",
);

let assertions = 0;
const eq = (actual, expected, what) => {
  assert.deepEqual(actual, expected, what);
  assertions++;
};

const admin = "11111111-1111-4111-8111-111111111111";
const crew = "22222222-2222-4222-8222-222222222222";
const J = (n) => `00000000-0000-4000-8000-00000000000${n}`;

const db = new PGlite();
try {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE FUNCTION public.can_view_job(_u uuid, _j uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
    CREATE FUNCTION public.can_view_job_costs(_j uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
    CREATE FUNCTION public.gsr_local_date(_at timestamptz) RETURNS date LANGUAGE sql IMMUTABLE AS
      $$ SELECT (_at AT TIME ZONE 'America/New_York')::date $$;
    -- $40/h for the crew member, from 2026-01-01.
    CREATE FUNCTION public.rate_for(_u uuid, _on date) RETURNS numeric LANGUAGE sql STABLE AS
      $$ SELECT CASE WHEN _on >= DATE '2026-01-01' THEN 40::numeric END $$;
    CREATE TABLE public.jobs (id uuid PRIMARY KEY, agreed_price numeric);
    CREATE TABLE public.invoices (id serial, job_id uuid, status text, billed_amount numeric,
      approved_amount numeric, collected_amount numeric);
    CREATE TABLE public.estimates (id serial, job_id uuid, status text, total numeric, seq int,
      updated_at timestamptz DEFAULT now());
    CREATE TABLE public.job_cost_lines (job_id uuid, revenue numeric);
    CREATE TABLE public.time_entries (job_id uuid, user_id uuid, minutes int, status text, work_date date,
      started_at timestamptz);
    CREATE TABLE public.equipment_placements (job_id uuid, placed_at timestamptz, retrieved_at timestamptz);
    SET check_function_bodies = off;
  `);
  await db.exec(ENGINE);
  await db.exec(ENGINE);
  eq(true, true, "the migration applies twice");

  await db.exec(`
    INSERT INTO public.jobs VALUES ('${J(1)}', 9000), ('${J(2)}', 9000), ('${J(3)}', 9000),
      ('${J(4)}', NULL), ('${J(5)}', NULL);
    -- 1: a sent invoice approved for less, a second billed one, a draft (not revenue).
    INSERT INTO public.invoices (job_id, status, billed_amount, approved_amount, collected_amount) VALUES
      ('${J(1)}', 'sent', 5000.00, 4625.50, 1000), ('${J(1)}', 'sent', 1200.25, NULL, 0),
      ('${J(1)}', 'draft', 9999.99, NULL, 0);
    -- 2: only a draft invoice and an approved estimate.
    INSERT INTO public.invoices (job_id, status, billed_amount) VALUES ('${J(2)}', 'draft', 7000);
    INSERT INTO public.estimates (job_id, status, total, seq) VALUES ('${J(2)}', 'approved', 6400.40, 1);
    -- 3: nothing but the agreed price (9,000.00).
    -- 4: a sent estimate beats a later draft one.
    INSERT INTO public.estimates (job_id, status, total, seq) VALUES
      ('${J(4)}', 'sent', 3100.10, 1), ('${J(4)}', 'draft', 3300.00, 2);
    -- 5: only typed cost-line revenue.
    INSERT INTO public.job_cost_lines VALUES ('${J(5)}', 750.75), ('${J(5)}', 249.25);
  `);
  const rev = async (j) => {
    const r = (await db.query(`SELECT revenue, basis FROM public.job_revenue('${j}')`)).rows[0];
    return [Number(r.revenue), r.basis];
  };
  eq(await rev(J(1)), [5825.75, "invoice"], "4,625.50 approved + 1,200.25 billed; the 9,999.99 draft is not revenue");
  eq(await rev(J(2)), [6400.4, "estimate"], "a draft invoice alone falls to the approved estimate");
  eq(await rev(J(3)), [9000, "agreed_price"], "then the agreed price");
  eq(await rev(J(4)), [3100.1, "estimate_sent"], "a sent estimate beats a later draft");
  eq(await rev(J(5)), [1000, "cost_lines"], "last, typed cost-line revenue");

  // Equipment: dropped 11 PM Eastern on the 1st, picked up 1 AM on the 3rd.
  // Calendar days: 1st, 2nd, 3rd = 3. The old CEIL(24h periods) said 2.
  // Labor: 6 h approved + 2 h rejected at $40 → 240.00, not 320.00.
  await db.exec(`
    INSERT INTO public.equipment_placements VALUES
      ('${J(1)}', '2026-10-02 03:00:00+00', '2026-10-03 05:00:00+00');
    INSERT INTO public.time_entries VALUES
      ('${J(1)}', '${crew}', 360, 'approved', '2026-10-02', NULL),
      ('${J(1)}', '${crew}', 120, 'rejected', '2026-10-02', NULL);
  `);
  await db.exec(`SET request.jwt.claim.sub = '${admin}'`);
  const p = (await db.query(`SELECT * FROM public.job_profitability('${J(1)}')`)).rows[0];
  eq(p.equipment_days, 3, "equipment: Eastern calendar days, drop-off = day 1 (3, not CEIL's 2)");
  eq(Number(p.labour_cost), 240, "labor: rejected time costs nothing (6 h × 40.00)");
  eq(Number(p.billed), 5825.75, "billed is the job's revenue by the one rule");
  eq(Number(p.margin), 5585.75, "margin = 5,825.75 − 240.00");
  eq(Number(p.margin_pct), 95.9, "margin % to one decimal: 5,585.75 / 5,825.75 = 95.88 → 95.9");
} finally {
  await db.close();
}

console.log(`billing-costs-one-engine.pglite: ${assertions} assertions passed`);
