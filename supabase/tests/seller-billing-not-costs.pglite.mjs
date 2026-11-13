// Run with: node supabase/tests/seller-billing-not-costs.pglite.mjs <existing PGlite dist/index.js>
// In-memory fixtures only. No connection string, network access or live writes.
//
// T11 (migration 20261027130000): salespeople see billed and paid, never
// cost. The migration is READ FROM THE FILE; the helpers it calls
// (can_view_job, can_view_finance, has_permission, rate_for,
// profile_is_active) are stubbed with the live signatures and meaning.
//
// What it proves:
//   1. job.view_billing goes to every job.view_costs role and to the four
//      seller roles; no seller role holds a cost capability.
//   2. The role matrix refuses a cost capability for a seller role.
//   3. job_labour_summary / job_person_hours / job_profitability give a
//      seller hours, billed and collected — labor cost, per-person cost and
//      margin come back NULL. A cost holder still gets them.
//   4. Typed Billed / Paid ledger cells read with billing; other money cells
//      still need finance + view_costs.
//   5. The migration is re-runnable.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
const FILE = "20261027130000_seller_billing_not_costs.sql";
const migration = readFileSync(new URL("../migrations/" + FILE, import.meta.url), "utf8");

let assertions = 0;
const check = (value, what) => {
  assert.equal(value, true, what);
  assertions++;
};

const owner = "11111111-1111-4111-8111-111111111111";
const office = "22222222-2222-4222-8222-222222222222";
const seller = "33333333-3333-4333-8333-333333333333";
const loc = "aaaaaaaa-0000-4000-8000-00000000000a";
const job = "aaaaaaaa-1111-4111-8111-11111111111a";

try {
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE SCHEMA goldstar_private;
    GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;

    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

    CREATE TABLE public.profiles (user_id uuid PRIMARY KEY, full_name text, is_active boolean NOT NULL DEFAULT true);
    CREATE TABLE public.user_roles (user_id uuid, role text);
    CREATE TABLE public.permissions (key text PRIMARY KEY, label text, perm_group text, description text, sort_order int);
    CREATE TABLE public.role_permissions (role text, permission_key text, PRIMARY KEY (role, permission_key));
    CREATE TABLE public.jobs (id uuid PRIMARY KEY, location_id uuid);
    CREATE TABLE public.time_entries (job_id uuid, user_id uuid, work_date date, minutes int, status text);
    CREATE TABLE public.invoices (job_id uuid, billed_amount numeric, collected_amount numeric);
    CREATE TABLE public.equipment_placements (job_id uuid, placed_at timestamptz, retrieved_at timestamptz);

    CREATE FUNCTION goldstar_private.profile_is_active(_user_id uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
      SELECT EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = _user_id AND p.is_active);
    $$;
    CREATE FUNCTION public.can_view_finance(_user_id uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id
                      AND role = ANY(ARRAY['owner','admin','sales_head','dev']));
    $$;
    CREATE FUNCTION public.has_permission(_user_id uuid, _key text, _location_id uuid DEFAULT NULL)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT goldstar_private.profile_is_active(_user_id) AND EXISTS (
        SELECT 1 FROM public.user_roles ur JOIN public.role_permissions rp ON rp.role = ur.role
         WHERE ur.user_id = _user_id AND rp.permission_key = _key);
    $$;
    CREATE FUNCTION public.can_view_job(_user_id uuid, _job_id uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id);
    $$;
    CREATE FUNCTION public.rate_for(_user_id uuid, _on date)
    RETURNS numeric LANGUAGE sql STABLE AS $$ SELECT 30::numeric $$;

    INSERT INTO public.profiles (user_id, full_name) VALUES
      ('${owner}', 'Owner'), ('${office}', 'Office'), ('${seller}', 'Seller');
    INSERT INTO public.user_roles VALUES
      ('${owner}', 'owner'), ('${office}', 'office'), ('${seller}', 'sales_person');
    INSERT INTO public.permissions (key) VALUES ('job.view_costs'), ('job.view_margin'), ('ai.assistant');
    INSERT INTO public.role_permissions VALUES
      ('owner', 'job.view_costs'), ('owner', 'job.view_margin'),
      ('office', 'job.view_costs'), ('sales_person', 'ai.assistant');
    INSERT INTO public.jobs VALUES ('${job}', '${loc}');
    INSERT INTO public.time_entries VALUES
      ('${job}', '${office}', '2026-10-01', 120, 'approved'),
      ('${job}', '${office}', '2026-10-02', 60, 'approved');
    INSERT INTO public.invoices VALUES ('${job}', 1000, 400);
  `);

  /* ---- 5: the migration, verbatim, twice ------------------------------ */
  await db.exec(migration);
  await db.exec(migration);
  check(true, "the migration applies twice without error");

  /* ---- 1 ---------------------------------------------------------------- */
  const billingRoles = (
    await db.query(
      `SELECT role FROM public.role_permissions WHERE permission_key = 'job.view_billing' ORDER BY role`,
    )
  ).rows.map((r) => r.role);
  for (const r of [
    "owner",
    "office",
    "sales_person",
    "outside_sales_rep",
    "cold_caller",
    "sales_rep",
  ]) {
    check(billingRoles.includes(r), `${r} holds job.view_billing`);
  }
  const sellerCost = await db.query(`
    SELECT 1 FROM public.role_permissions
     WHERE role IN ('sales_person','outside_sales_rep','cold_caller','sales_rep')
       AND permission_key IN ('job.view_costs','job.view_margin','labour_rates.view','rep_cost.view')`);
  check(sellerCost.rows.length === 0, "no seller role holds a cost capability");

  /* ---- 2 ---------------------------------------------------------------- */
  await assert.rejects(
    db.exec(`INSERT INTO public.role_permissions VALUES ('sales_person', 'job.view_costs')`),
    /Seller roles never see cost/,
  );
  assertions++;
  await assert.rejects(
    db.exec(`UPDATE public.role_permissions SET permission_key = 'job.view_margin'
              WHERE role = 'sales_rep' AND permission_key = 'job.view_billing'`),
    /Seller roles never see cost/,
  );
  assertions++;

  const as = async (uid, sql) => {
    await db.exec(`SELECT set_config('request.jwt.claim.sub', '${uid}', false)`);
    return (await db.query(sql)).rows;
  };

  /* ---- 3 ---------------------------------------------------------------- */
  const sLab = (await as(seller, `SELECT * FROM public.job_labour_summary('${job}')`))[0];
  check(Number(sLab.total_minutes) === 180, "seller sees hours");
  check(sLab.labour_cost === null, "seller gets no labor cost");
  const sPeople = await as(seller, `SELECT * FROM public.job_person_hours('${job}')`);
  check(sPeople.length === 1 && sPeople[0].cost === null, "seller gets no per-person cost");
  const sProf = (await as(seller, `SELECT * FROM public.job_profitability('${job}')`))[0];
  check(
    Number(sProf.billed) === 1000 && Number(sProf.collected) === 400,
    "seller sees billed and paid",
  );
  check(
    sProf.labour_cost === null && sProf.margin === null && sProf.margin_pct === null,
    "seller gets no labor cost or margin",
  );

  const oLab = (await as(office, `SELECT * FROM public.job_labour_summary('${job}')`))[0];
  check(Number(oLab.labour_cost) === 90, "a cost holder still gets labor cost");
  const oProf = (await as(owner, `SELECT * FROM public.job_profitability('${job}')`))[0];
  check(Number(oProf.margin) === 910, "the owner still gets margin");

  /* ---- 4 ---------------------------------------------------------------- */
  const read = async (uid, key) =>
    (await as(uid, `SELECT public.job_ledger_cell_readable('${job}', '${key}') AS ok`))[0].ok;
  check((await read(seller, "billed")) === true, "seller reads typed Billed");
  check((await read(seller, "paid")) === true, "seller reads typed Paid");
  check((await read(seller, "labor")) === false, "seller does not read typed Labor");
  check((await read(seller, "hours")) === true, "seller reads hours");
  check((await read(owner, "labor")) === true, "owner reads typed Labor");

  console.log(`seller-billing-not-costs.pglite: ${assertions} assertions passed`);
} finally {
  await db.close();
}
