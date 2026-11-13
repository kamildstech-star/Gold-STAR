// Run with: node supabase/tests/equipment-add-from-scan.pglite.mjs <PGlite dist/index.js>
// In-memory fixtures only — never the project's database.
//
// Runs the REAL 20261026160000_equipment_add_from_scan.sql and proves:
//   1. a manager adds an unknown plate: created, idle, audited (who, screen, job);
//   2. the same plate scanned without dashes, or registered to an office the
//      person cannot see, returns the EXISTING unit — never a twin;
//   3. crew (who may not manage the office) are refused with 42501;
//   4. a misread (not plate-shaped) is refused and nothing is written.
import { readFileSync, readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const MIGRATIONS = new URL("../migrations/", import.meta.url);
const name = readdirSync(MIGRATIONS).find((f) => f.startsWith("20261026160000"));
const SQL = readFileSync(new URL(name, MIGRATIONS), "utf8");

let assertions = 0;
const eq = (actual, expected, what) => {
  assert.deepEqual(actual, expected, what);
  assertions++;
};

const MANAGER = "aaaaaaaa-0000-4000-8000-000000000001";
const CREW = "aaaaaaaa-0000-4000-8000-000000000002";
const JOB = "bbbbbbbb-0000-4000-8000-000000000001";

const db = new PGlite();
await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
  CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
    $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  CREATE TABLE public.locations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text UNIQUE);
  INSERT INTO public.locations (code) VALUES ('NY'), ('NJ');
  CREATE TABLE public.jobs (id uuid PRIMARY KEY);
  INSERT INTO public.jobs VALUES ('${JOB}');
  CREATE TABLE public.managers (user_id uuid, location_id uuid);
  INSERT INTO public.managers SELECT '${MANAGER}', id FROM public.locations WHERE code = 'NY';
  CREATE FUNCTION public.can_manage_location(_u uuid, _l uuid) RETURNS boolean LANGUAGE sql STABLE AS
    $$ SELECT EXISTS (SELECT 1 FROM public.managers WHERE user_id = _u AND location_id = _l) $$;
  CREATE TYPE public.equipment_status AS ENUM
    ('available','on_job','in_transit','maintenance','lost','retired');
  CREATE TABLE public.equipment (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), asset_tag text NOT NULL UNIQUE,
    equipment_type text NOT NULL, location_id uuid NOT NULL REFERENCES public.locations(id),
    status public.equipment_status NOT NULL DEFAULT 'available', notes text,
    purchase_cost_cents integer, created_by uuid,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp());
  -- Already registered, in NJ — an office the NY manager cannot see.
  INSERT INTO public.equipment (asset_tag, equipment_type, location_id)
    SELECT 'GSR-AM00001-NY', 'air_mover', id FROM public.locations WHERE code = 'NJ';
`);
await db.exec(SQL);

const NY = (await db.query(`SELECT id FROM public.locations WHERE code='NY'`)).rows[0].id;
const as = (u) => db.exec(`SELECT set_config('request.jwt.claim.sub', '${u}', false)`);
const add = (tag, type = "dehumidifier", loc = NY) =>
  db.query(
    `SELECT outcome, asset_tag, equipment_type, status::text AS status
       FROM public.add_equipment_from_scan($1, $2, $3, 'left by the door', 'scan:equipment_setup', $4)`,
    [tag, type, loc, JOB],
  );
const count = async () =>
  (await db.query(`SELECT count(*)::int AS n FROM public.equipment`)).rows[0].n;

// 1. created, idle, audited
await as(MANAGER);
eq(
  (await add("gsr du00007 ny")).rows,
  [
    {
      outcome: "created",
      asset_tag: "GSR-DU00007-NY",
      equipment_type: "dehumidifier",
      status: "available",
    },
  ],
  "a manager adds an unknown plate, stored as printed",
);
eq(
  (
    await db.query(
      `SELECT created_by::text, created_via, created_job_id::text, notes FROM public.equipment WHERE asset_tag = 'GSR-DU00007-NY'`,
    )
  ).rows,
  [
    {
      created_by: MANAGER,
      created_via: "scan:equipment_setup",
      created_job_id: JOB,
      notes: "left by the door",
    },
  ],
  "who, from which screen, on which job",
);

// 2. no twins
eq(
  (await add("GSRDU00007NY")).rows[0].outcome,
  "existing",
  "same plate without dashes: the existing unit",
);
eq(
  (await add("GSRAM00001NY", "air_mover")).rows,
  [
    {
      outcome: "existing",
      asset_tag: "GSR-AM00001-NY",
      equipment_type: "air_mover",
      status: "available",
    },
  ],
  "registered to an office the person cannot see: handed back, not duplicated",
);
eq(await count(), 2, "no twin written");

// 3. crew refused
await as(CREW);
let refused = null;
try {
  await add("GSR-AS00099-NY", "air_scrubber");
} catch (e) {
  refused = e;
}
eq(refused?.code, "42501", "crew cannot add: 42501");
eq(/not_permitted/.test(refused?.message ?? ""), true, "says not_permitted");
// …but crew scanning a plate that IS registered (another spelling) still gets it.
eq((await add("gsr-du-00007-ny")).rows[0].outcome, "existing", "any dash grouping is the same key");
eq((await add("GSR DU00007 NY")).rows[0].outcome, "existing", "crew get the existing unit back");
eq(await count(), 2, "nothing written by crew");

// 4. misreads
await as(MANAGER);
for (const junk of ["HELLO", "1Z999AA10123456784", "GSRDU00008NY", ""]) {
  let err = null;
  try {
    await add(junk);
  } catch (e) {
    err = e;
  }
  eq(/not_a_tag/.test(err?.message ?? ""), true, `"${junk}" refused as not a tag`);
}
eq(await count(), 2, "no misread became a unit");

console.log(`equipment add from scan: ${assertions} assertions passed`);
