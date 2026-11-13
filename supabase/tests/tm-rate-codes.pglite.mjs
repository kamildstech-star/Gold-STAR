// Run with: node supabase/tests/tm-rate-codes.pglite.mjs <existing PGlite dist/index.js>
// In-memory fixtures only. No connection string, network access or live writes.
//
// The T&M rate code catalogue (migration 20261007230000, READ FROM THE FILE).
// Mark: "for a T&M job, there is a sign in sheet, rate codes and the three
// pages that are used for each day."
//
// What it proves:
//   1. the seed is Daily Supply List 1.1: 157 lines, the right count in each
//      section, and running the migration twice changes nothing — including
//      an admin's relabel, which a re-run must not overwrite;
//   2. every active signed-in staff member reads it; an inactive profile,
//      anon and a portal customer read nothing;
//   3. only is_privileged (owner / admin / dev) inserts and updates; crew
//      cannot; nobody deletes (no grant);
//   4. an edit cannot change a code (the trigger pins it), and a bad code or
//      an unknown section is refused by the CHECKs;
//   5. anon and PUBLIC hold no grant on the table.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
const migration = (name) => readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8");

let assertions = 0;
const check = (value, what) => {
  assert.equal(value, true, what);
  assertions++;
};
const refuses = async (promise, pattern, what) => {
  await assert.rejects(promise, pattern, what);
  assertions++;
};

const admin = "11111111-1111-4111-8111-111111111111";
const crew = "22222222-2222-4222-8222-222222222222";
const gone = "33333333-3333-4333-8333-333333333333"; // deactivated profile

try {
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS;
    CREATE ROLE portal_customer NOLOGIN NOINHERIT;
    CREATE SCHEMA auth;
    CREATE SCHEMA goldstar_private;
    GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role, portal_customer;
    GRANT USAGE ON SCHEMA goldstar_private TO authenticated, service_role;

    -- Supabase's own default: every table created in public is granted to the
    -- client roles. The migration must undo this for anon, not rely on its absence.
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;

    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

    CREATE TABLE public.profiles (user_id uuid PRIMARY KEY, is_active boolean NOT NULL DEFAULT true);
    CREATE FUNCTION goldstar_private.profile_is_active(_user_id uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
      SELECT EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = _user_id AND p.is_active);
    $$;
    GRANT EXECUTE ON FUNCTION goldstar_private.profile_is_active(uuid) TO authenticated, service_role;

    CREATE TABLE public.user_roles (user_id uuid, role text);
    CREATE FUNCTION public.is_privileged(_user_id uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
      $$ SELECT EXISTS (SELECT 1 FROM public.user_roles
                         WHERE user_id = _user_id AND role IN ('owner', 'admin', 'dev')) $$;
    GRANT EXECUTE ON FUNCTION public.is_privileged(uuid) TO authenticated;

    INSERT INTO public.profiles VALUES ('${admin}', true), ('${crew}', true), ('${gone}', false);
    INSERT INTO public.user_roles VALUES ('${admin}', 'admin'), ('${crew}', 'crew'), ('${gone}', 'admin');
  `);

  await db.exec(migration("20261007230000_tm_rate_codes.sql"));

  const as = async (uid, sql, role = "authenticated") => {
    await db.exec(`SET ROLE ${role}; SET request.jwt.claim.sub = '${uid ?? ""}'`);
    try {
      return await db.query(sql);
    } finally {
      await db.exec("RESET ROLE; SELECT set_config('request.jwt.claim.sub','',false)");
    }
  };
  const one = async (sql) => (await db.query(sql)).rows[0];

  /* ---- 1: the seed ------------------------------------------------------ */
  const counts = Object.fromEntries(
    (
      await db.query(
        `SELECT section, count(*)::int AS n FROM public.tm_rate_codes GROUP BY section`,
      )
    ).rows.map((r) => [r.section, r.n]),
  );
  const expected = { labor: 27, consumable: 57, equipment: 47, ppe: 13, vehicle: 7, general: 6 };
  for (const [section, n] of Object.entries(expected)) {
    check(counts[section] === n, `${section}: ${n} lines, as printed on the sheet`);
  }
  check(
    (await one(`SELECT count(*)::int AS n FROM public.tm_rate_codes WHERE active`)).n === 157,
    "all 157 seeded lines start active",
  );
  check(
    (await one(`SELECT label FROM public.tm_rate_codes WHERE code = 'CCF'`)).label === "Crew Chief",
    "CCF is Crew Chief",
  );

  await db.exec(
    `UPDATE public.tm_rate_codes SET label = 'Crew Chief (foreman)' WHERE code = 'CCF'`,
  );
  await db.exec(migration("20261007230000_tm_rate_codes.sql"));
  check(
    (await one(`SELECT count(*)::int AS n FROM public.tm_rate_codes`)).n === 157,
    "a second run adds nothing",
  );
  check(
    (await one(`SELECT label FROM public.tm_rate_codes WHERE code = 'CCF'`)).label ===
      "Crew Chief (foreman)",
    "and does not undo an admin's relabel",
  );

  /* ---- 2: who reads ---------------------------------------------------- */
  check(
    (await as(crew, `SELECT count(*)::int AS n FROM public.tm_rate_codes`)).rows[0].n === 157,
    "crew read every code (they pick them on the forms)",
  );
  check(
    (await as(gone, `SELECT count(*)::int AS n FROM public.tm_rate_codes`)).rows[0].n === 0,
    "a deactivated profile reads nothing (active_profile_required)",
  );
  await refuses(
    as(crew, `SELECT count(*) FROM public.tm_rate_codes`, "portal_customer"),
    /permission denied/,
    "a portal customer has no grant on the table",
  );
  // And if one were ever granted by mistake, the restrictive policy still holds.
  await db.exec(`GRANT SELECT ON public.tm_rate_codes TO portal_customer`);
  check(
    (await as(crew, `SELECT count(*)::int AS n FROM public.tm_rate_codes`, "portal_customer"))
      .rows[0].n === 0,
    "a stray grant still shows a portal customer nothing (portal_customer_denied)",
  );
  await db.exec(`REVOKE SELECT ON public.tm_rate_codes FROM portal_customer`);
  await refuses(
    as(null, `SELECT count(*) FROM public.tm_rate_codes`, "anon"),
    /permission denied/,
    "anon has no grant at all",
  );

  /* ---- 3: who writes --------------------------------------------------- */
  await refuses(
    as(crew, `INSERT INTO public.tm_rate_codes (code, label, section) VALUES ('ZZ', 'X', 'labor')`),
    /row-level security/,
    "crew cannot add a code",
  );
  const crewUpdate = await as(
    crew,
    `UPDATE public.tm_rate_codes SET label = 'hacked' WHERE code = 'APM' RETURNING code`,
  );
  check(crewUpdate.rows.length === 0, "crew cannot relabel a code (the update touches no row)");
  await refuses(
    as(gone, `INSERT INTO public.tm_rate_codes (code, label, section) VALUES ('ZY', 'X', 'labor')`),
    /row-level security/,
    "a deactivated admin cannot add a code",
  );
  await as(
    admin,
    `INSERT INTO public.tm_rate_codes (code, label, section, sort_order)
     VALUES ('157', 'Floor protection film', 'consumable', 580)`,
  );
  check(
    (await one(`SELECT updated_by::text AS u FROM public.tm_rate_codes WHERE code = '157'`)).u ===
      admin,
    "an admin adds a code, stamped with who added it",
  );
  await as(admin, `UPDATE public.tm_rate_codes SET active = false WHERE code = 'CA'`);
  check(
    (await one(`SELECT active FROM public.tm_rate_codes WHERE code = 'CA'`)).active === false,
    "an admin switches a code off",
  );
  await refuses(
    as(admin, `DELETE FROM public.tm_rate_codes WHERE code = 'CA'`),
    /permission denied/,
    "nobody deletes a code — it is switched off instead",
  );

  /* ---- 4: the code is the key ------------------------------------------ */
  await as(
    admin,
    `UPDATE public.tm_rate_codes SET code = 'XX', label = 'Carpenter' WHERE code = 'CA'`,
  );
  check(
    (await one(`SELECT count(*)::int AS n FROM public.tm_rate_codes WHERE code = 'CA'`)).n === 1 &&
      (await one(`SELECT count(*)::int AS n FROM public.tm_rate_codes WHERE code = 'XX'`)).n === 0,
    "an edit cannot rename a code; filled sheets keep meaning what they say",
  );
  await refuses(
    as(
      admin,
      `INSERT INTO public.tm_rate_codes (code, label, section) VALUES ('bad code', 'X', 'labor')`,
    ),
    /check constraint/,
    "a code with spaces or lower case is refused",
  );
  await refuses(
    as(
      admin,
      `INSERT INTO public.tm_rate_codes (code, label, section) VALUES ('Q1', 'X', 'prices')`,
    ),
    /check constraint/,
    "an unknown section is refused",
  );
  await refuses(
    as(
      admin,
      `INSERT INTO public.tm_rate_codes (code, label, section) VALUES ('Q2', '  ', 'labor')`,
    ),
    /check constraint/,
    "a blank description is refused",
  );

  /* ---- 5: grants -------------------------------------------------------- */
  const grants = (
    await db.query(
      `SELECT grantee, privilege_type FROM information_schema.role_table_grants
        WHERE table_name = 'tm_rate_codes' AND grantee IN ('anon', 'PUBLIC', 'authenticated')`,
    )
  ).rows;
  check(
    !grants.some((g) => g.grantee === "anon" || g.grantee === "PUBLIC"),
    "no anon or PUBLIC grant",
  );
  check(
    !grants.some((g) => g.grantee === "authenticated" && g.privilege_type === "DELETE"),
    "authenticated has no DELETE",
  );

  console.log(`tm-rate-codes.pglite: ${assertions} assertions passed`);
} finally {
  await db.close();
}
