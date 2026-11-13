// Run with: node supabase/tests/billing-costs-agreements.pglite.mjs <existing PGlite dist/index.js>
// In-memory fixtures only. No connection string, network access or live writes.
//
// Billing & Costs, prompt 4 (migration 20261101120000, READ FROM THE FILE),
// on top of the real T&M and prompt 1–3 migrations it builds on.
//
// What it proves:
//   1. Standard rates carry today's prices exactly: the catalog default, and
//      each office's branch list;
//   2. the chain, level by level, to the cent: job line → client agreement →
//      office Standard → state list → company Standard → none;
//   3. an agreement is exceptions only: a Standard change reaches every
//      line it does not override, live;
//   4. a new regular job freezes its rates; a later agreement or Standard
//      change does not move it; the rate source and custom lines; a job's
//      custom lines become a standing agreement;
//   5. owner/admin only, note required, duplicate names refused, audited;
//   6. the Estimate catalog merges into Catalogs with counts that add up;
//      regular items never reach the T&M sheet; Catalogs edits reach the
//      estimate row; a new regular item with no price is "none";
//   7. P3 follow-ups: 305/306 → Air scrubber; HEPA units stay where moving
//      them would re-price; injector/ozone/hydroxyl types with costs;
//      equipment day costs in fractions of a cent.
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
  await db.exec(P4);
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
  const price = async (code, { job, account, office: off, state, on, agreement, standard } = {}, uid = admin) => {
    const r = (
      await as(
        uid,
        `SELECT unit_price, source FROM public.regular_price_book(${q(job)}, ${q(account)}, ${q(off)}, ${q(state)},
           ${on ? `'${on}'` : "current_date"}, ${q(agreement)}, ${standard ? "true" : "false"}) WHERE code = '${code}'`,
      )
    ).rows[0];
    return r ? [r.unit_price == null ? null : Number(r.unit_price), r.source] : null;
  };
  const agreements = (uid, changes, note = "Signed 2026") =>
    as(uid, `SELECT public.agreements_save('${JSON.stringify(changes).replace(/'/g, "''")}'::jsonb, ${note === null ? "NULL" : `'${note}'`}) AS id`);
  const standard = (uid, changes, note = "") =>
    as(uid, `SELECT public.standard_save('${JSON.stringify(changes)}'::jsonb, '${note}') AS n`);

  /* ---- 1: Standard carries today's prices -------------------------------- */
  eq(await price("GSC-LABOR-REG"), [65, "default"], "company Standard is the catalog default");
  eq(await price("GSC-LABOR-REG", { office: nj }), [70, "location"], "NJ keeps its branch price as its Standard");
  eq(await price("GSC-LABOR-REG", { office: ny }), [65, "default"], "NY has no branch list: the default");
  eq(
    (await db.query(`SELECT name, kind FROM public.price_lists ORDER BY lower(name)`)).rows.map((r) => [r.name, r.kind]),
    [
      ["Acme labor rate", "agreement"],
      ["Falcon", "agreement"],
      ["New York state", "state"],
      ["NJ branch", "office"],
    ],
    "every list becomes an agreement, an office list (now Standard) or a state list",
  );

  /* ---- 2: the chain, level by level -------------------------------------- */
  eq(await price("GSC-LABOR-REG", { account: falcon, office: nj }), [60, "account"], "Falcon's agreement beats NJ's office price");
  eq(await price("GSC-EQ-AIR-MOVER", { account: falcon, office: ny, state: "NY" }), [50, "state"], "silence in the agreement falls to the state list");
  eq(await price("GSC-EQ-AIR-MOVER", { account: falcon, office: ny }), [45, "default"], "and with no state, to Standard");
  eq(await price("GSC-LABOR-REG", { account: acme, office: nj }), [62, "account"], "Acme's old labor rate is now its agreement");
  eq(await price("GSC-LABOR-REG", { account: falcon, office: nj, standard: true }), [70, "location"], "a job on Standard skips the agreement");
  eq(await price("GSC-LABOR-REG", { account: falcon, office: nj, on: "2026-01-15" }), [70, "location"], "an agreement not yet in force does not apply");

  /* ---- 3: exceptions only, live ------------------------------------------- */
  await refuses(standard(dev, [{ code: "GSC-EQ-AIR-MOVER", office_id: null, value: 47 }]), /owner or admin/, "a dev may not change Standard");
  await standard(admin, [{ code: "GSC-EQ-AIR-MOVER", office_id: null, value: 47 }], "2026 sheet");
  eq(await price("GSC-EQ-AIR-MOVER", { account: falcon, office: ny }), [47, "default"], "Falcon's inherited line follows Standard at once");
  eq(await price("GSC-LABOR-REG", { account: falcon, office: ny }), [60, "account"], "its exception does not move");
  eq(
    Number((await one(`SELECT default_unit_price FROM public.estimate_catalog_items WHERE code = 'GSC-EQ-AIR-MOVER'`)).default_unit_price),
    47,
    "the catalog default follows Standard for the readers that use it",
  );

  /* ---- 4: jobs ------------------------------------------------------------- */
  eq(await n(`SELECT count(*)::int AS n FROM public.job_regular_rates WHERE job_id = '${oldJob}'`), 0, "an existing job is untouched");
  eq(await price("GSC-LABOR-REG", { job: oldJob, account: falcon, office: nj }), [60, "account"], "and resolves live, as today");
  const newJob = (await one(`INSERT INTO public.jobs (location_id, account_id) VALUES ('${nj}', '${falcon}') RETURNING id::text AS id`)).id;
  const tmJob = (await one(`INSERT INTO public.jobs (location_id, account_id, job_type) VALUES ('${nj}', '${falcon}', 't_m') RETURNING id::text AS id`)).id;
  eq(await n(`SELECT count(*)::int AS n FROM public.job_regular_rates WHERE job_id = '${tmJob}'`), 0, "a T&M job freezes no regular sheet");
  const falconId = "11000000-0000-4000-8000-000000000003";
  await agreements(admin, [{ op: "line", agreement_id: falconId, code: "GSC-LABOR-REG", value: 58 }]);
  await standard(admin, [{ code: "GSC-EQ-AIR-MOVER", office_id: null, value: 49 }]);
  eq(await price("GSC-LABOR-REG", { job: newJob, account: falcon, office: nj }), [60, "job"], "a new job keeps the agreement price of its day");
  eq(await price("GSC-EQ-AIR-MOVER", { job: newJob, account: falcon, office: nj }), [47, "job"], "and the Standard price of its day");
  eq(await price("GSC-LABOR-REG", { account: falcon, office: nj }), [58, "account"], "while a new document gets today's agreement");

  await refuses(as(seller, `SELECT public.job_rate_source_set('${newJob}', 'standard')`), /office or a manager/, "sales never set a job's rates");
  await as(office, `SELECT public.job_rate_source_set('${newJob}', 'standard', NULL, 'Client asked')`);
  eq(await price("GSC-LABOR-REG", { job: newJob, account: falcon, office: nj }), [70, "job"], "a job on Standard: NJ's price");
  const lab = (await one(`SELECT id::text AS id FROM public.estimate_catalog_items WHERE code = 'GSC-LABOR-REG'`)).id;
  await as(office, `SELECT public.job_rate_line_set('${newJob}', '${lab}', 55)`);
  eq(await price("GSC-LABOR-REG", { job: newJob, account: falcon, office: nj }), [55, "custom"], "a custom line for this job only");
  eq((await one(`SELECT rate_source FROM public.jobs WHERE id = '${newJob}'`)).rate_source, "custom", "the job is now Custom");
  eq(await price("GSC-LABOR-REG", { account: falcon, office: nj }), [58, "account"], "no other job moves");
  await refuses(as(office, `SELECT public.agreements_save('[{"op":"from_job","job_id":"${newJob}","name":"Falcon 2"}]'::jsonb, 'x')`), /owner or admin/, "only an owner makes it standing");
  const fromJob = (await agreements(owner, [{ op: "from_job", job_id: newJob, name: "Falcon storm rates" }])).rows[0].id;
  eq(
    (await db.query(`SELECT c.code, i.unit_price::float8 AS p FROM public.price_list_items i JOIN public.estimate_catalog_items c ON c.id = i.catalog_item_id WHERE i.price_list_id = '${fromJob}'`)).rows.map((r) => [r.code, r.p]),
    [["GSC-LABOR-REG", 55]],
    "the job's custom line becomes a standing agreement's only exception",
  );

  /* ---- 5: guards and audit ---------------------------------------------- */
  await refuses(agreements(admin, [{ op: "create", name: "falcon" }]), /already an agreement called/, "duplicate names are refused");
  await refuses(agreements(admin, [{ op: "create", name: "Brand new" }], null), /needs a note/, "a note is required");
  await refuses(agreements(dev, [{ op: "create", name: "Dev deal" }]), /owner or admin/, "a dev may not");
  await refuses(as(dev, `INSERT INTO public.price_lists (name) VALUES ('Sneaky')`), /row-level security/, "nor write the table directly");
  const made = (await agreements(admin, [
    { op: "create", name: "Harbor Mgmt" },
    { op: "line", agreement_id: "new", code: "GSC-MOLD-INSP", value: 300 },
    { op: "link", agreement_id: "new", account_id: acme, primary: true },
  ])).rows[0].id;
  eq(await price("GSC-MOLD-INSP", { account: acme, office: ny }), [300, "account"], "the primary agreement wins for its client");
  eq(await price("GSC-LABOR-REG", { account: acme, office: ny }), [65, "default"], "and silence inherits Standard, not the other agreement");
  check(
    (await n(`SELECT count(*)::int AS n FROM public.money_audit_log WHERE book = 'client_agreements' AND note = 'Signed 2026'`)) >= 4,
    "agreement changes are audited with their note",
  );
  check(!!made, "the created agreement's id comes back");

  /* ---- 6: the catalog merge ---------------------------------------------- */
  const merged = async (code) =>
    (await one(`SELECT ci.code, ci.category, ci.unit, ci.unit_review IS NOT NULL AS review, ci.in_tm, ci.in_regular
                  FROM public.catalog_items ci JOIN public.estimate_catalog_items e ON e.id = ci.estimate_item_id
                 WHERE e.code = '${code}'`));
  eq(await merged("SCL"), { code: "SCL", category: "labor", unit: "hr", review: false, in_tm: true, in_regular: true }, "same code: one item, in both books");
  eq((await merged("POLY-ROLL")).code, "104", "same name: linked to the T&M item");
  eq(await merged("GSC-LABOR-REG"), { code: "GSC-LABOR-REG", category: "labor", unit: "hr", review: false, in_tm: false, in_regular: true }, "regular labor added, not on the T&M sheet");
  eq((await merged("GSC-EQ-AIR-MOVER")).category, "equipment", "equipment by its header");
  eq(await merged("GSC-BASEBOARD"), { code: "GSC-BASEBOARD", category: "service", unit: null, review: true, in_tm: false, in_regular: true }, "an unknown unit is flagged");
  eq((await one(`SELECT reason FROM public.catalog_merge_review WHERE code = 'bad code!'`)).reason.startsWith("Its code cannot"), true, "a bad code is flagged");
  eq(
    await n(`SELECT (SELECT count(*) FROM public.catalog_items WHERE estimate_item_id IS NOT NULL)
               + (SELECT count(*) FROM public.catalog_merge_review)
               - (SELECT count(*) FROM public.estimate_catalog_items) AS n`),
    0,
    "every estimate item is merged or flagged",
  );
  eq(await n(`SELECT count(*)::int AS n FROM public.tm_rate_codes WHERE code LIKE 'GSC-%'`), 0, "no regular item reaches the T&M sheet");
  await as(admin, `SELECT public.catalog_save('[{"op":"update","code":"GSC-MOLD-INSP","name":"Mold inspection (visual)"}]'::jsonb, 'rename')`);
  eq((await one(`SELECT name FROM public.estimate_catalog_items WHERE code = 'GSC-MOLD-INSP'`)).name, "Mold inspection (visual)", "a Catalogs edit reaches the estimate row");
  await as(admin, `SELECT public.catalog_save('[{"op":"create","code":"GSC-DEMO","name":"Demolition","category":"service","unit":"hr"}]'::jsonb, 'new')`);
  eq(await price("GSC-DEMO"), [null, "none"], "a new regular item with no price is 'none', never a silent zero");
  eq(await n(`SELECT count(*)::int AS n FROM public.tm_rate_codes WHERE code = 'GSC-DEMO'`), 0, "and is not a T&M code");

  /* ---- 7: P3 follow-ups ---------------------------------------------------- */
  eq((await one(`SELECT equipment_type FROM public.tm_rate_codes WHERE code = '305'`)).equipment_type, "air_scrubber", "305 is an air scrubber");
  eq((await one(`SELECT equipment_type::text AS t FROM public.equipment WHERE asset_tag = 'HP-1'`)).t, "hepa", "HEPA units priced differently from Air scrubber stay put (flagged)");
  eq(
    (await db.query(`SELECT key FROM public.equipment_types WHERE key IN ('injector','ozone','hydroxyl') ORDER BY key`)).rows.map((r) => r.key),
    ["hydroxyl", "injector", "ozone"],
    "ticket classes are types",
  );
  eq(
    Number((await one(`SELECT value FROM public.resolve_money_value('cost', 'EQ:ozone', 'cost_rate', NULL, current_date)`)).value),
    12.5,
    "their day cost comes off the card",
  );
  await as(admin, `SELECT public.cost_save('[{"op":"cost","item_key":"EQ:air_mover","office_id":null,"value":3.3333}]'::jsonb, '')`);
  eq(
    Number((await one(`SELECT value FROM public.resolve_money_value('cost', 'EQ:air_mover', 'cost_rate', NULL, current_date)`)).value),
    3.3333,
    "an equipment day cost may carry fractions of a cent",
  );
  await refuses(
    as(admin, `SELECT public.cost_save('[{"op":"cost","item_key":"104","office_id":null,"value":3.333}]'::jsonb, '')`),
    /dollars and cents/,
    "other costs stay whole cents",
  );
} finally {
  await db.close();
}

console.log(`billing-costs-agreements.pglite: ${assertions} assertions passed`);
