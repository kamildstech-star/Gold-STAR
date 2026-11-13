// Run with: node supabase/tests/job-tm-forms.pglite.mjs <existing PGlite dist/index.js>
// In-memory fixtures only. No connection string, network access or live writes.
//
// The T&M daily sheets (migration 20261007231000, READ FROM THE FILE). Mark:
// "for a T&M job, there is a sign in sheet, rate codes and the three pages
// that are used for each day."
//
// What it proves:
//   1. whoever can see the job reads its sheets and starts one, as
//      themselves only; a job in another office is invisible and closed;
//   2. one sheet per kind per job per day: a second plain insert is refused,
//      the app's upsert on (job, kind, day) from a second crew member edits
//      the same row, and the row keeps its id, author and creation time;
//   3. a save that does not mention the PDF keeps the one already filed;
//   4. only an admin deletes; crew cannot;
//   5. an inactive profile, a portal customer and anon get nothing;
//   6. the CHECKs refuse an unknown kind, a non-object payload and a runaway
//      payload.
//
// The surrounding tables are stubs with only the columns the migration
// touches. auth.uid() reads a session setting, as the other fixtures do.
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
const crewA = "22222222-2222-4222-8222-222222222222"; // office A
const crewA2 = "33333333-3333-4333-8333-333333333333"; // office A, second phone
const crewB = "44444444-4444-4444-8444-444444444444"; // office B only
const gone = "55555555-5555-4555-8555-555555555555"; // office A, deactivated
const officeA = "66666666-6666-4666-8666-666666666666";
const officeB = "77777777-7777-4777-8777-777777777777";
const jobA = "a0000000-0000-4000-8000-000000000001";
const jobB = "a0000000-0000-4000-8000-000000000002";
const docId = "d0000000-0000-4000-8000-000000000001";

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

    CREATE TABLE public.jobs (id uuid PRIMARY KEY, location_id uuid NOT NULL);
    CREATE TABLE public.location_members (user_id uuid, location_id uuid);
    CREATE FUNCTION public.can_view_job(_user_id uuid, _job_id uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
      $$ SELECT public.is_privileged(_user_id) OR EXISTS (
           SELECT 1 FROM public.jobs j JOIN public.location_members m
             ON m.location_id = j.location_id
          WHERE j.id = _job_id AND m.user_id = _user_id) $$;
    GRANT EXECUTE ON FUNCTION public.can_view_job(uuid, uuid), public.is_privileged(uuid) TO authenticated;

    CREATE TABLE public.documents (id uuid PRIMARY KEY);

    INSERT INTO public.profiles VALUES
      ('${admin}', true), ('${crewA}', true), ('${crewA2}', true), ('${crewB}', true), ('${gone}', false);
    INSERT INTO public.user_roles VALUES
      ('${admin}', 'admin'), ('${crewA}', 'crew'), ('${crewA2}', 'crew'), ('${crewB}', 'crew'), ('${gone}', 'crew');
    INSERT INTO public.jobs VALUES ('${jobA}', '${officeA}'), ('${jobB}', '${officeB}');
    INSERT INTO public.location_members VALUES
      ('${crewA}', '${officeA}'), ('${crewA2}', '${officeA}'), ('${gone}', '${officeA}'), ('${crewB}', '${officeB}');
    INSERT INTO public.documents VALUES ('${docId}');
  `);

  await db.exec(migration("20261007231000_job_tm_forms.sql"));

  const as = async (uid, sql, role = "authenticated") => {
    await db.exec(`SET ROLE ${role}; SET request.jwt.claim.sub = '${uid ?? ""}'`);
    try {
      return await db.query(sql);
    } finally {
      await db.exec("RESET ROLE; SELECT set_config('request.jwt.claim.sub','',false)");
    }
  };
  const one = async (sql) => (await db.query(sql)).rows[0];
  const sheet = (by, id, payload, job = jobA, kind = "sign_in", day = "2026-10-07") =>
    `INSERT INTO public.job_tm_forms (id, job_id, kind, form_date, payload, created_by)
     VALUES ('${id}', '${job}', '${kind}', '${day}', '${JSON.stringify(payload)}'::jsonb, '${by}')`;
  // What PostgREST sends for .upsert(row, { onConflict: "job_id,kind,form_date" }).
  const upsert = (by, id, payload, job = jobA, kind = "sign_in", day = "2026-10-07") =>
    `${sheet(by, id, payload, job, kind, day)}
     ON CONFLICT (job_id, kind, form_date) DO UPDATE
       SET id = EXCLUDED.id, payload = EXCLUDED.payload, created_by = EXCLUDED.created_by
     RETURNING id::text, created_by::text, updated_by::text, payload`;

  const first = "f0000000-0000-4000-8000-000000000001";
  const second = "f0000000-0000-4000-8000-000000000002";

  /* ---- 1: who reads and starts a sheet --------------------------------- */
  await as(crewA, sheet(crewA, first, { rows: [{ id: "r1", employee: "José" }] }));
  check(
    (await as(crewA, `SELECT count(*)::int AS n FROM public.job_tm_forms`)).rows[0].n === 1,
    "the crew member who started it reads it",
  );
  check(
    (await as(crewA2, `SELECT count(*)::int AS n FROM public.job_tm_forms`)).rows[0].n === 1,
    "so does anyone else who can see the job",
  );
  check(
    (await as(crewB, `SELECT count(*)::int AS n FROM public.job_tm_forms`)).rows[0].n === 0,
    "a crew member in another office sees nothing",
  );
  await refuses(
    as(crewA, sheet(crewA2, "f0000000-0000-4000-8000-000000000003", {}, jobA, "crew_chief")),
    /row-level security/,
    "nobody starts a sheet in someone else's name",
  );
  await refuses(
    as(crewA, sheet(crewA, "f0000000-0000-4000-8000-000000000004", {}, jobB)),
    /row-level security/,
    "nobody starts a sheet on a job they cannot see",
  );

  /* ---- 2: one per kind per job per day --------------------------------- */
  await refuses(
    as(crewA2, sheet(crewA2, second, { rows: [] })),
    /duplicate key|unique/,
    "a second plain insert of today's sign-in sheet is refused",
  );
  const merged = (
    await as(
      crewA2,
      upsert(crewA2, second, {
        rows: [
          { id: "r1", employee: "José" },
          { id: "r2", employee: "Dana" },
        ],
      }),
    )
  ).rows[0];
  check(merged.id === first, "the second phone's save lands on the same sheet (its id kept)");
  check(merged.created_by === crewA, "the sheet keeps the author who started it");
  check(merged.updated_by === crewA2, "and records who saved it last");
  check(merged.payload.rows.length === 2, "with the second phone's rows");
  check(
    (await one(`SELECT count(*)::int AS n FROM public.job_tm_forms`)).n === 1,
    "still one sheet for the day",
  );
  await as(
    crewA,
    sheet(crewA, "f0000000-0000-4000-8000-000000000005", {}, jobA, "sign_in", "2026-10-08"),
  );
  check(
    (await one(`SELECT count(*)::int AS n FROM public.job_tm_forms WHERE kind = 'sign_in'`)).n ===
      2,
    "the next day is a new sheet",
  );
  const crewBUpdate = await as(
    crewB,
    `UPDATE public.job_tm_forms SET payload = '{}'::jsonb WHERE job_id = '${jobA}' RETURNING id`,
  );
  check(crewBUpdate.rows.length === 0, "another office cannot change the sheet");
  await refuses(
    as(crewB, upsert(crewB, "f0000000-0000-4000-8000-000000000006", {}, jobA)),
    /row-level security/,
    "nor upsert onto it",
  );

  /* ---- 3: the filed PDF survives a later save -------------------------- */
  await as(crewA, `UPDATE public.job_tm_forms SET document_id = '${docId}' WHERE id = '${first}'`);
  await as(crewA2, upsert(crewA2, second, { rows: [{ id: "r3", employee: "Luis" }] }));
  check(
    (await one(`SELECT document_id::text AS d FROM public.job_tm_forms WHERE id = '${first}'`))
      .d === docId,
    "a save that does not mention the PDF keeps the one already filed",
  );

  /* ---- 4: delete --------------------------------------------------------- */
  const crewDelete = await as(
    crewA,
    `DELETE FROM public.job_tm_forms WHERE id = '${first}' RETURNING id`,
  );
  check(crewDelete.rows.length === 0, "crew cannot delete a sheet");
  const adminDelete = await as(
    admin,
    `DELETE FROM public.job_tm_forms WHERE form_date = '2026-10-08' RETURNING id`,
  );
  check(adminDelete.rows.length === 1, "an admin can");

  /* ---- 5: shut out ------------------------------------------------------- */
  check(
    (await as(gone, `SELECT count(*)::int AS n FROM public.job_tm_forms`)).rows[0].n === 0,
    "a deactivated profile reads nothing",
  );
  await refuses(
    as(gone, sheet(gone, "f0000000-0000-4000-8000-000000000007", {}, jobA, "supply_list")),
    /row-level security/,
    "and starts nothing",
  );
  await refuses(
    as(crewA, `SELECT count(*) FROM public.job_tm_forms`, "portal_customer"),
    /permission denied/,
    "a portal customer has no grant",
  );
  await db.exec(`GRANT SELECT ON public.job_tm_forms TO portal_customer`);
  check(
    (await as(crewA, `SELECT count(*)::int AS n FROM public.job_tm_forms`, "portal_customer"))
      .rows[0].n === 0,
    "and a stray grant still shows nothing (portal_customer_denied)",
  );
  await db.exec(`REVOKE SELECT ON public.job_tm_forms FROM portal_customer`);
  await refuses(
    as(null, `SELECT count(*) FROM public.job_tm_forms`, "anon"),
    /permission denied/,
    "anon has no grant",
  );
  const grants = (
    await db.query(
      `SELECT grantee FROM information_schema.role_table_grants
        WHERE table_name = 'job_tm_forms' AND grantee IN ('anon', 'PUBLIC')`,
    )
  ).rows;
  check(grants.length === 0, "no anon or PUBLIC grant at all");

  /* ---- 6: CHECKs --------------------------------------------------------- */
  await refuses(
    as(crewA, sheet(crewA, "f0000000-0000-4000-8000-000000000008", {}, jobA, "timesheet")),
    /check constraint/,
    "an unknown kind is refused",
  );
  await refuses(
    as(
      crewA,
      `INSERT INTO public.job_tm_forms (job_id, kind, form_date, payload, created_by)
       VALUES ('${jobA}', 'crew_chief', '2026-10-07', '[1,2]'::jsonb, '${crewA}')`,
    ),
    /check constraint/,
    "a payload that is not an object is refused",
  );
  await refuses(
    as(
      crewA,
      `INSERT INTO public.job_tm_forms (job_id, kind, form_date, payload, created_by)
       VALUES ('${jobA}', 'crew_chief', '2026-10-07',
               jsonb_build_object('notes', repeat('x', 3000001)), '${crewA}')`,
    ),
    /check constraint/,
    "a runaway payload is refused",
  );

  console.log(`job-tm-forms.pglite: ${assertions} assertions passed`);
} finally {
  await db.close();
}
