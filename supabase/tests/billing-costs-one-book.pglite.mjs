// Run with: node supabase/tests/billing-costs-one-book.pglite.mjs <existing PGlite dist/index.js>
// In-memory fixtures only. No connection string, network access or live writes.
//
// Billing & Costs, prompt 5 (migration 20261102120000, READ FROM THE FILE),
// on top of the real T&M and prompt 1–4 migrations.
//
// What it proves:
//   1. the T&M sheet lives in Catalogs: every old code is there with its
//      section, label, on/off, unit and Small Tools; the forms' view matches;
//   2. the mirror is gone both ways and tm_rate_codes is read-only; a code
//      made in Catalogs is billable (T&M Rates, the bill's resolver, a new
//      job's frozen sheet) without ever touching tm_rate_codes;
//   3. FREEZE, book by book: a job made today keeps its T&M rates, costs,
//      regular rates, General rules, charges and minimum margin through later
//      publishes of each;
//   4. a T&M job's estimate prices T&M items from T&M Rates, to the cent;
//      other items fall through the regular chain;
//   5. "Strip lines equal to Standard" drops exactly those, audited;
//   6. new jobs are billing_version 5; existing ones are not.
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
  await db.exec(P5);
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

  /* ---- 1: the sheet in Catalogs ---------------------------------------- */
  eq(
    await n(`SELECT count(*)::int AS n FROM public.tm_rate_codes t
              WHERE NOT EXISTS (SELECT 1 FROM public.tm_sheet_codes v
                                 WHERE v.code = t.code AND v.section = t.section AND v.label = t.label
                                   AND v.active = t.active AND v.unit IS NOT DISTINCT FROM t.unit
                                   AND v.small_tools = t.small_tools)`),
    0,
    "every old code is on the new sheet, same section, label, on/off, unit and Small Tools",
  );
  eq(
    await n(`SELECT (SELECT count(*) FROM public.tm_sheet_codes) - (SELECT count(*) FROM public.tm_rate_codes) AS n`),
    0,
    "and nothing else is (before anyone adds a code)",
  );
  eq(
    await one(`SELECT category, in_tm, in_regular, tm_unit FROM public.catalog_items WHERE code = '302'`),
    { category: "equipment", in_tm: true, in_regular: false, tm_unit: "day" },
    "an equipment code is a T&M Equipment item",
  );
  eq((await one(`SELECT category FROM public.catalog_items WHERE code = 'GEN-HOTEL'`)).category, "general", "a supply-list charge is General");
  eq((await one(`SELECT equipment_type FROM public.catalog_items WHERE code = '305'`)).equipment_type, "air_scrubber", "the type mapping moved with it");

  /* ---- 2: the mirror is gone -------------------------------------------- */
  await as(admin, `SELECT public.catalog_save('[{"op":"update","code":"SCL","name":"Structural Cleaning Labor (rev)"}]'::jsonb, 'rename')`);
  eq((await one(`SELECT label FROM public.tm_rate_codes WHERE code = 'SCL'`)).label, "Structural Cleaning Labor", "a Catalogs edit no longer copies to tm_rate_codes");
  eq((await one(`SELECT label FROM public.tm_sheet_codes WHERE code = 'SCL'`)).label, "Structural Cleaning Labor (rev)", "the forms read the new name");
  await refuses(as(admin, `UPDATE public.tm_rate_codes SET label = 'x' WHERE code = 'SCL'`), /permission denied/, "tm_rate_codes is read-only");
  await as(admin, `SELECT public.catalog_save('[{"op":"create","code":"WT","name":"Water Technician","category":"labor","unit":"hr"}]'::jsonb, 'new')`);
  eq(await n(`SELECT count(*)::int AS n FROM public.tm_rate_codes WHERE code = 'WT'`), 0, "a new code never reaches tm_rate_codes");
  await as(admin, `SELECT public.tm_rates_save('[{"op":"rate","item_key":"WT","office_id":null,"value":91}]'::jsonb, 'priced')`);
  await as(admin, `SELECT public.tm_rates_save('[{"op":"small_tools","code":"WT","on":false}]'::jsonb, '')`);
  eq((await one(`SELECT small_tools FROM public.tm_sheet_codes WHERE code = 'WT'`)).small_tools, false, "Small Tools is a Catalogs column now");
  check((await n(`SELECT count(*)::int AS n FROM public.money_audit_log WHERE entity_key = 'WT' AND field = 'small_tools'`)) === 1, "and audited");

  /* ---- 3: freeze, book by book ------------------------------------------ */
  const job = (await one(`INSERT INTO public.jobs (location_id, account_id, job_type) VALUES ('${nj}', '${falcon}', 't_m') RETURNING id::text AS id`)).id;
  const reg = (await one(`INSERT INTO public.jobs (location_id, account_id) VALUES ('${nj}', '${falcon}') RETURNING id::text AS id`)).id;
  eq((await one(`SELECT billing_version FROM public.jobs WHERE id = '${job}'`)).billing_version, 5, "a new job is billing version 5");
  eq((await one(`SELECT billing_version FROM public.jobs WHERE id = '${oldJob}'`)).billing_version, null, "an existing one is grandfathered");
  const tmRate = async (id, code) =>
    Number((await as(admin, `SELECT rate FROM public.tm_bill_rates('${id}') WHERE item_key = '${code}'`)).rows[0].rate);
  const costRate = async (id, code) =>
    (await as(admin, `SELECT cost_rate FROM public.tm_cost_rates('${id}') WHERE item_key = '${code}'`)).rows[0].cost_rate;
  eq(await tmRate(job, "WT"), 91, "the new code is on the job's frozen sheet");
  await as(admin, `SELECT public.cost_save('[{"op":"cost","item_key":"PCT","office_id":null,"value":61}]'::jsonb, 'before')`);
  const job2 = (await one(`INSERT INTO public.jobs (location_id, job_type) VALUES ('${nj}', 't_m') RETURNING id::text AS id`)).id;
  // Later publishes, one per book:
  await as(admin, `SELECT public.tm_rates_save('[{"op":"rate","item_key":"WT","office_id":null,"value":95}]'::jsonb, 'later')`);
  await as(admin, `SELECT public.cost_save('[{"op":"cost","item_key":"PCT","office_id":null,"value":70}]'::jsonb, 'later')`);
  await as(admin, `SELECT public.billing_rules_save('{"overtime_mode":"weekly","weekly_ot_after_hours":38,"minimum_margin_percent":35}'::jsonb, '[]'::jsonb, 'later')`);
  await as(admin, `SELECT public.agreements_save('[{"op":"line","agreement_id":"11000000-0000-4000-8000-000000000003","code":"GSC-LABOR-REG","value":57}]'::jsonb, 'later')`);
  eq(await tmRate(job, "WT"), 91, "T&M rates: the job keeps 91.00 after a 95.00 publish");
  eq(Number(await costRate(job2, "PCT")), 61, "costs: the job keeps 61.00 after a 70.00 publish");
  const reg_lab = (await as(admin, `SELECT unit_price FROM public.regular_price_book('${reg}', '${falcon}', '${nj}', NULL, current_date) WHERE code = 'GSC-LABOR-REG'`)).rows[0];
  eq([Number(reg_lab.unit_price)], [60], "regular rates: the job keeps its day's agreement price (60.00), not 57.00");
  const frozen = await one(`SELECT rules->>'overtime_mode' AS mode, minimum_margin_percent::float8 AS m FROM public.job_frozen_rules WHERE job_id = '${job}'`);
  eq(frozen.mode, "daily", "General rules: the job keeps the overtime mode of its day (daily, not weekly)");
  eq((await one(`SELECT overtime_mode FROM public.billing_general_rules`)).overtime_mode, "weekly", "while the company moved on");
  eq(await n(`SELECT count(*)::int AS n FROM public.job_frozen_rules WHERE job_id = '${oldJob}'`), 0, "an existing job has no frozen rules: it reads as before");
  check(
    (await n(`SELECT jsonb_array_length(charges)::int AS n FROM public.job_frozen_rules WHERE job_id = '${job}'`)) >= 5,
    "charges are frozen with it",
  );

  /* ---- 4: a T&M job's estimate predicts its bill ----------------------------- */
  const price = async (j, code) => {
    const r = (await as(admin, `SELECT unit_price, source FROM public.regular_price_book('${j}', '${falcon}', '${nj}', NULL, current_date) WHERE code = '${code}'`)).rows[0];
    return [r.unit_price == null ? null : Number(r.unit_price), r.source];
  };
  const sclRate = Number((await one(`SELECT value FROM public.resolve_money_value('tm_rates', 'SCL', 'bill_rate', '${nj}', current_date)`)).value);
  eq(await price(job, "SCL"), [sclRate, "tm"], "on a T&M job, a T&M item prices at its T&M rate");
  eq(await price(job, "GSC-MOLD-INSP"), [350, "default"], "a regular-only item falls through the chain");
  eq((await price(reg, "SCL"))[1] === "tm", false, "a regular job never prices from T&M");

  /* ---- 5: strip lines equal to Standard ------------------------------------ */
  await db.exec(`
    INSERT INTO public.price_list_items (price_list_id, catalog_item_id, unit_price)
    SELECT '11000000-0000-4000-8000-000000000004', id, 350 FROM public.estimate_catalog_items WHERE code = 'GSC-MOLD-INSP'
    ON CONFLICT DO NOTHING;`);
  await refuses(as(dev, `SELECT public.agreements_save('[{"op":"strip_standard","agreement_id":"11000000-0000-4000-8000-000000000004"}]'::jsonb, 'x')`), /owner or admin/, "only an owner or admin strips");
  await as(owner, `SELECT public.agreements_save('[{"op":"strip_standard","agreement_id":"11000000-0000-4000-8000-000000000004"}]'::jsonb, 'Lean it')`);
  eq(
    (await db.query(`SELECT e.code, i.unit_price::float8 AS p FROM public.price_list_items i JOIN public.estimate_catalog_items e ON e.id = i.catalog_item_id WHERE i.price_list_id = '11000000-0000-4000-8000-000000000004' ORDER BY e.code`)).rows.map((r) => [r.code, r.p]),
    [["GSC-LABOR-REG", 62]],
    "the line equal to Standard (350.00) goes; the real exception (62.00) stays",
  );
  check((await n(`SELECT count(*)::int AS n FROM public.money_audit_log WHERE note = 'Lean it'`)) === 1, "the strip is audited with its note");
} finally {
  await db.close();
}

console.log(`billing-costs-one-book.pglite: ${assertions} assertions passed`);
