// Run with: node supabase/tests/incident-public-records.pglite.mjs <existing PGlite dist/index.js>
// In-memory fixtures only. The migration under test is READ FROM THE FILE.
//
// What it proves about 20261014160000:
//   1. it creates incident_public_records and applies twice;
//   2. there is no phone / email / mailing column to put contact data in;
//   3. the CHECKs hold (status, found-needs-source, year range, text caps);
//   4. SELECT follows incidents visibility: who can see the incident sees its
//      record, who cannot does not, and widening the incidents policy widens
//      this with no change here; an inactive profile sees nothing;
//   5. signed-in users cannot write it at all; anon holds no grant; the
//      service role upserts;
//   6. the restrictive guards are in place, deleting the incident deletes the
//      record, and updated_at moves on update.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
const FILE = "20261014160000_incident_public_records.sql";
const migration = readFileSync(new URL("../migrations/" + FILE, import.meta.url), "utf8");

const CHASER_A = "11111111-1111-4111-8111-111111111111"; // market A
const CHASER_B = "22222222-2222-4222-8222-222222222222"; // market B
const INACTIVE = "33333333-3333-4333-8333-333333333333"; // market A, deactivated
const INCIDENT_A = "44444444-4444-4444-8444-444444444444";
const INCIDENT_B = "55555555-5555-4555-8555-555555555555";

let assertions = 0;
const check = (value, what) => {
  assert.equal(value, true, what);
  assertions++;
};
const as = (who) =>
  db.exec(`SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', '${who}', false);`);
const reset = () => db.exec(`RESET ROLE`);

try {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE ROLE portal_customer;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    GRANT USAGE ON SCHEMA auth TO authenticated, anon;
    CREATE SCHEMA goldstar_private;
    GRANT USAGE ON SCHEMA goldstar_private TO authenticated;
    CREATE FUNCTION goldstar_private.profile_is_active(uuid) RETURNS boolean
      LANGUAGE sql STABLE AS $$ SELECT $1 IS NOT NULL AND $1 <> '${INACTIVE}'::uuid $$;
    CREATE FUNCTION public.update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW.updated_at := clock_timestamp(); RETURN NEW; END $$;

    CREATE TABLE public.user_markets (user_id uuid, market text);
    INSERT INTO public.user_markets VALUES
      ('${CHASER_A}', 'A'), ('${CHASER_B}', 'B'), ('${INACTIVE}', 'A');
    GRANT SELECT ON public.user_markets TO authenticated;

    CREATE TABLE public.incidents (id uuid PRIMARY KEY, market text NOT NULL, accepted_by uuid);
    INSERT INTO public.incidents VALUES ('${INCIDENT_A}', 'A', NULL), ('${INCIDENT_B}', 'B', NULL);
    GRANT SELECT ON public.incidents TO authenticated;
    ALTER TABLE public.incidents ENABLE ROW LEVEL SECURITY;
    CREATE POLICY incidents_select ON public.incidents FOR SELECT TO authenticated
      USING (EXISTS (SELECT 1 FROM public.user_markets m
                      WHERE m.user_id = (SELECT auth.uid()) AND m.market = incidents.market));
  `);

  await db.exec(migration);
  await db.exec(migration);
  check(true, "applies twice");

  // 2. No contact columns ------------------------------------------------
  const cols = (
    await db.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'incident_public_records'`,
    )
  ).rows.map((r) => r.column_name);
  check(cols.includes("owner_name") && cols.includes("year_built"), "the basics have columns");
  check(
    cols.every((c) => !/phone|email|mail/i.test(c)),
    "and nothing for phone, email or a mailing address",
  );

  // 3. CHECKs -------------------------------------------------------------
  await db.exec(`INSERT INTO public.incident_public_records
      (incident_id, status, source, source_label, owner_name, property_class, year_built,
       last_sale_date, last_sale_amount, assessed_value)
    VALUES ('${INCIDENT_A}', 'found', 'nyc_pluto', 'NYC PLUTO 26v2', 'SAMPLE OWNER, A', 'A1', 1945,
            '2006-03-31', 875000, 68460)`);
  await db.exec(`INSERT INTO public.incident_public_records (incident_id, status, note)
    VALUES ('${INCIDENT_B}', 'not_found', 'No free public record for this area.')`);
  check(true, "a found row and a not_found row insert as the service would write them");
  for (const [sql, what] of [
    [
      `UPDATE public.incident_public_records SET status = 'maybe' WHERE incident_id = '${INCIDENT_A}'`,
      "status",
    ],
    [
      `UPDATE public.incident_public_records SET status = 'found' WHERE incident_id = '${INCIDENT_B}'`,
      "found needs a source",
    ],
    [
      `UPDATE public.incident_public_records SET source = 'zillow' WHERE incident_id = '${INCIDENT_A}'`,
      "source list",
    ],
    [
      `UPDATE public.incident_public_records SET year_built = 1066 WHERE incident_id = '${INCIDENT_A}'`,
      "year range",
    ],
    [
      `UPDATE public.incident_public_records SET owner_name = repeat('x', 301) WHERE incident_id = '${INCIDENT_A}'`,
      "owner cap",
    ],
    [
      `UPDATE public.incident_public_records SET last_sale_amount = 0 WHERE incident_id = '${INCIDENT_A}'`,
      "positive sale",
    ],
  ]) {
    await assert.rejects(db.exec(sql), /check constraint|violates/i, what);
    assertions++;
  }

  // 4. Visibility follows incidents ---------------------------------------
  const visible = async (who) => {
    await as(who);
    const r = await db.query(`SELECT incident_id FROM public.incident_public_records ORDER BY 1`);
    await reset();
    return r.rows.map((x) => x.incident_id);
  };
  check(
    JSON.stringify(await visible(CHASER_A)) === JSON.stringify([INCIDENT_A]),
    "a chaser sees the record of an incident they can see, unclaimed",
  );
  check(
    JSON.stringify(await visible(CHASER_B)) === JSON.stringify([INCIDENT_B]),
    "and not one in a market they cannot see",
  );
  check((await visible(INACTIVE)).length === 0, "an inactive profile sees nothing");

  await db.exec(`INSERT INTO public.user_markets VALUES ('${CHASER_B}', 'A')`);
  check(
    (await visible(CHASER_B)).length === 2,
    "widening incidents visibility widens this table, with no change to it",
  );

  // 5. Writes ---------------------------------------------------------------
  for (const sql of [
    `INSERT INTO public.incident_public_records (incident_id, status) VALUES ('${INCIDENT_A}', 'not_found')`,
    `UPDATE public.incident_public_records SET owner_name = 'forged'`,
    `DELETE FROM public.incident_public_records`,
  ]) {
    await as(CHASER_A);
    await assert.rejects(db.exec(sql), /permission denied/i, sql);
    await reset();
    assertions++;
  }
  const anon = await db.query(
    `SELECT privilege_type FROM information_schema.role_table_grants
      WHERE table_name = 'incident_public_records' AND grantee IN ('anon', 'PUBLIC')`,
  );
  check(anon.rows.length === 0, "anon and PUBLIC hold nothing");
  const authGrants = (
    await db.query(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE table_name = 'incident_public_records' AND grantee = 'authenticated'`,
    )
  ).rows.map((r) => r.privilege_type);
  check(
    JSON.stringify(authGrants) === JSON.stringify(["SELECT"]),
    "signed-in users hold SELECT only",
  );

  const before = (
    await db.query(
      `SELECT updated_at FROM public.incident_public_records WHERE incident_id = '${INCIDENT_A}'`,
    )
  ).rows[0].updated_at;
  await db.exec(`SET ROLE service_role`);
  await db.exec(`INSERT INTO public.incident_public_records (incident_id, status, source, owner_name)
    VALUES ('${INCIDENT_A}', 'found', 'nyc_pluto', 'SAMPLE OWNER, C')
    ON CONFLICT (incident_id) DO UPDATE SET owner_name = EXCLUDED.owner_name`);
  await reset();
  const after = (
    await db.query(
      `SELECT owner_name, updated_at FROM public.incident_public_records WHERE incident_id = '${INCIDENT_A}'`,
    )
  ).rows[0];
  check(after.owner_name === "SAMPLE OWNER, C", "the service role upserts on incident_id");
  check(after.updated_at > before, "and updated_at moves");

  // 6. Guards and cascade ---------------------------------------------------
  const guards = await db.query(
    `SELECT policyname, permissive FROM pg_policies
      WHERE tablename = 'incident_public_records'
        AND policyname IN ('active_profile_required', 'anonymous_business_access_denied', 'portal_customer_denied')`,
  );
  check(
    guards.rows.length === 3 && guards.rows.every((r) => r.permissive === "RESTRICTIVE"),
    "the three restrictive guards are in place",
  );
  const rls = await db.query(
    `SELECT relrowsecurity FROM pg_class WHERE oid = 'public.incident_public_records'::regclass`,
  );
  check(rls.rows[0].relrowsecurity === true, "RLS is on");

  await db.exec(`DELETE FROM public.incidents WHERE id = '${INCIDENT_B}'`);
  const left = await db.query(`SELECT incident_id FROM public.incident_public_records`);
  check(
    left.rows.length === 1 && left.rows[0].incident_id === INCIDENT_A,
    "deleting an incident deletes its record",
  );

  console.log(`incident-public-records.pglite: ${assertions} assertions passed`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.close();
}
