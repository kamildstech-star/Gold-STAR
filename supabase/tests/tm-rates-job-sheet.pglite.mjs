// Run with: node supabase/tests/tm-rates-job-sheet.pglite.mjs <existing PGlite dist/index.js>
// In-memory fixtures only. No connection string, network access or live writes.
//
// TM1 + TM2 (migrations 20261027160000 and 20261027161000), READ FROM THE
// FILES. Helpers (can_view_job, can_view_finance, has_permission,
// can_view_job_costs) are stubbed with the live signatures and meaning.
//
// What it proves:
//   1. cost_rate on the catalogue is not readable by a signed-in user;
//      tm_rate_code_costs() answers a cost viewer and gives a seller nothing.
//   2. The sample's rates are seeded, EO is added, a typed rate is never
//      overwritten, and management titles carry no Small Tools.
//   3. A new job snapshots the Settings rates (job-sticky): a later Settings
//      change does not re-price it.
//   4. A job's cost_rate is not readable from the table; job_tm_rate_costs()
//      answers a cost viewer only. Only a cost viewer sets a job's rate.
//   5. Both migrations are re-runnable; anon gets nothing.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
const read = (f) => readFileSync(new URL("../migrations/" + f, import.meta.url), "utf8");
const TM1 = read("20261027160000_tm_rate_catalog_costs.sql");
const TM2 = read("20261027161000_job_tm_rates.sql");
const TM3 = read("20261027162000_tm_bill_rules.sql");

let assertions = 0;
const check = (value, what) => {
  assert.equal(value, true, what);
  assertions++;
};
const refused = async (p, what) => {
  await assert.rejects(p, /permission denied|row-level security/, what);
  assertions++;
};

const office = "11111111-1111-4111-8111-111111111111"; // job.view_costs
const seller = "22222222-2222-4222-8222-222222222222";
const job1 = "aaaaaaaa-1111-4111-8111-11111111111a";
const job2 = "bbbbbbbb-1111-4111-8111-11111111111b";

try {
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

    CREATE TABLE public.perms (user_id uuid, key text);
    CREATE TABLE public.jobs (id uuid PRIMARY KEY, location_id uuid);
    CREATE TABLE public.job_tm_forms (job_id uuid, kind text);
    GRANT SELECT, INSERT ON public.jobs TO authenticated;
    REVOKE ALL ON public.perms FROM anon, authenticated;

    CREATE TABLE public.tm_rate_codes (
      code text PRIMARY KEY, label text NOT NULL, section text NOT NULL, unit_note text,
      sort_order integer NOT NULL DEFAULT 1000, active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by uuid, rate numeric(10,2));
    INSERT INTO public.tm_rate_codes (code, label, section) VALUES
      ('SCL','Structural Cleaning Labor','labor'), ('SPM','Sr. Project Manager','labor'),
      ('PCT','Project Consultant','labor'), ('PE','Project Estimator','labor'),
      ('106','HEPA filter (for HEPA vac)','consumable'), ('329','HEPA Vacuum','equipment'),
      ('401','Cargo Van','vehicle'), ('405','Personal Company Vehicle','vehicle'),
      ('104','6 Mil Poly','consumable'), ('122','Rags','consumable'),
      ('GEN-PERDIEM','Per Diem','general'), ('GEN-SMALLTOOLS','Small Tools','general'),
      ('GEN-OP','O & P','general');
    UPDATE public.tm_rate_codes SET rate = 88 WHERE code = 'SCL';
    UPDATE public.tm_rate_codes SET rate = 99 WHERE code = '122'; -- typed by the office

    CREATE FUNCTION public.has_permission(_user_id uuid, _key text, _location_id uuid DEFAULT NULL)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT EXISTS (SELECT 1 FROM public.perms WHERE user_id = _user_id AND key = _key);
    $$;
    CREATE FUNCTION public.can_view_finance(_user_id uuid)
    RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
    CREATE FUNCTION public.can_view_job(_user_id uuid, _job_id uuid)
    RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT _user_id IS NOT NULL $$;
    CREATE FUNCTION public.can_view_job_costs(_job_id uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT public.has_permission(auth.uid(), 'job.view_costs', NULL);
    $$;
    INSERT INTO public.perms VALUES ('${office}', 'job.view_costs');
    INSERT INTO public.jobs VALUES ('${job1}', NULL);
    INSERT INTO public.job_tm_forms VALUES ('${job1}', 'sign_in');
  `);

  /* ---- 5: both migrations, verbatim, twice ---------------------------- */
  await db.exec(TM1);
  await db.exec(TM1);
  await db.exec(TM2);
  await db.exec(TM2);
  await db.exec(TM3);
  await db.exec(TM3);
  check(true, "the migrations apply twice without error");

  /* ---- 2 ---------------------------------------------------------------- */
  const rate = async (code) =>
    (await db.query(`SELECT rate FROM public.tm_rate_codes WHERE code = '${code}'`)).rows[0]?.rate;
  check(Number(await rate("EO")) === 97, "EO added at $97");
  check(Number(await rate("106")) === 108.48, "HEPA filter seeded at $108.48");
  check(Number(await rate("329")) === 48.5, "HEPA vacuum seeded at $48.50/day");
  check(Number(await rate("405")) === 102.6, "Personal Company Vehicle seeded at $102.60/day");
  check(Number(await rate("122")) === 99, "a typed rate is never overwritten");
  const st = (
    await db.query(`SELECT code FROM public.tm_rate_codes WHERE small_tools = false ORDER BY code`)
  ).rows.map((r) => r.code);
  check(
    ["PCT", "PE", "SPM"].every((c) => st.includes(c)) && !st.includes("SCL"),
    "no Small Tools on management titles",
  );

  const as = async (uid, sql) => {
    await db.exec(
      `SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', '${uid}', false)`,
    );
    try {
      return (await db.query(sql)).rows;
    } finally {
      await db.exec("RESET ROLE");
    }
  };

  /* ---- 1 ---------------------------------------------------------------- */
  await refused(
    as(seller, "SELECT cost_rate FROM public.tm_rate_codes"),
    "seller cannot select cost_rate",
  );
  await refused(
    as(office, "SELECT * FROM public.tm_rate_codes"),
    "select * is refused for everyone",
  );
  check(
    (await as(seller, "SELECT code, rate, unit, small_tools FROM public.tm_rate_codes")).length > 0,
    "seller reads the client side",
  );
  await db.exec(`UPDATE public.tm_rate_codes SET cost_rate = 45 WHERE code = 'SCL'`);
  check(
    (await as(seller, "SELECT * FROM public.tm_rate_code_costs()")).length === 0,
    "seller gets no costs from the RPC",
  );
  const oc = await as(
    office,
    "SELECT cost_rate FROM public.tm_rate_code_costs() WHERE code = 'SCL'",
  );
  check(Number(oc[0]?.cost_rate) === 45, "a cost viewer gets the cost from the RPC");

  /* ---- 3 ---------------------------------------------------------------- */
  const jobRate = async (job, code) =>
    (
      await db.query(
        `SELECT rate FROM public.job_tm_rates WHERE job_id = '${job}' AND code = '${code}'`,
      )
    ).rows[0]?.rate;
  check(Number(await jobRate(job1, "SCL")) === 88, "a job with T&M forms got the snapshot");
  await db.exec(`INSERT INTO public.jobs VALUES ('${job2}', NULL)`);
  check(Number(await jobRate(job2, "SCL")) === 88, "a new job snapshots the Settings rates");
  await db.exec(`UPDATE public.tm_rate_codes SET rate = 95 WHERE code = 'SCL'`);
  check(
    Number(await jobRate(job2, "SCL")) === 88,
    "a later Settings change does not re-price the job",
  );

  /* ---- 4 ---------------------------------------------------------------- */
  await refused(
    as(office, `SELECT cost_rate FROM public.job_tm_rates WHERE job_id = '${job2}'`),
    "job cost_rate is not selectable",
  );
  check(
    (await as(seller, `SELECT * FROM public.job_tm_rate_costs('${job2}')`)).length === 0,
    "seller gets no job costs",
  );
  check(
    (await as(office, `SELECT * FROM public.job_tm_rate_costs('${job2}')`)).length > 0,
    "a cost viewer gets job costs",
  );
  check(
    (await as(seller, `SELECT code, rate FROM public.job_tm_rates WHERE job_id = '${job2}'`))
      .length > 0,
    "anyone on the job reads its client rates",
  );
  await refused(
    as(
      seller,
      `INSERT INTO public.job_tm_rates (job_id, code, rate) VALUES ('${job2}', 'PE', 125)`,
    ),
    "a seller cannot set a job's rate",
  );
  // The app's own write: an upsert on (job_id, code).
  const upsert = (code, r) =>
    `INSERT INTO public.job_tm_rates (job_id, code, rate) VALUES ('${job2}', '${code}', ${r})
     ON CONFLICT (job_id, code) DO UPDATE SET rate = EXCLUDED.rate`;
  await as(office, upsert("PE", 125));
  check(Number(await jobRate(job2, "PE")) === 125, "a cost viewer sets a new rate for the job");
  await as(office, upsert("104", 175));
  check(Number(await jobRate(job2, "104")) === 175, "and changes a snapshotted one");
  check(Number(await rate("104")) === 150, "without touching Settings");

  /* ---- TM3: a job's rule override ---------------------------------------- */
  await refused(
    as(
      seller,
      `INSERT INTO public.job_tm_settings (job_id, rules) VALUES ('${job2}', '{"taxPercent": 0}')`,
    ),
    "a seller cannot change a job's bill rules",
  );
  await as(
    office,
    `INSERT INTO public.job_tm_settings (job_id, rules) VALUES ('${job2}', '{"taxPercent": 8.87}')`,
  );
  const jr = await as(seller, `SELECT rules FROM public.job_tm_settings WHERE job_id = '${job2}'`);
  check(
    Number(jr[0]?.rules?.taxPercent) === 8.87,
    "anyone on the job reads its rules; a cost viewer set them",
  );

  /* ---- 5: anon ---------------------------------------------------------- */
  await db.exec("SET ROLE anon");
  await assert.rejects(db.query("SELECT code FROM public.job_tm_rates"), /permission denied/);
  await assert.rejects(db.query("SELECT code FROM public.tm_rate_codes"), /permission denied/);
  assertions += 2;
  await db.exec("RESET ROLE");

  console.log(`tm-rates-job-sheet.pglite: ${assertions} assertions passed`);
} finally {
  await db.close();
}
