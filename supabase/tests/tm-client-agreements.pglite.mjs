// Run with: node supabase/tests/tm-client-agreements.pglite.mjs <existing PGlite dist/index.js>
// In-memory fixtures only. No connection string, network access or live writes.
//
// T&M client agreements (migration 20261107120000, READ FROM THE FILE), on
// top of the real T&M and Billing & Costs prompt 1–5 migrations.
//
// What it proves:
//   1. an agreement is exceptions over T&M Rates: owner/admin only, a note,
//      names unique, only T&M items, audited;
//   2. a new T&M job takes its client's agreement and freezes it: the bill's
//      resolver says 'agreement' for those lines, T&M Rates for the rest,
//      equipment types included; other clients and regular jobs are untouched;
//   3. the office switches a job's agreement (or back to T&M Rates): the
//      sheet is repriced and a rate typed for the job alone is kept; sales
//      cannot; another client's agreement is refused;
//   4. a job that becomes T&M picks up the agreement; a later agreement
//      change does not move a running job;
//   5. strip and archive.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";


const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const read = (f) => readFileSync(new URL("../migrations/" + f, import.meta.url), "utf8");
const MIGRATIONS = [
  "20261007230000_tm_rate_codes.sql",
  "20261026140000_tm_rate_code_rates.sql",
  "20261027160000_tm_rate_catalog_costs.sql",
  "20261027161000_job_tm_rates.sql",
  "20261029120000_billing_costs_foundation.sql",
  "20261030120000_billing_costs_rules_and_tm_rates.sql",
  "20261031120000_billing_costs_cost_and_overhead.sql",
];
const P4 = read("20261101120000_billing_costs_client_agreements.sql");
const P5 = read("20261102120000_billing_costs_one_book.sql");
const P6 = read("20261107120000_tm_client_agreements.sql");

let assertions = 0;
const check = (value, what) => {
  assert.equal(value, true, what);
  assertions++;
};
const eq = (actual, expected, what) => {
  assert.deepEqual(actual, expected, what);
  assertions++;
};
const refuses = async (promise, pattern, what) => {
  await assert.rejects(promise, pattern, what);
  assertions++;
};

const owner = "10000000-1111-4111-8111-111111111111";
const admin = "11111111-1111-4111-8111-111111111111";
const dev = "12222222-1111-4111-8111-111111111111";
const office = "13333333-1111-4111-8111-111111111111";
const seller = "14444444-1111-4111-8111-111111111111";
const ny = "aaaaaaaa-0000-4000-8000-00000000000a";
const nj = "bbbbbbbb-0000-4000-8000-00000000000b";
const falcon = "f0000000-0000-4000-8000-00000000000f";
const acme = "a0000000-0000-4000-8000-0000000000ac";
const oldJob = "cccccccc-0000-4000-8000-00000000000c";

const db = new PGlite();
try {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; CREATE SCHEMA goldstar_private;
    GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
    GRANT USAGE ON SCHEMA goldstar_private TO authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE TABLE public.profiles (user_id uuid PRIMARY KEY, is_active boolean NOT NULL DEFAULT true);
    CREATE FUNCTION goldstar_private.profile_is_active(_user_id uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
      SELECT EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = _user_id AND p.is_active);
    $$;
    GRANT EXECUTE ON FUNCTION goldstar_private.profile_is_active(uuid) TO authenticated, service_role;
    CREATE TYPE public.app_role AS ENUM ('owner', 'admin', 'dev', 'office', 'sales_person', 'crew');
    CREATE TABLE public.user_roles (user_id uuid, role public.app_role);
    CREATE FUNCTION public.is_privileged(_user_id uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
      $$ SELECT EXISTS (SELECT 1 FROM public.user_roles
                         WHERE user_id = _user_id AND role IN ('owner', 'admin', 'dev')) $$;
    GRANT EXECUTE ON FUNCTION public.is_privileged(uuid) TO authenticated;
    CREATE FUNCTION public.can_view_finance(_user_id uuid) RETURNS boolean
      LANGUAGE sql STABLE AS $$ SELECT false $$;
    CREATE FUNCTION public.has_permission(_user_id uuid, _key text, _location_id uuid DEFAULT NULL)
      RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
    CREATE FUNCTION public.can_view_job(_user_id uuid, _job_id uuid)
      RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT _user_id IS NOT NULL $$;
    CREATE FUNCTION public.can_view_job_costs(_job_id uuid)
      RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT public.is_privileged(auth.uid()) $$;

    CREATE TABLE public.locations (id uuid PRIMARY KEY, name text);
    CREATE TABLE public.accounts (id uuid PRIMARY KEY, name text);
    CREATE TABLE public.jobs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid, billing_location_id uuid,
      account_id uuid, region text, job_type text, created_at timestamptz NOT NULL DEFAULT now());
    GRANT SELECT, INSERT, UPDATE ON public.jobs TO authenticated;
    CREATE TABLE public.job_tm_forms (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid, kind text, payload jsonb);
    CREATE TABLE public.app_settings (
      key text PRIMARY KEY, value jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid);
    INSERT INTO public.app_settings VALUES
      ('tm.bill_rules', '{"dailyOtAfterHours": 8}', now(), NULL),
      ('equipment_day_rates', '{"day_rates": {"scrubber": 10, "injector": 10, "ozone": 12.5, "hydroxyl": 20}}', now(), NULL);

    CREATE TABLE public.estimate_headers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text, name text);
    CREATE TABLE public.estimate_catalog_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), header_id uuid, code text NOT NULL UNIQUE,
      name text NOT NULL, uom text NOT NULL DEFAULT 'EA', default_unit_price numeric(12,2) NOT NULL DEFAULT 0,
      is_active boolean NOT NULL DEFAULT true, sort_order integer NOT NULL DEFAULT 0);
    CREATE TABLE public.price_lists (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, description text,
      is_active boolean NOT NULL DEFAULT true, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE public.price_list_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      price_list_id uuid NOT NULL REFERENCES public.price_lists(id) ON DELETE CASCADE,
      catalog_item_id uuid NOT NULL REFERENCES public.estimate_catalog_items(id) ON DELETE CASCADE,
      unit_price numeric NOT NULL CHECK (unit_price >= 0), created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (price_list_id, catalog_item_id));
    CREATE TABLE public.price_list_assignments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      price_list_id uuid NOT NULL REFERENCES public.price_lists(id) ON DELETE CASCADE,
      account_id uuid, location_id uuid, state_code text,
      effective_from date NOT NULL DEFAULT CURRENT_DATE, effective_to date, created_by uuid,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
    ALTER TABLE public.price_lists ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.price_list_items ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.price_list_assignments ENABLE ROW LEVEL SECURITY;
    CREATE POLICY pl_all ON public.price_lists TO authenticated USING (true) WITH CHECK (public.is_privileged(auth.uid()));
    CREATE POLICY pli_all ON public.price_list_items TO authenticated USING (true) WITH CHECK (public.is_privileged(auth.uid()));
    CREATE POLICY pla_all ON public.price_list_assignments TO authenticated USING (true) WITH CHECK (public.is_privileged(auth.uid()));

    CREATE TYPE public.equipment_type AS ENUM
      ('air_mover','dehumidifier','air_scrubber','hepa','heater','generator','moisture_meter','other');
    CREATE TABLE public.equipment (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), asset_tag text,
      equipment_type public.equipment_type NOT NULL, location_id uuid NOT NULL,
      daily_rate_cents integer, notes text);
    CREATE TABLE public.labour_rates (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid, user_id uuid,
      role public.app_role, crew_class text, hourly_rate numeric(10,2) NOT NULL,
      effective_from date NOT NULL, effective_to date, note text, created_by uuid,
      created_at timestamptz NOT NULL DEFAULT now());

    INSERT INTO public.profiles VALUES ('${owner}', true), ('${admin}', true), ('${dev}', true),
      ('${office}', true), ('${seller}', true);
    INSERT INTO public.user_roles VALUES ('${owner}', 'owner'), ('${admin}', 'admin'), ('${dev}', 'dev'),
      ('${office}', 'office'), ('${seller}', 'sales_person');
    INSERT INTO public.locations VALUES ('${ny}', 'Brooklyn'), ('${nj}', 'Lakewood');
    INSERT INTO public.accounts VALUES ('${falcon}', 'Falcon'), ('${acme}', 'Acme');
    INSERT INTO public.equipment (asset_tag, equipment_type, location_id, daily_rate_cents) VALUES
      ('HP-1', 'hepa', '${ny}', 1500);
  `);
  for (const m of MIGRATIONS) await db.exec(read(m));
  const poly = (await db.query(`SELECT name FROM public.catalog_items WHERE code = '104'`)).rows[0].name;
  await db.exec(`
    INSERT INTO public.estimate_headers (id, code, name) VALUES
      ('e0000000-0000-4000-8000-000000000001', 'LAB', 'Labor'),
      ('e0000000-0000-4000-8000-000000000002', 'EQ', 'Equipment'),
      ('e0000000-0000-4000-8000-000000000003', 'SVC', 'Services');
    INSERT INTO public.estimate_catalog_items (code, name, uom, default_unit_price, header_id, sort_order) VALUES
      ('GSC-LABOR-REG', 'Labor - regular', 'HR', 65, 'e0000000-0000-4000-8000-000000000001', 10),
      ('GSC-EQ-AIR-MOVER', 'Air mover (per day)', 'DAY', 45, 'e0000000-0000-4000-8000-000000000002', 20),
      ('GSC-EQ-SCRUBBER-XL', 'Scrubber XL', 'DAY', 200, 'e0000000-0000-4000-8000-000000000002', 30),
      ('GSC-EQ-SCRUBBER-XXL', 'Scrubber XXL', 'DAY', 250, 'e0000000-0000-4000-8000-000000000002', 40),
      ('GSC-MOLD-INSP', 'Mold inspection', 'EA', 350, 'e0000000-0000-4000-8000-000000000003', 50),
      ('GSC-BASEBOARD', 'Remove baseboard', 'LF', 2.25, 'e0000000-0000-4000-8000-000000000003', 60),
      ('SCL', 'Structural cleaning (estimate)', 'HR', 85, 'e0000000-0000-4000-8000-000000000001', 70),
      ('POLY-ROLL', '${poly.replace(/'/g, "''")}', 'RL', 140, NULL, 80),
      ('bad code!', 'Something odd', 'EA', 10, NULL, 90);
    -- Old world: NJ branch list (labor 70); NY state list (air mover 50);
    -- Falcon's agreement (labor 60); Acme's labor rate from Cost rates (62).
    INSERT INTO public.price_lists (id, name) VALUES
      ('11000000-0000-4000-8000-000000000001', 'NJ branch'),
      ('11000000-0000-4000-8000-000000000002', 'New York state'),
      ('11000000-0000-4000-8000-000000000003', 'Falcon'),
      ('11000000-0000-4000-8000-000000000004', 'Acme labor rate');
    INSERT INTO public.price_list_items (price_list_id, catalog_item_id, unit_price)
    SELECT l, c.id, p FROM (VALUES
      ('11000000-0000-4000-8000-000000000001'::uuid, 'GSC-LABOR-REG', 70),
      ('11000000-0000-4000-8000-000000000002'::uuid, 'GSC-EQ-AIR-MOVER', 50),
      ('11000000-0000-4000-8000-000000000003'::uuid, 'GSC-LABOR-REG', 60),
      ('11000000-0000-4000-8000-000000000004'::uuid, 'GSC-LABOR-REG', 62)) v(l, code, p)
    JOIN public.estimate_catalog_items c ON c.code = v.code;
    INSERT INTO public.price_list_assignments (price_list_id, location_id, account_id, state_code, effective_from) VALUES
      ('11000000-0000-4000-8000-000000000001', '${nj}', NULL, NULL, '2026-01-01'),
      ('11000000-0000-4000-8000-000000000002', NULL, NULL, 'NY', '2026-01-01'),
      ('11000000-0000-4000-8000-000000000003', NULL, '${falcon}', NULL, '2026-02-01'),
      ('11000000-0000-4000-8000-000000000004', NULL, '${acme}', NULL, '2026-03-01');
    -- T&M rates for the scrubber types differ (XL vs XXL), so HEPA units stay.
    INSERT INTO public.money_values (book, item_key, measure, office_id, effective_from, value) VALUES
      ('tm_rates', 'EQ:hepa', 'bill_rate', NULL, '2000-01-01', 250);
    INSERT INTO public.jobs (id, location_id, account_id, created_at) VALUES ('${oldJob}', '${nj}', '${falcon}', '2026-05-01');
  `);

  await db.exec(P4);
  await db.exec(`UPDATE public.tm_rate_codes SET small_tools = false WHERE code = 'PCT'`);
  await db.exec(P5);
  // A T&M job made before this migration, with a rate typed for it.
  await db.exec(`
    INSERT INTO public.jobs (id, location_id, account_id, job_type, created_at)
    VALUES ('dddddddd-0000-4000-8000-00000000000d', '${nj}', '${falcon}', 't_m', now());
    UPDATE public.job_tm_rates SET rate = 1 WHERE job_id = 'dddddddd-0000-4000-8000-00000000000d'
      AND code = (SELECT min(code) FROM public.job_tm_rates WHERE job_id = 'dddddddd-0000-4000-8000-00000000000d' AND rate IS NOT NULL);
  `);
  await db.exec(P6);
  await db.exec(P6);
  check(true, "the migration applies twice without error");

  const as = async (uid, sql) => {
    await db.exec(`SET ROLE authenticated; SET request.jwt.claim.sub = '${uid ?? ""}'`);
    try {
      return await db.query(sql);
    } finally {
      await db.exec("RESET ROLE; SELECT set_config('request.jwt.claim.sub','',false)");
    }
  };
  const one = async (sql) => (await db.query(sql)).rows[0];
  const n = async (sql) => (await one(sql)).n;
  const q = (v) => (v == null ? "NULL" : `'${v}'`);
  const tm = async (job, key) => {
    const r = (await as(admin, `SELECT rate::float8 AS rate, source FROM public.tm_bill_rates('${job}') WHERE item_key = '${key}'`)).rows[0];
    return [r.rate, r.source];
  };
  const sheet = async (job, code) => {
    const r = await one(`SELECT rate::float8 AS rate, source FROM public.job_tm_rates WHERE job_id = '${job}' AND code = '${code}'`);
    return r ? [r.rate, r.source] : null;
  };
  const save = (uid, changes, note = "Signed 2026 T&M sheet") =>
    as(uid, `SELECT public.tm_agreements_save('${JSON.stringify(changes)}'::jsonb, ${q(note)}) AS id`);

  /* ---- 0: existing rows keep their meaning ----------------------------- */
  const old = "dddddddd-0000-4000-8000-00000000000d";
  eq(await n(`SELECT count(*)::int AS n FROM public.job_tm_rates WHERE job_id = '${old}' AND rate = 1 AND source = 'job'`), 1,
    "a rate typed on an existing job is the job's own");
  eq(await n(`SELECT count(*)::int AS n FROM public.job_tm_rates WHERE job_id = '${old}' AND rate <> 1 AND source <> 'standard'`), 0,
    "the rest of its sheet is the frozen T&M rates");

  /* ---- 1: the agreement ------------------------------------------------- */
  await as(admin, `SELECT public.catalog_save('[{"op":"create","code":"WT","name":"Water Technician","category":"labor","unit":"hr"},{"op":"create","code":"WX","name":"Water Helper","category":"labor","unit":"hr"}]'::jsonb, 'new')`);
  await as(admin, `SELECT public.tm_rates_save('[{"op":"rate","item_key":"WT","office_id":null,"value":91},{"op":"rate","item_key":"WX","office_id":null,"value":50}]'::jsonb, 'priced')`);

  await refuses(save(office, [{ op: "create", name: "Falcon T&M" }]), /owner or admin/, "the office cannot make one");
  await refuses(save(seller, [{ op: "create", name: "Falcon T&M" }]), /owner or admin/, "nor can sales");
  await refuses(save(admin, [{ op: "create", name: "Falcon T&M" }], " "), /needs a note/, "a note is required");
  const agr = (await save(admin, [
    { op: "create", name: "Falcon T&M" },
    { op: "line", agreement_id: "new", code: "WT", value: 80 },
    { op: "line", agreement_id: "new", code: "EQ:hepa", value: 200 },
    { op: "link", agreement_id: "new", account_id: falcon },
  ])).rows[0].id;
  check(!!agr, "an admin makes one, lines and client in one save");
  eq(await n(`SELECT count(*)::int AS n FROM public.tm_agreement_lines WHERE agreement_id = '${agr}'`), 2, "two exceptions");
  eq((await one(`SELECT is_primary FROM public.tm_agreement_clients WHERE agreement_id = '${agr}'`)).is_primary, true,
    "a client's first T&M agreement is its primary");
  await refuses(save(admin, [{ op: "create", name: " falcon t&m " }]), /already a T&M agreement/, "names are unique, case and spaces aside");
  await refuses(save(admin, [{ op: "line", agreement_id: agr, code: "GSC-LABOR-REG", value: 1 }]), /No T&M item/, "only T&M items");
  await refuses(save(admin, [{ op: "line", agreement_id: agr, code: "WT", value: 1.005 }]), /dollars and cents/, "cents only");
  await refuses(as(admin, `INSERT INTO public.tm_agreement_lines VALUES ('${agr}', 'WX', 1)`), /permission denied/, "no direct writes");
  check((await as(seller, `SELECT count(*)::int AS n FROM public.tm_agreements`)).rows[0].n === 1, "everyone reads them");
  eq(await n(`SELECT count(*)::int AS n FROM public.money_audit_log WHERE book = 'tm_rates' AND entity LIKE 'tm_agreement%' AND note = 'Signed 2026 T&M sheet'`), 4,
    "created, two lines and the client — audited with the note");

  /* ---- 2: a new T&M job freezes it -------------------------------------- */
  const job = (await one(`INSERT INTO public.jobs (location_id, account_id, job_type) VALUES ('${nj}', '${falcon}', 't_m') RETURNING id::text AS id`)).id;
  eq((await one(`SELECT tm_agreement_id::text AS a FROM public.jobs WHERE id = '${job}'`)).a, agr, "the T&M job takes Falcon's agreement");
  eq(await sheet(job, "WT"), [80, "agreement"], "its sheet freezes the agreed rate");
  eq(await sheet(job, "WX"), [50, "standard"], "and the T&M rate where the agreement is silent");
  eq(await tm(job, "WT"), [80, "agreement"], "the bill reads the agreed rate");
  eq(await tm(job, "WX"), [50, "job"], "and the frozen T&M rate as before");
  eq(await tm(job, "EQ:hepa"), [200, "agreement"], "an equipment type's agreed rate");
  const acmeJob = (await one(`INSERT INTO public.jobs (location_id, account_id, job_type) VALUES ('${nj}', '${acme}', 't_m') RETURNING id::text AS id`)).id;
  eq(await tm(acmeJob, "WT"), [91, "job"], "another client pays T&M Rates");
  eq(await tm(acmeJob, "EQ:hepa"), [250, "default"], "equipment too");
  const reg = (await one(`INSERT INTO public.jobs (location_id, account_id) VALUES ('${nj}', '${falcon}') RETURNING id::text AS id`)).id;
  eq((await one(`SELECT tm_agreement_id FROM public.jobs WHERE id = '${reg}'`)).tm_agreement_id, null, "a regular job takes none");

  /* ---- 3: switching ----------------------------------------------------- */
  await as(admin, `UPDATE public.job_tm_rates SET rate = 55 WHERE job_id = '${job}' AND code = 'WX'`);
  eq(await sheet(job, "WX"), [55, "job"], "a rate typed for the job is its own");
  await refuses(as(seller, `SELECT public.job_tm_agreement_set('${job}', NULL)`), /office or a manager/, "sales cannot switch it");
  await refuses(as(seller, `UPDATE public.jobs SET tm_agreement_id = NULL WHERE id = '${job}'`), /office or a manager/, "not even directly");
  await as(office, `SELECT public.job_tm_agreement_set('${job}', NULL, 'Client asked for list')`);
  eq(await sheet(job, "WT"), [91, "standard"], "back on T&M Rates: the agreed line is repriced");
  eq(await sheet(job, "WX"), [55, "job"], "the job's own rate stays");
  eq(await tm(job, "EQ:hepa"), [250, "default"], "equipment follows T&M Rates");
  await as(office, `SELECT public.job_tm_agreement_set('${job}', '${agr}')`);
  eq(await sheet(job, "WT"), [80, "agreement"], "and onto the agreement again");
  await refuses(as(office, `SELECT public.job_tm_agreement_set('${acmeJob}', '${agr}')`), /not one of this client/, "another client's agreement is refused");
  check((await n(`SELECT count(*)::int AS n FROM public.money_audit_log WHERE entity = 'job_rates' AND field = 'tm_agreement' AND entity_key = '${job}'`)) === 2,
    "each switch is audited");

  /* ---- 4: becoming T&M; a running job does not move --------------------- */
  await as(office, `UPDATE public.jobs SET job_type = 't_m' WHERE id = '${reg}'`);
  eq((await one(`SELECT tm_agreement_id::text AS a FROM public.jobs WHERE id = '${reg}'`)).a, agr, "a job that becomes T&M takes the agreement");
  eq(await sheet(reg, "WT"), [80, "agreement"], "and is repriced to it");
  await save(admin, [{ op: "line", agreement_id: agr, code: "WT", value: 70 }]);
  eq(await tm(job, "WT"), [80, "agreement"], "a later change does not move a running job");
  const next = (await one(`INSERT INTO public.jobs (location_id, account_id, job_type) VALUES ('${nj}', '${falcon}', 't_m') RETURNING id::text AS id`)).id;
  eq(await tm(next, "WT"), [70, "agreement"], "the next job gets it");

  /* ---- 5: strip and archive --------------------------------------------- */
  await save(admin, [{ op: "line", agreement_id: agr, code: "WX", value: 50 }]);
  await save(admin, [{ op: "strip_standard", agreement_id: agr }], "Lean it");
  eq((await db.query(`SELECT item_key FROM public.tm_agreement_lines WHERE agreement_id = '${agr}' ORDER BY 1`)).rows.map((r) => r.item_key),
    ["EQ:hepa", "WT"], "the line equal to the T&M rate goes; real exceptions stay");
  await save(admin, [{ op: "archive", agreement_id: agr }], "Contract ended");
  eq(await n(`SELECT count(*)::int AS n FROM public.tm_agreement_clients WHERE agreement_id = '${agr}' AND effective_to IS NULL`), 0,
    "archiving ends its client links");
  eq((await one(`SELECT public.tm_agreement_for('${falcon}', current_date) AS a`)).a, null, "and Falcon has no T&M agreement now");
  const after = (await one(`INSERT INTO public.jobs (location_id, account_id, job_type) VALUES ('${nj}', '${falcon}', 't_m') RETURNING id::text AS id`)).id;
  eq(await tm(after, "WT"), [91, "job"], "a job after that pays T&M Rates");
  eq(await tm(job, "WT"), [80, "agreement"], "while the running job keeps its sheet");
  await refuses(save(admin, [{ op: "line", agreement_id: agr, code: "WT", value: 1 }]), /No open T&M agreement/, "an archived agreement is closed");
} finally {
  await db.close();
}

console.log(`tm-client-agreements.pglite: ${assertions} assertions passed`);
