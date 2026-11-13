// Run with: node supabase/tests/staff-roster-import.pglite.mjs <PGlite dist/index.js>
// In-memory fixtures only — never the project's database.
//
// Runs the REAL 20261022120000_staff_roster_import.sql against stand-in
// tables (auth.users, profiles, user_roles, locations, location_members,
// regions) and proves:
//   1. missing offices are created, existing ones (by code, or by city+state
//      when the code differs) are reused — no duplicate office;
//   2. an existing account matched by email in another case is updated:
//      name, title, approval, roles (admin/dev kept, others dropped), offices
//      (extra removed), primary office, region — and nobody is duplicated;
//   3. "all" and "all except Brooklyn" scopes expand to the active offices;
//   4. people with no account are reported awaiting_account; the shared
//      mailbox is held;
//   5. running the whole file a SECOND time changes nothing at all;
//   6. a signed-in non-admin cannot call apply_staff_roster().
import { readFileSync, readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const MIGRATIONS = new URL("../migrations/", import.meta.url);
const name = readdirSync(MIGRATIONS).find((f) => f.startsWith("20261022120000"));
const SQL = readFileSync(new URL(name, MIGRATIONS), "utf8");

let assertions = 0;
const eq = (actual, expected, what) => {
  assert.deepEqual(actual, expected, what);
  assertions++;
};

const db = new PGlite();
const ADMIN = "aaaaaaaa-0000-4000-8000-000000000001"; // our own team account
const DAVID = "aaaaaaaa-0000-4000-8000-000000000002"; // in the roster, exists
const SOL = "aaaaaaaa-0000-4000-8000-000000000003"; // in the roster, exists
const CREW = "aaaaaaaa-0000-4000-8000-000000000004"; // a plain user, not privileged

await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
  CREATE SCHEMA auth;
  CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
    $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

  CREATE TYPE public.app_role AS ENUM ('admin','office','field','regional','owner',
    'location_manager','sales_manager','sales_rep','field_chaser','crew','dev',
    'sales_person','cold_caller','outside_sales_rep','sales_head');
  CREATE TYPE public.location_member_role AS ENUM ('manager','office','field');

  CREATE TABLE public.locations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text NOT NULL UNIQUE, name text NOT NULL,
    address text NOT NULL, locality text, region text NOT NULL, lat double precision NOT NULL,
    lon double precision NOT NULL, active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp());
  CREATE TABLE public.profiles (
    user_id uuid PRIMARY KEY REFERENCES auth.users(id), email text, full_name text, job_title text,
    approval_status text NOT NULL DEFAULT 'pending', approved_at timestamptz, approved_by uuid,
    rejected_reason text, is_active boolean NOT NULL DEFAULT true,
    primary_location_id uuid REFERENCES public.locations(id));
  CREATE TABLE public.user_roles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES auth.users(id),
    role public.app_role NOT NULL, UNIQUE (user_id, role));
  CREATE TABLE public.location_members (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES auth.users(id),
    role public.location_member_role NOT NULL DEFAULT 'field', UNIQUE (location_id, user_id));
  CREATE TABLE public.regions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text UNIQUE);
  CREATE TABLE public.location_regions (location_id uuid, region_id uuid, UNIQUE (location_id, region_id));
  CREATE TABLE public.region_members (region_id uuid, user_id uuid, UNIQUE (region_id, user_id));

  -- The live "first membership becomes the primary" trigger.
  CREATE FUNCTION public.tg_set_primary() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    UPDATE public.profiles SET primary_location_id = NEW.location_id
     WHERE user_id = NEW.user_id AND primary_location_id IS NULL;
    RETURN NEW;
  END $$;
  CREATE TRIGGER set_primary AFTER INSERT ON public.location_members
    FOR EACH ROW EXECUTE FUNCTION public.tg_set_primary();

  CREATE FUNCTION public.is_privileged(_u uuid) RETURNS boolean LANGUAGE sql STABLE AS
    $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _u
                      AND role IN ('admin','owner','dev')) $$;

  -- Production today: the six seeded offices, plus Baltimore added in the
  -- UI under a code of its own, plus an inactive office.
  INSERT INTO public.locations (code, name, address, locality, region, lat, lon) VALUES
    ('NY','Brooklyn, NY','x','Brooklyn','NY',0,0), ('NJ','Lakewood, NJ','x','Lakewood','NJ',0,0),
    ('NC','Garner, NC','x','Garner','NC',0,0), ('GA','Atlanta, GA','x','Atlanta','GA',0,0),
    ('CA','Los Angeles, CA','x','Los Angeles','CA',0,0), ('MI','Southfield, MI','x','Southfield','MI',0,0),
    ('MD-BAL','Baltimore','1 Main St','Baltimore','MD',0,0);
  INSERT INTO public.locations (code, name, address, locality, region, lat, lon, active)
    VALUES ('OLD','Closed office','x','Nowhere','PA',0,0,false);
  INSERT INTO public.regions (name) VALUES ('Northeast');
  INSERT INTO public.location_regions
    SELECT l.id, r.id FROM public.locations l, public.regions r WHERE l.code = 'NJ';

  INSERT INTO auth.users VALUES
    ('${ADMIN}','mark@falconmarketing.com'),
    ('${DAVID}','David.S@GoldstarRestoration.com'),
    ('${SOL}','sol.l@goldstarrestoration.com'),
    ('${CREW}','someone@example.com');
  INSERT INTO public.profiles (user_id, email, full_name, approval_status) VALUES
    ('${ADMIN}','mark@falconmarketing.com','Mark','approved'),
    ('${DAVID}','david.s@goldstarrestoration.com','Dave S','pending'),
    ('${SOL}','sol.l@goldstarrestoration.com','Sol Landau','approved'),
    ('${CREW}','someone@example.com','Someone','approved');
  -- David already has admin + dev (team break-glass) and a stray legacy role;
  -- he is a member of Brooklyn, which his "all except Brooklyn" removes.
  INSERT INTO public.user_roles (user_id, role) VALUES
    ('${ADMIN}','admin'), ('${DAVID}','admin'), ('${DAVID}','dev'), ('${DAVID}','field'),
    ('${CREW}','crew');
  INSERT INTO public.location_members (location_id, user_id, role)
    SELECT id, '${DAVID}', 'field' FROM public.locations WHERE code = 'NY';
`);

await db.exec(SQL);

const rows = async (q) => (await db.query(q)).rows;
const one = async (q) => (await rows(q))[0];

// 1. Offices
const codes = (await rows(`SELECT code FROM public.locations ORDER BY code`)).map((r) => r.code);
eq(
  codes,
  ["CA", "GA", "IL", "IN", "MD-BAL", "MI", "NC", "NJ", "NY", "NY-UP", "OLD", "TX"],
  "creates IL, IN, TX, NY-UP; reuses Baltimore under its own code",
);
eq(
  (
    await one(
      `SELECT count(*)::int AS n FROM public.staff_roster_offices WHERE location_id IS NULL`,
    )
  ).n,
  0,
  "every roster office resolved",
);
eq((await one(`SELECT count(*)::int AS n FROM public.staff_roster`)).n, 37, "37 people");

// 2. David: matched in another case, updated
const dave = await one(`SELECT p.full_name, p.approval_status, l.code AS primary
  FROM public.profiles p JOIN public.locations l ON l.id = p.primary_location_id
  WHERE p.user_id = '${DAVID}'`);
eq(dave, { full_name: "David Stern", approval_status: "approved", primary: "NJ" }, "David updated");
eq(
  (
    await rows(`SELECT role::text FROM public.user_roles WHERE user_id = '${DAVID}' ORDER BY 1`)
  ).map((r) => r.role),
  ["admin", "dev", "owner"],
  "owner added, legacy field dropped, admin and dev kept",
);
const daveOffices = (
  await rows(`SELECT l.code, lm.role::text FROM public.location_members lm
    JOIN public.locations l ON l.id = lm.location_id WHERE lm.user_id = '${DAVID}' ORDER BY 1`)
).map((r) => `${r.code}:${r.role}`);
eq(
  daveOffices,
  [
    "CA:manager",
    "GA:manager",
    "IL:manager",
    "IN:manager",
    "MD-BAL:manager",
    "MI:manager",
    "NC:manager",
    "NJ:manager",
    "NY-UP:manager",
    "TX:manager",
  ],
  "all active offices except Brooklyn, as manager",
);
eq(
  (await one(`SELECT count(*)::int AS n FROM public.region_members WHERE user_id = '${DAVID}'`)).n,
  1,
  "owner joins his primary office's region",
);

// 3. Sol: all offices, primary Brooklyn, office role
const sol = await one(`SELECT l.code FROM public.profiles p JOIN public.locations l
  ON l.id = p.primary_location_id WHERE p.user_id = '${SOL}'`);
eq(sol.code, "NY", "Sol's primary stays Brooklyn");
eq(
  (
    await one(
      `SELECT count(*)::int AS n FROM public.location_members WHERE user_id = '${SOL}' AND role = 'office'`,
    )
  ).n,
  11,
  "Sol is in all 11 active offices",
);

// 4. Report
const report = Object.fromEntries(
  (await rows(`SELECT email, last_outcome FROM public.staff_roster`)).map((r) => [
    r.email,
    r.last_outcome,
  ]),
);
eq(report["david.s@goldstarrestoration.com"], "updated", "David reported updated");
eq(report["sol.l@goldstarrestoration.com"], "updated", "Sol reported updated");
eq(report["bo@goldstarrestoration.com"], "held", "Back Office held");
eq(
  Object.values(report).filter((o) => o === "awaiting_account").length,
  34,
  "the other 34 await an account",
);
eq((await one(`SELECT count(*)::int AS n FROM auth.users`)).n, 4, "no account was created by SQL");

// 5. Second run changes nothing
const snapshot = async () =>
  JSON.stringify({
    loc: await rows(`SELECT * FROM public.locations ORDER BY code`),
    prof: await rows(`SELECT * FROM public.profiles ORDER BY user_id`),
    roles: await rows(`SELECT user_id, role FROM public.user_roles ORDER BY 1, 2`),
    lm: await rows(`SELECT user_id, location_id, role FROM public.location_members ORDER BY 1, 2`),
    reg: await rows(`SELECT * FROM public.region_members ORDER BY 1, 2`),
    roster:
      await rows(`SELECT email, full_name, roles, user_id, last_changed_at, updated_at, created_at
                        FROM public.staff_roster ORDER BY email`),
  });
const before = await snapshot();
// The report flips to "unchanged" on the second pass; the data must not move.
await db.exec(SQL);
const afterTwo = await snapshot();
if (afterTwo !== before) {
  const a = JSON.parse(before),
    b = JSON.parse(afterTwo);
  for (const k of Object.keys(a))
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) console.log("differs:", k);
}
eq(afterTwo === before ? "same" : "different", "same", "second run of the file changes nothing");
eq(
  (
    await rows(`SELECT DISTINCT last_outcome FROM public.staff_roster WHERE user_id IS NOT NULL`)
  ).map((r) => r.last_outcome),
  ["unchanged"],
  "the second run reports everybody with an account as unchanged",
);
const again = await rows(
  `SELECT outcome FROM public.apply_staff_roster('DAVID.S@goldstarrestoration.com')`,
);
eq(again, [{ outcome: "unchanged" }], "re-applying David is unchanged");

// 6. A signed-in non-admin is refused
await db.exec(`SELECT set_config('request.jwt.claim.sub', '${CREW}', false)`);
let refused = false;
try {
  await db.query(`SELECT * FROM public.apply_staff_roster(NULL)`);
} catch (e) {
  refused = /Only an owner, admin or developer/.test(String(e.message));
}
eq(refused, true, "non-admin refused");

console.log(`staff roster import: ${assertions} assertions passed`);
