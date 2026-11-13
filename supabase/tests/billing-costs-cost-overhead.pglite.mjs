// Run with: node supabase/tests/billing-costs-cost-overhead.pglite.mjs <existing PGlite dist/index.js>
// In-memory fixtures only. No connection string, network access or live writes.
//
// Billing & Costs, prompt 3 (migration 20261031120000, READ FROM THE FILE),
// on top of the real T&M, prompt-1 and prompt-2 migrations it builds on.
//
// What it proves:
//   1. every cost on file is carried: each code's cost resolves to its old
//      cost; each equipment type takes the day cost most of its units carry,
//      else the field-ticket card's; nothing about a unit changes;
//   2. the engine's Wage is the field crew's labour_rates history, and today
//      resolves to what crew_rate_for answers at every office; seeding the
//      engine changes no labor cost;
//   3. composition: a publish sums the components into the true cost of a
//      field-labor hour, per office where they differ, and auto-fills every
//      FIELD labor code (never a management title) from the publish date; a
//      back-dated publish reaches later fills; Wage still publishes into
//      labour_rates (Gold Star crew and the crew role), temps beside it;
//   4. freeze: an old job (no sheet) and a frozen job keep their labor cost
//      through any publish; a new job freezes the cost of its day;
//   5. cost_save: admins only, never a field labor cost, equipment day costs
//      today only and copied onto the type's units, labor class switches;
//   6. access: the engine is owner/admin only; costs are the cost roles';
//      the rest of the audit log is administrators'; the engine needs a note;
//   7. equipment types: add (and to the register's enum), rename, archive,
//      all audited; 305/306 stay flagged with the evidence.
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
];
const P3 = read("20261031120000_billing_costs_cost_and_overhead.sql");

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
const crew = "22222222-2222-4222-8222-222222222222";
const finance = "33333333-3333-4333-8333-333333333333";
const ny = "aaaaaaaa-0000-4000-8000-00000000000a";
const nj = "bbbbbbbb-0000-4000-8000-00000000000b";
const oldJob = "cccccccc-0000-4000-8000-00000000000c";
const frozenJob = "dddddddd-0000-4000-8000-00000000000d";

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
    CREATE TYPE public.app_role AS ENUM ('owner', 'admin', 'dev', 'crew', 'field', 'finance', 'seller');
    CREATE TABLE public.user_roles (user_id uuid, role public.app_role);
    CREATE FUNCTION public.is_privileged(_user_id uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
      $$ SELECT EXISTS (SELECT 1 FROM public.user_roles
                         WHERE user_id = _user_id AND role IN ('owner', 'admin', 'dev')) $$;
    GRANT EXECUTE ON FUNCTION public.is_privileged(uuid) TO authenticated;
    CREATE FUNCTION public.can_view_finance(_user_id uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
      $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = 'finance') $$;
    CREATE FUNCTION public.has_permission(_user_id uuid, _key text, _location_id uuid DEFAULT NULL)
      RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
    CREATE FUNCTION public.can_view_job(_user_id uuid, _job_id uuid)
      RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT _user_id IS NOT NULL $$;
    CREATE FUNCTION public.can_view_job_costs(_job_id uuid)
      RETURNS boolean LANGUAGE plpgsql STABLE AS $$ BEGIN RETURN public.can_see_costs(auth.uid()); END $$;

    CREATE TABLE public.locations (id uuid PRIMARY KEY, name text);
    CREATE TABLE public.jobs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid,
      billing_location_id uuid, created_at timestamptz NOT NULL DEFAULT now());
    GRANT SELECT, INSERT ON public.jobs TO authenticated;
    CREATE TABLE public.job_tm_forms (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid, kind text, payload jsonb);
    CREATE TABLE public.estimate_catalog_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text, default_unit_price numeric,
      is_active boolean NOT NULL DEFAULT true);
    CREATE TABLE public.app_settings (
      key text PRIMARY KEY, value jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid);
    INSERT INTO public.app_settings VALUES
      ('tm.bill_rules', '{"dailyOtAfterHours": 8}', now(), NULL),
      ('equipment_day_rates', '{"day_rates": {"air_mover": 5, "dehumidifier": 20, "scrubber": 10,
        "injector": 10, "ozone": 10, "hydroxyl": 20, "generator": 10}}', now(), NULL);

    CREATE TYPE public.equipment_type AS ENUM
      ('air_mover','dehumidifier','air_scrubber','hepa','heater','generator','moisture_meter','other');
    CREATE TABLE public.equipment (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), asset_tag text,
      equipment_type public.equipment_type NOT NULL, location_id uuid NOT NULL,
      daily_rate_cents integer);
    CREATE TABLE public.labour_rates (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid, user_id uuid,
      role public.app_role, crew_class text, hourly_rate numeric(10,2) NOT NULL,
      effective_from date NOT NULL, effective_to date, note text, created_by uuid,
      created_at timestamptz NOT NULL DEFAULT now());

    INSERT INTO public.profiles VALUES ('${owner}', true), ('${admin}', true), ('${dev}', true),
      ('${crew}', true), ('${finance}', true);
    INSERT INTO public.user_roles VALUES ('${owner}', 'owner'), ('${admin}', 'admin'),
      ('${dev}', 'dev'), ('${crew}', 'crew'), ('${finance}', 'finance');
    INSERT INTO public.locations VALUES ('${ny}', 'Brooklyn'), ('${nj}', 'Lakewood');
    INSERT INTO public.jobs (id, location_id, created_at) VALUES ('${oldJob}', '${nj}', '2026-01-15');

    -- Equipment units: three air movers at $5, one at $7; one dehumidifier unpriced.
    INSERT INTO public.equipment (asset_tag, equipment_type, location_id, daily_rate_cents) VALUES
      ('AM-1', 'air_mover', '${ny}', 500), ('AM-2', 'air_mover', '${ny}', 500),
      ('AM-3', 'air_mover', '${nj}', 500), ('AM-4', 'air_mover', '${nj}', 700),
      ('DH-1', 'dehumidifier', '${nj}', NULL);

    -- Field crew wage history: default $45 since 2020; NJ $48 for a spell; NY $50 since May.
    INSERT INTO public.labour_rates (crew_class, location_id, hourly_rate, effective_from, effective_to) VALUES
      ('gsr', NULL, 45, '2020-01-01', NULL),
      ('gsr', '${nj}', 48, '2026-03-01', '2026-06-30'),
      ('gsr', '${ny}', 50, '2026-05-01', NULL),
      ('temp', NULL, 45, '2020-01-01', NULL),
      -- Back-dated over by the old publisher: closed before it started, never in force.
      ('gsr', NULL, 99, '2026-10-01', '2026-09-14');
    INSERT INTO public.labour_rates (role, location_id, hourly_rate, effective_from) VALUES
      ('crew', NULL, 45, '2020-01-01'), ('owner', NULL, 120, '2026-01-01');
  `);
  for (const m of MIGRATIONS) await db.exec(read(m));
  await db.exec(`DELETE FROM public.job_tm_rates WHERE job_id = '${oldJob}'`);
  // Costs typed on the old page before the rebuild.
  await db.exec(`
    UPDATE public.tm_rate_codes SET cost_rate = 52.80 WHERE code = 'SCL';
    UPDATE public.tm_rate_codes SET cost_rate = 60 WHERE code = 'PCT';
    UPDATE public.tm_rate_codes SET cost_rate = 80 WHERE code = '104';
    UPDATE public.tm_rate_codes SET cost_rate = 12 WHERE code = '302';
  `);
  // A job made the day before the rebuild ships, with a frozen sheet.
  await db.exec(`INSERT INTO public.jobs (id, location_id) VALUES ('${frozenJob}', '${ny}')`);

  await db.exec(P3);
  await db.exec(P3);
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
  const val = async (book, key, measure, office, on) => {
    const r = await one(
      `SELECT value, source FROM public.resolve_money_value('${book}', '${key}', '${measure}', ${office ? `'${office}'` : "NULL"}, ${on ? `'${on}'` : "current_date"})`,
    );
    return r ? (r.value == null ? null : Number(r.value)) : null;
  };
  const cost = (key, office, on) => val("cost", key, "cost_rate", office, on);
  const wage = (office, on) => val("overhead", "wage", "cost_hr", office, on);
  const total = async (office, on) =>
    Number(
      (
        await one(
          `SELECT public.overhead_total(${office ? `'${office}'` : "NULL"}, ${on ? `'${on}'` : "current_date"}) AS t`,
        )
      ).t,
    );
  const engine = (uid, changes, note = "2026 renewal") =>
    as(
      uid,
      `SELECT public.overhead_save('${JSON.stringify(changes).replace(/'/g, "''")}'::jsonb, ${note === null ? "NULL" : `'${note}'`}) AS n`,
    );
  const costSave = (uid, changes, note = "") =>
    as(uid, `SELECT public.cost_save('${JSON.stringify(changes)}'::jsonb, '${note}') AS n`);
  const jobCost = async (uid, job, code) => {
    const r = (
      await as(
        uid,
        `SELECT cost_rate, source FROM public.tm_cost_rates('${job}') WHERE item_key = '${code}'`,
      )
    ).rows[0];
    return r ? [r.cost_rate == null ? null : Number(r.cost_rate), r.source] : null;
  };
  const today = (await one(`SELECT current_date::text AS d`)).d;
  const plus = async (d) => (await one(`SELECT (current_date + ${d})::text AS d`)).d;
  const yesterday = await plus(-1);

  /* ---- 1: the cost seed ------------------------------------------------- */
  eq(
    await n(`SELECT count(*)::int AS n FROM public.tm_rate_codes t
              WHERE t.cost_rate IS NOT NULL
                AND (SELECT value FROM public.resolve_money_value('cost', t.code, 'cost_rate', '${nj}', '2001-06-01'))
                    IS DISTINCT FROM t.cost_rate`),
    0,
    "every code's cost resolves to its old cost, at any office, back to 2001",
  );
  eq(
    await n(`SELECT count(*)::int AS n FROM public.money_values
              WHERE book = 'cost' AND item_key NOT LIKE 'EQ:%'`),
    4,
    "one default row per costed code — and none added by the re-run",
  );
  eq(await cost("EQ:air_mover"), 5, "an equipment type takes the day cost most of its units carry");
  eq(await cost("EQ:dehumidifier"), 20, "an unpriced type takes the field-ticket card's day cost");
  eq(await cost("EQ:air_scrubber"), 10, "the card's generic scrubber is the Air scrubber type");
  eq(await cost("EQ:heater"), null, "a type nobody priced stays a gap");
  eq(
    (await db.query(`SELECT asset_tag, daily_rate_cents FROM public.equipment ORDER BY asset_tag`))
      .rows.map((r) => r.daily_rate_cents),
    [500, 500, 500, 700, null],
    "no unit's own day cost is touched by the seed",
  );
  check(
    (await one(`SELECT value FROM public.app_settings WHERE key = 'equipment_day_rates'`)).value
      .day_rates.hydroxyl === 20,
    "ticket-only classes stay on the field-ticket card",
  );

  /* ---- labor class -------------------------------------------------------- */
  const cls = async (code) =>
    (await one(`SELECT labor_class FROM public.catalog_items WHERE code = '${code}'`))?.labor_class;
  eq(await cls("SCL"), "field", "a field title is field");
  eq(await cls("PCT"), "management", "a title without Small Tools is management");
  eq(await cls("104"), null, "a consumable has no labor class");

  /* ---- 2: the wage seed --------------------------------------------------- */
  eq(await wage(null), 45, "default wage is the field crew's company-wide rate");
  eq(await wage(ny), 50, "NY wage is NY's own rate");
  eq(await wage(nj, "2026-04-01"), 48, "NJ's spell resolves inside its dates");
  eq(await wage(nj), 45, "after NJ's rate ended, NJ is back on the company-wide rate");
  eq(await total(null), 45, "the engine's total is the wage until anything else is entered");
  eq(
    await n(`SELECT count(*)::int AS n FROM public.money_values WHERE book = 'overhead' AND value = 99`),
    0,
    "a rate that was never in force is not carried",
  );
  eq(await cost("SCL"), 52.8, "seeding the engine changes no labor cost");

  /* ---- 6: access ---------------------------------------------------------- */
  await refuses(engine(dev, [{ op: "apply" }]), /owner or admin/, "a dev may not touch the engine");
  await refuses(engine(crew, [{ op: "apply" }]), /owner or admin/, "nor may crew");
  await refuses(engine(admin, [{ op: "apply" }], null), /needs a note/, "the engine needs a note");
  await refuses(engine(admin, [{ op: "apply" }], "  "), /needs a note/, "a blank note is no note");
  eq(
    (await as(crew, `SELECT count(*)::int AS n FROM public.money_values WHERE book IN ('overhead', 'cost')`))
      .rows[0].n,
    0,
    "crew read no cost and no overhead",
  );
  eq(
    (await as(finance, `SELECT count(*)::int AS n FROM public.money_values WHERE book = 'overhead'`))
      .rows[0].n,
    0,
    "finance reads costs, never the engine",
  );
  check(
    (await as(finance, `SELECT count(*)::int AS n FROM public.money_values WHERE book = 'cost'`))
      .rows[0].n > 0,
    "finance reads costs",
  );
  check(
    (await as(admin, `SELECT count(*)::int AS n FROM public.overhead_components`)).rows[0].n === 3,
    "an admin reads the three standard components",
  );
  eq(
    (await as(dev, `SELECT count(*)::int AS n FROM public.overhead_components`)).rows[0].n,
    0,
    "a dev does not see the engine",
  );

  /* ---- 3: composition and auto-fill -------------------------------------- */
  await engine(owner, [
    { op: "value", component: "general_liability", office_id: null, value: 3 },
    { op: "value", component: "workers_comp", office_id: null, value: 1.5 },
  ]);
  eq(await total(null), 49.5, "45 + 3 + 1.50 = 49.50 per field hour");
  eq(await total(ny), 54.5, "NY: its own 50 wage + 3 + 1.50 = 54.50");
  eq(await total(nj), 49.5, "NJ inherits every component");
  eq(await cost("SCL"), 49.5, "the default field labor cost is the engine's, from today");
  eq(await cost("SCL", ny), 54.5, "NY's field labor cost is NY's engine total");
  eq(
    await n(`SELECT count(*)::int AS n FROM public.money_values
              WHERE book = 'cost' AND item_key = 'SCL' AND office_id = '${nj}'`),
    0,
    "an office in line with the default gets no row of its own",
  );
  eq(await cost("SCL", null, yesterday), 52.8, "yesterday's labor cost is untouched");
  eq(await cost("PCT"), 60, "a management title is never auto-filled");
  eq(
    await n(`SELECT count(*)::int AS n FROM public.catalog_items ci
              WHERE ci.category = 'labor' AND ci.labor_class = 'field' AND ci.archived_at IS NULL
                AND (SELECT value FROM public.resolve_money_value('cost', ci.code, 'cost_rate', NULL, current_date))
                    IS DISTINCT FROM 49.5`),
    0,
    "every field labor code is auto-filled",
  );

  // Wage keeps publishing into labour_rates for the running cost.
  await engine(admin, [{ op: "value", component: "wage", office_id: null, value: 46 }], "Raise");
  eq(await total(null), 50.5, "46 + 3 + 1.50");
  const lr = async (where) =>
    (
      await db.query(
        `SELECT hourly_rate::numeric::float8 AS r, effective_from::text AS f, effective_to::text AS t
           FROM public.labour_rates WHERE ${where} ORDER BY effective_from`,
      )
    ).rows.map((r) => [r.r, r.f, r.t]);
  eq(
    await lr(`crew_class = 'gsr' AND location_id IS NULL AND hourly_rate <> 99`),
    [
      [45, "2020-01-01", yesterday],
      [46, today, null],
    ],
    "the field crew's company-wide rate is superseded, not edited",
  );
  eq(
    await lr(`role = 'crew' AND location_id IS NULL`),
    [
      [45, "2020-01-01", yesterday],
      [46, today, null],
    ],
    "the crew role follows the wage",
  );
  eq(await lr(`role = 'owner'`), [[120, "2026-01-01", null]], "an Owner rate on file is untouched");

  // NY resets to the default wage: NY's total falls in line; its labor row resets.
  await engine(admin, [{ op: "value", component: "wage", office_id: ny, value: null }], "NY back");
  eq(await total(ny), 50.5, "NY back on the default wage");
  eq(await cost("SCL", ny), 50.5, "NY's field labor cost follows");
  eq(
    await lr(`crew_class = 'gsr' AND location_id = '${ny}'`),
    [[50, "2026-05-01", yesterday]],
    "NY's own crew rate closes; the company-wide one applies",
  );

  // A later publish, then a back-dated one between: the later fill is redone.
  const d10 = await plus(10);
  const d30 = await plus(30);
  await engine(admin, [{ op: "value", component: "general_liability", office_id: null, value: 4, effective_from: d30 }]);
  eq(await cost("SCL", null, d30), 51.5, "a future publish fills on its own date");
  eq(await cost("SCL"), 50.5, "and not before");
  await engine(admin, [{ op: "value", component: "workers_comp", office_id: null, value: 2, effective_from: d10 }]);
  eq(await cost("SCL", null, d10), 51, "the back-dated publish fills on its date");
  eq(await cost("SCL", null, d30), 52, "and the later fill now includes it: 46 + 4 + 2");

  // An added component counts from its date; archiving stops it.
  await engine(owner, [{ op: "add", name: "Vehicle allowance", note: "Truck per hour", value: 2 }]);
  eq(
    (await one(`SELECT key FROM public.overhead_components WHERE name = 'Vehicle allowance'`)).key,
    "c_vehicle_allowance",
    "an added component gets a key from its name",
  );
  eq(await total(null), 52.5, "46 + 3 + 1.50 + 2");
  eq(await cost("SCL"), 52.5, "and labor follows at once");
  await refuses(
    engine(owner, [{ op: "add", name: "vehicle ALLOWANCE" }]),
    /already a component/,
    "duplicate names are refused",
  );
  await refuses(
    engine(owner, [{ op: "archive", component: "workers_comp" }]),
    /standard component is kept/,
    "a standard component cannot be archived",
  );
  await engine(owner, [{ op: "archive", component: "c_vehicle_allowance" }], "Dropped");
  eq(await total(null), 50.5, "an archived component no longer counts");
  eq(await total(null, yesterday), 45, "history is as it was: yesterday was the wage alone");

  // Temps: labour_rates only, audited, not in the engine.
  await engine(admin, [{ op: "temp_wage", office_id: null, value: 38 }], "Agency rate");
  eq(
    await lr(`crew_class = 'temp' AND location_id IS NULL`),
    [
      [45, "2020-01-01", yesterday],
      [38, today, null],
    ],
    "the temp crew rate is published like the old card did",
  );
  eq(await total(null), 50.5, "temps are not part of the engine");

  await refuses(
    engine(admin, [{ op: "value", component: "wage", office_id: null, value: 46.125 }]),
    /Dollars and cents/,
    "whole cents only",
  );
  await refuses(
    engine(admin, [{ op: "value", component: "wage", office_id: null, value: 47, effective_from: "2026-01-01" }]),
    /today or later/,
    "never back in time",
  );
  check(
    (await as(admin, `SELECT count(*)::int AS n FROM public.money_audit_log
                       WHERE book = 'overhead' AND note = '2026 renewal'`)).rows[0].n >= 2,
    "every engine change is audited with its note",
  );

  /* ---- 4: freeze ---------------------------------------------------------- */
  eq(await jobCost(admin, oldJob, "SCL"), [52.8, "default"], "an old job reads the cost of its day");
  eq(await jobCost(admin, frozenJob, "SCL"), [52.8, "job"], "a frozen job reads its own sheet");
  eq(await jobCost(crew, oldJob, "SCL"), null, "crew read no job cost");
  const newJob = (
    await one(`INSERT INTO public.jobs (location_id) VALUES ('${nj}') RETURNING id::text AS id`)
  ).id;
  eq(await jobCost(admin, newJob, "SCL"), [50.5, "job"], "a new job freezes today's engine cost");
  await engine(admin, [{ op: "value", component: "wage", office_id: null, value: 60 }], "Big raise");
  eq(await jobCost(admin, oldJob, "SCL"), [52.8, "default"], "the old job is unchanged by a new publish");
  eq(await jobCost(admin, frozenJob, "SCL"), [52.8, "job"], "so is the frozen one");
  eq(await jobCost(admin, newJob, "SCL"), [50.5, "job"], "and the job made this morning");

  /* ---- 5: cost_save ------------------------------------------------------- */
  await refuses(
    costSave(crew, [{ op: "cost", item_key: "PCT", office_id: null, value: 61 }]),
    /Only an administrator/,
    "crew may not change costs",
  );
  await refuses(
    costSave(admin, [{ op: "cost", item_key: "SCL", office_id: null, value: 40 }]),
    /computed by the overhead engine/,
    "a field labor cost is never typed",
  );
  await costSave(dev, [{ op: "cost", item_key: "PCT", office_id: null, value: 62 }], "Mgmt");
  eq(await cost("PCT"), 62, "a management title's cost is typed");
  await costSave(admin, [{ op: "cost", item_key: "EQ:air_mover", office_id: nj, value: 6 }]);
  await costSave(admin, [{ op: "cost", item_key: "EQ:air_mover", office_id: null, value: 5.5 }]);
  eq(
    (await db.query(`SELECT daily_rate_cents FROM public.equipment WHERE equipment_type = 'air_mover' ORDER BY asset_tag`))
      .rows.map((r) => r.daily_rate_cents),
    [550, 550, 600, 600],
    "an equipment day cost reaches its units: NY the default, NJ its own",
  );
  await refuses(
    costSave(admin, [{ op: "cost", item_key: "EQ:air_mover", office_id: null, value: 7, effective_from: d10 }]),
    /takes effect today/,
    "an equipment day cost cannot be future-dated",
  );
  await refuses(
    costSave(admin, [
      { op: "cost", item_key: "104", office_id: null, value: 81 },
      { op: "cost", item_key: "104", office_id: null, value: null },
    ]),
    /needs a cost/,
    "all or nothing",
  );
  eq(await cost("104"), 80, "the refused save left nothing behind");
  await costSave(admin, [{ op: "labor_class", code: "PCT", class: "field" }]);
  eq(await cost("PCT"), 64.5, "a title switched to field takes the engine's cost: 60 + 3 + 1.50");

  /* ---- 6: audit access ------------------------------------------------------ */
  const books = async (uid) =>
    (
      await as(uid, `SELECT DISTINCT book FROM public.money_audit_log ORDER BY book`)
    ).rows.map((r) => r.book);
  eq(await books(crew), [], "crew read nothing in the audit log");
  eq(await books(finance), ["cost"], "finance reads cost entries only");
  check(!(await books(dev)).includes("overhead"), "a dev reads everything but the engine");
  check((await books(owner)).includes("overhead"), "an owner reads the engine's history");
  check(
    (await as(admin, `SELECT count(*)::int AS n FROM public.money_audit_log
                       WHERE book = 'cost' AND entity = 'catalog_item' AND field = 'labor_class'`))
      .rows[0].n === 1,
    "a labor class switch is audited",
  );

  /* ---- 7: equipment types ------------------------------------------------- */
  const typeSave = (uid, action, type) =>
    as(uid, `SELECT public.equipment_type_save('${action}', '${JSON.stringify(type)}'::jsonb, 'Ticket class') AS k`);
  await refuses(typeSave(crew, "add", { label: "Injector" }), /Only an administrator/, "crew may not add types");
  eq(
    (await typeSave(admin, "add", { label: "Injector", default_make: "Injectidry" })).rows[0].k,
    "injector",
    "a type is added with a key from its name",
  );
  check(
    (await one(`SELECT 'injector' = ANY(enum_range(NULL::public.equipment_type)::text[]) AS ok`)).ok,
    "and joins the register's enum",
  );
  await db.exec(
    `INSERT INTO public.equipment (asset_tag, equipment_type, location_id) VALUES ('IN-1', 'injector', '${nj}')`,
  );
  check(true, "a unit of the new type can be registered");
  await refuses(typeSave(admin, "add", { label: "injector" }), /already a type/, "no duplicate names");
  await typeSave(admin, "edit", { key: "injector", label: "Drying injector", default_model: "HP-60" });
  await typeSave(admin, "archive", { key: "injector" });
  eq(
    await one(`SELECT label, default_make, default_model, active, archived_at IS NOT NULL AS archived
                 FROM public.equipment_types WHERE key = 'injector'`),
    {
      label: "Drying injector",
      default_make: "Injectidry",
      default_model: "HP-60",
      active: false,
      archived: true,
    },
    "renamed, given a default model, archived — never deleted",
  );
  eq(
    (await db.query(`SELECT field FROM public.money_audit_log WHERE entity = 'equipment_type'
                       AND entity_key = 'injector' ORDER BY id`)).rows.map((r) => r.field),
    ["created", "label", "default_model", "archived"],
    "every type change is audited",
  );
  const review = (
    await one(`SELECT equipment_type, equipment_type_review FROM public.tm_rate_codes WHERE code = '305'`)
  );
  check(
    review.equipment_type === null && /Scrubber XXL/.test(review.equipment_type_review),
    "305 stays flagged, with the evidence",
  );
} finally {
  await db.close();
}

console.log(`billing-costs-cost-overhead.pglite: ${assertions} assertions passed`);
