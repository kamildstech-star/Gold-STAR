// Run with: node supabase/tests/equipment-tag-register.pglite.mjs <PGlite dist/index.js>
// In-memory fixtures only — never the project's database.
//
// Runs the REAL 20261026120000_equipment_tag_register.sql against stand-in
// tables shaped like staging (the 22 Oct offices, Houston under code TX,
// upstate NY under NY-UP, an existing CAT office) and proves:
//   1. all 5,640 plates land, per sheet, with the right type and home office;
//   2. a unit already on the register is updated (type, office, printed
//      spelling) and never duplicated — matched dash/case-insensitively;
//   3. two units that tie once dashes are dropped are skipped, not guessed;
//   4. a unit out on a job keeps its status;
//   5. CAT1/CAT2 go to the CAT location, never a real office;
//   6. a SECOND run changes nothing;
//   7. with no CAT location and no roster map, CAT is created and the offices
//      are still found by code / city.
import { readFileSync, readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const MIGRATIONS = new URL("../migrations/", import.meta.url);
const name = readdirSync(MIGRATIONS).find((f) => f.startsWith("20261026120000"));
const SQL = readFileSync(new URL(name, MIGRATIONS), "utf8");

let assertions = 0;
const eq = (actual, expected, what) => {
  assert.deepEqual(actual, expected, what);
  assertions++;
};

const SCHEMA = `
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
  CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
  CREATE FUNCTION public.is_privileged(_u uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
  CREATE TABLE public.locations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text NOT NULL UNIQUE, name text NOT NULL,
    address text NOT NULL, locality text, region text NOT NULL, lat double precision NOT NULL,
    lon double precision NOT NULL, active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp());
  CREATE TYPE public.equipment_status AS ENUM
    ('available','on_job','in_transit','maintenance','lost','retired');
  CREATE TABLE public.equipment (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), asset_tag text NOT NULL UNIQUE,
    equipment_type text NOT NULL, make text, model text, serial_number text,
    location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE RESTRICT,
    status public.equipment_status NOT NULL DEFAULT 'available', notes text,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
`;

const OFFICES = `
  INSERT INTO public.locations (code, name, address, locality, region, lat, lon) VALUES
    ('NY','Brooklyn, NY','x','Brooklyn','NY',0,0), ('NJ','Lakewood, NJ','x','Lakewood','NJ',0,0),
    ('NC','Garner, NC','x','Garner','NC',0,0), ('GA','Atlanta, GA','x','Atlanta','GA',0,0),
    ('CA','Los Angeles, CA','x','Los Angeles','CA',0,0), ('MI','Southfield, MI','x','Southfield','MI',0,0),
    ('MD','Baltimore, MD','x','Baltimore','MD',0,0), ('IL','Skokie, IL','x','Skokie','IL',0,0),
    ('IN','Columbus, IN','x','Columbus','IN',0,0),
    ('TX','Gold Star Restoration HTX LLC','x','Houston','TX',0,0),
    ('NY-UP','NY-Upstate','x','Monsey','NY',0,0);
`;

const SHEETS = {
  NY: [400, 100, 50, "NY"],
  NYU: [350, 100, 50, "NY-UP"],
  NJ: [400, 100, 50, "NJ"],
  MD: [200, 50, 35, "MD"],
  MI: [250, 100, 50, "MI"],
  GA: [350, 100, 50, "GA"],
  HTX: [300, 50, 35, "TX"],
  NC: [400, 100, 50, "NC"],
  IL: [300, 200, 50, "IL"],
  IN: [200, 50, 35, "IN"],
  CA: [100, 50, 35, "CA"],
  CAT1: [300, 100, 50, "CAT"],
  CAT2: [300, 100, 50, "CAT"],
};
const total = (s) => s[0] + s[1] + s[2];

const counts = async (db) =>
  Object.fromEntries(
    (
      await db.query(
        `SELECT sheet, tags, created, updated, unchanged, skipped
           FROM public.equipment_tag_register_imports
          WHERE run_at = (SELECT max(run_at) FROM public.equipment_tag_register_imports)
          ORDER BY id`,
      )
    ).rows.map((r) => [r.sheet, [r.tags, r.created, r.updated, r.unchanged, r.skipped]]),
  );

/* ---------------- Scenario A: staging-shaped, with a CAT office ---------------- */
{
  const db = new PGlite();
  await db.exec(SCHEMA + OFFICES);
  await db.exec(`
    INSERT INTO public.locations (code, name, address, locality, region, lat, lon)
      VALUES ('CAT','Gold Star Restoration CAT LLC','x',NULL,'NY',0,0);
    -- The 22 Oct roster map, for the offices it knows.
    CREATE TABLE public.staff_roster_offices (key text PRIMARY KEY, location_id uuid, label text);
    INSERT INTO public.staff_roster_offices
      SELECT k, (SELECT id FROM public.locations WHERE code = c), k
        FROM (VALUES ('brooklyn','NY'),('monsey','NY-UP'),('lakewood','NJ'),('houston','TX'),
                     ('skokie','IL')) v(k, c);
    -- Already on the register before the import:
    INSERT INTO public.equipment (asset_tag, equipment_type, location_id, status, make, notes)
    VALUES
      -- exact tag, wrong type and office: updated
      ('GSR-AM00001-NJ','other',(SELECT id FROM public.locations WHERE code='NY'),'available','Dri-Eaz','keep me'),
      -- typed with spaces, lower case: the same plate, respelt as printed
      ('gsr am00002 nj','air_mover',(SELECT id FROM public.locations WHERE code='NJ'),'maintenance',NULL,NULL),
      -- two different units that tie once dashes go: skipped, not guessed
      ('GSRAM00003NJ','air_mover',(SELECT id FROM public.locations WHERE code='NJ'),'available',NULL,NULL),
      ('GSR-AM-00003-NJ','air_mover',(SELECT id FROM public.locations WHERE code='NJ'),'available',NULL,NULL),
      -- exactly right and out on a job: unchanged, still on the job
      ('GSR-AM00004-NJ','air_mover',(SELECT id FROM public.locations WHERE code='NJ'),'on_job',NULL,NULL),
      -- an older plate of another shape: untouched
      ('GSR-00983-NJ','dehumidifier',(SELECT id FROM public.locations WHERE code='NJ'),'available',NULL,NULL);
  `);

  await db.exec(SQL);
  const first = await counts(db);
  for (const [sheet, s] of Object.entries(SHEETS)) {
    if (sheet === "NJ") continue;
    eq(first[sheet], [total(s), total(s), 0, 0, 0], `${sheet}: every plate created`);
  }
  eq(first.NJ, [550, 546, 2, 1, 1], "NJ: 2 updated, 1 unchanged, 1 ambiguous skipped");

  const sum = Object.values(first).reduce((n, r) => n + r[0], 0);
  eq(sum, 5640, "5,640 plates in all");
  eq(
    (await db.query(`SELECT count(*)::int AS n FROM public.equipment`)).rows[0].n,
    5640 - 4 + 6,
    "5,636 new units beside the 6 already there — nothing duplicated",
  );

  // Per sheet: type split and home office.
  for (const [sheet, [am, du, as, code]] of Object.entries(SHEETS)) {
    const r = (
      await db.query(
        `SELECT count(*) FILTER (WHERE e.equipment_type='air_mover')::int AS am,
                count(*) FILTER (WHERE e.equipment_type='dehumidifier')::int AS du,
                count(*) FILTER (WHERE e.equipment_type='air_scrubber')::int AS sc,
                count(*) FILTER (WHERE l.code <> $2)::int AS elsewhere
           FROM public.equipment e JOIN public.locations l ON l.id = e.location_id
          WHERE e.asset_tag ~ ('^GSR-(AM|DU|AS)[0-9]{5}-' || $1 || '$')`,
        [sheet, code],
      )
    ).rows[0];
    // NJ's AM00003 is two off-plate spellings, not the printed tag.
    eq(
      [r.am, r.du, r.sc, r.elsewhere],
      [sheet === "NJ" ? am - 1 : am, du, as, 0],
      `${sheet} split and office`,
    );
  }

  const one = async (tag) =>
    (
      await db.query(
        `SELECT e.asset_tag, e.equipment_type, l.code, e.status::text AS status, e.make, e.notes
           FROM public.equipment e JOIN public.locations l ON l.id = e.location_id
          WHERE e.asset_tag = $1`,
        [tag],
      )
    ).rows[0];
  eq(
    await one("GSR-AM00001-NJ"),
    {
      asset_tag: "GSR-AM00001-NJ",
      equipment_type: "air_mover",
      code: "NJ",
      status: "available",
      make: "Dri-Eaz",
      notes: "keep me",
    },
    "exact tag: type and office fixed, make and notes kept",
  );
  eq(
    (await one("GSR-AM00002-NJ"))?.status,
    "maintenance",
    "spaced tag respelt as printed, status kept",
  );
  eq(await one("gsr am00002 nj"), undefined, "the old spelling is gone, not left beside it");
  eq((await one("GSR-AM00004-NJ"))?.status, "on_job", "a unit on a job stays on the job");
  eq(await one("GSR-AM00003-NJ"), undefined, "ambiguous plate not added a third time");
  eq((await one("GSR-00983-NJ"))?.code, "NJ", "other plates untouched");
  eq(
    await one("GSR-DU00100-NYU"),
    {
      asset_tag: "GSR-DU00100-NYU",
      equipment_type: "dehumidifier",
      code: "NY-UP",
      status: "available",
      make: null,
      notes: null,
    },
    "NYU → upstate office",
  );
  eq((await one("GSR-AS00035-HTX"))?.code, "TX", "HTX → Houston (code TX)");
  eq(await one("GSR-AS00036-HTX"), undefined, "HTX has 35 scrubbers, not 36");
  eq(
    (await one("GSR-AM00300-CAT2"))?.notes,
    "CAT Team 2 pool (catastrophe response)",
    "CAT2 pool noted",
  );
  eq(
    (await db.query(`SELECT count(*)::int AS n FROM public.locations`)).rows[0].n,
    12,
    "no location created when CAT exists",
  );
  eq(
    (
      await db.query(
        `SELECT count(*)::int AS n FROM public.equipment WHERE status <> 'available' AND asset_tag LIKE 'GSR-%' AND asset_tag NOT IN ('GSR-AM00004-NJ','GSR-AM00002-NJ')`,
      )
    ).rows[0].n,
    0,
    "every new unit is idle",
  );

  // Second run: nothing changes.
  const before = (
    await db.query(
      `SELECT md5(string_agg(id::text||asset_tag||equipment_type||location_id::text||status::text||updated_at::text, ',' ORDER BY id)) AS h FROM public.equipment`,
    )
  ).rows[0].h;
  await db.exec(SQL);
  const after = (
    await db.query(
      `SELECT md5(string_agg(id::text||asset_tag||equipment_type||location_id::text||status::text||updated_at::text, ',' ORDER BY id)) AS h FROM public.equipment`,
    )
  ).rows[0].h;
  eq(after, before, "second run: the register is byte-for-byte the same");
  const second = await counts(db);
  for (const [sheet, s] of Object.entries(SHEETS)) {
    eq(
      second[sheet],
      sheet === "NJ" ? [550, 0, 0, 549, 1] : [total(s), 0, 0, total(s), 0],
      `${sheet}: second run unchanged`,
    );
  }
}

/* ------------- Scenario B: no CAT office, no roster map (older database) ------------- */
{
  const db = new PGlite();
  await db.exec(SCHEMA + OFFICES);
  await db.exec(SQL);
  const c = await counts(db);
  eq(
    Object.values(c).reduce((n, r) => n + r[1], 0),
    5640,
    "all 5,640 created by code / city alone",
  );
  eq(
    (await db.query(`SELECT name FROM public.locations WHERE code = 'CAT'`)).rows,
    [{ name: "CAT Team (catastrophe response)" }],
    "the CAT location is created once, for both pools",
  );
  eq(
    (
      await db.query(
        `SELECT count(DISTINCT location_id)::int AS n FROM public.equipment WHERE asset_tag ~ '-CAT[12]$'`,
      )
    ).rows[0].n,
    1,
    "CAT1 and CAT2 share the CAT location, no real office",
  );
  await db.exec(SQL);
  eq(
    (await db.query(`SELECT count(*)::int AS n FROM public.locations WHERE code = 'CAT'`)).rows[0]
      .n,
    1,
    "not created twice",
  );
  eq(
    (await db.query(`SELECT count(*)::int AS n FROM public.equipment`)).rows[0].n,
    5640,
    "second run adds nothing",
  );
}

console.log(`equipment tag register: ${assertions} assertions passed`);
