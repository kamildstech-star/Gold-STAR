// Run with: node supabase/tests/job-ledger-overrides.pglite.mjs <existing PGlite dist/index.js>
// In-memory fixtures only. No connection string, network access or live writes.
//
// Who can read and type a Job ledger cell (migration 20261007224500). The
// migration under test is READ FROM THE FILE, never retyped here. The
// helpers it calls (can_view_job, can_view_finance, has_permission,
// has_any_role_text, profile_is_active) are stubbed with the same signatures
// and the same meaning as the live ones, so what is proven is the new
// table's own rules on top of them.
//
// What it proves:
//   1. Supabase's default grants are taken back: anon has nothing on either
//      table, and authenticated cannot write the trail.
//   2. Effort cells (days/guys/hours) are read by anyone who can see the job;
//      money cells only by can_view_finance AND job.view_costs — so office
//      (view_costs, no finance) and crew see effort only, and someone who
//      cannot see the job sees nothing.
//   3. Only owner / admin / sales_head write, and only on a job they can see;
//      office, crew, an inactive owner and an outsider are refused.
//   4. Who and when are stamped by the database, not the caller; the key of
//      a row never moves.
//   5. Every set, change and clear is in the trail with old and new; a
//      no-change update is not; deleting a job takes overrides and trail
//      with it without failing.
//   6. portal_customer is denied by a RESTRICTIVE policy even with a grant;
//      the definer functions pin search_path and are not executable by
//      PUBLIC or anon.
//   7. The cell_key list refuses Referral, Commission and the totals.
//   8. The migration is re-runnable.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
const FILE = "20261007224500_job_ledger_overrides.sql";
const migration = readFileSync(new URL("../migrations/" + FILE, import.meta.url), "utf8");

let assertions = 0;
const check = (value, what) => {
  assert.equal(value, true, what);
  assertions++;
};
const refused = async (promise, what) => {
  await assert.rejects(promise, /row-level security|permission denied/, what);
  assertions++;
};

const owner = "11111111-1111-4111-8111-111111111111";
const office = "22222222-2222-4222-8222-222222222222";
const salesHead = "33333333-3333-4333-8333-333333333333";
const crew = "44444444-4444-4444-8444-444444444444";
const gone = "55555555-5555-4555-8555-555555555555"; // owner, deactivated
const outsider = "66666666-6666-4666-8666-666666666666";
const locA = "aaaaaaaa-0000-4000-8000-00000000000a";
const locB = "bbbbbbbb-0000-4000-8000-00000000000b";
const jobA = "aaaaaaaa-1111-4111-8111-11111111111a";
const jobB = "bbbbbbbb-1111-4111-8111-11111111111b";

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
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;

    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

    CREATE TABLE public.profiles (user_id uuid PRIMARY KEY, is_active boolean NOT NULL DEFAULT true);
    CREATE TABLE public.user_roles (user_id uuid, role text);
    CREATE TABLE public.location_members (user_id uuid, location_id uuid);
    CREATE TABLE public.perms (user_id uuid, key text);
    CREATE TABLE public.jobs (id uuid PRIMARY KEY, location_id uuid);
    CREATE TABLE public.job_assignments (job_id uuid, user_id uuid);
    REVOKE ALL ON public.profiles, public.user_roles, public.location_members, public.perms,
      public.job_assignments FROM anon, authenticated;
    GRANT SELECT ON public.jobs TO authenticated;

    CREATE FUNCTION goldstar_private.profile_is_active(_user_id uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
      SELECT EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = _user_id AND p.is_active);
    $$;
    CREATE FUNCTION public.has_any_role_text(_user_id uuid, _roles text[])
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT goldstar_private.profile_is_active(_user_id)
         AND EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = ANY(_roles));
    $$;
    CREATE FUNCTION public.is_privileged(_user_id uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT public.has_any_role_text(_user_id, ARRAY['owner','admin','dev']);
    $$;
    CREATE FUNCTION public.can_view_finance(_user_id uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT public.has_any_role_text(_user_id, ARRAY['owner','admin','sales_head','dev']);
    $$;
    CREATE FUNCTION public.has_permission(_user_id uuid, _key text, _location_id uuid DEFAULT NULL)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT goldstar_private.profile_is_active(_user_id)
         AND EXISTS (SELECT 1 FROM public.perms WHERE user_id = _user_id AND key = _key);
    $$;
    CREATE FUNCTION public.can_view_job(_user_id uuid, _job_id uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = _job_id AND (
        public.is_privileged(_user_id)
        OR EXISTS (SELECT 1 FROM public.location_members m
                    WHERE m.user_id = _user_id AND m.location_id = j.location_id)
        OR EXISTS (SELECT 1 FROM public.job_assignments a
                    WHERE a.job_id = j.id AND a.user_id = _user_id)));
    $$;

    INSERT INTO public.profiles (user_id, is_active) VALUES
      ('${owner}', true), ('${office}', true), ('${salesHead}', true), ('${crew}', true),
      ('${gone}', false), ('${outsider}', true);
    INSERT INTO public.user_roles VALUES
      ('${owner}', 'owner'), ('${office}', 'office'), ('${salesHead}', 'sales_head'),
      ('${crew}', 'crew'), ('${gone}', 'owner');
    INSERT INTO public.location_members VALUES
      ('${office}', '${locA}'), ('${salesHead}', '${locA}');
    INSERT INTO public.perms VALUES
      ('${owner}', 'job.view_costs'), ('${office}', 'job.view_costs'),
      ('${salesHead}', 'job.view_costs'), ('${gone}', 'job.view_costs');
    INSERT INTO public.jobs VALUES ('${jobA}', '${locA}'), ('${jobB}', '${locB}');
    INSERT INTO public.job_assignments VALUES ('${jobA}', '${crew}');
  `);

  /* ---- 8: the migration, verbatim, twice ------------------------------ */
  await db.exec(migration);
  await db.exec(migration);
  check(true, "the migration applies twice without error");

  const as = async (role, uid, sql) => {
    await db.exec(
      `SET ROLE ${role}; SELECT set_config('request.jwt.claim.sub', '${uid ?? ""}', false)`,
    );
    try {
      return await db.query(sql);
    } finally {
      await db.exec("RESET ROLE; SELECT set_config('request.jwt.claim.sub','',false)");
    }
  };
  const priv = async (role, table, p) =>
    (await db.query(`SELECT has_table_privilege('${role}', 'public.${table}', '${p}') AS ok`))
      .rows[0].ok;
  const cells = async (uid, job = jobA) =>
    (
      await as(
        "authenticated",
        uid,
        `SELECT cell_key FROM public.job_ledger_overrides WHERE job_id = '${job}' ORDER BY cell_key`,
      )
    ).rows.map((r) => r.cell_key);

  /* ---- 1: grants ------------------------------------------------------ */
  for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
    check(
      (await priv("anon", "job_ledger_overrides", p)) === false,
      `anon has no ${p} on overrides`,
    );
    check(
      (await priv("anon", "job_ledger_override_changes", p)) === false,
      `anon has no ${p} on the trail`,
    );
  }
  for (const p of ["INSERT", "UPDATE", "DELETE"]) {
    check(
      (await priv("authenticated", "job_ledger_override_changes", p)) === false,
      `authenticated has no ${p} on the trail`,
    );
  }

  /* ---- 3: who writes -------------------------------------------------- */
  await as(
    "authenticated",
    owner,
    `INSERT INTO public.job_ledger_overrides (job_id, cell_key, value) VALUES
       ('${jobA}', 'garbage', 350), ('${jobA}', 'equipment', 2000), ('${jobA}', 'days', 5),
       ('${jobB}', 'billed', 9000)`,
  );
  check(true, "the owner types into any job");
  await as(
    "authenticated",
    salesHead,
    `INSERT INTO public.job_ledger_overrides (job_id, cell_key, value) VALUES ('${jobA}', 'paid', 100)`,
  );
  check(true, "a sales head types into a job in their office");
  await refused(
    as(
      "authenticated",
      salesHead,
      `INSERT INTO public.job_ledger_overrides (job_id, cell_key, value) VALUES ('${jobB}', 'paid', 1)`,
    ),
    "a sales head cannot type into a job they cannot see",
  );
  for (const [who, uid] of [
    ["office", office],
    ["crew", crew],
    ["an inactive owner", gone],
    ["an outsider", outsider],
  ]) {
    await refused(
      as(
        "authenticated",
        uid,
        `INSERT INTO public.job_ledger_overrides (job_id, cell_key, value) VALUES ('${jobA}', 'truck_fee', 1)`,
      ),
      `${who} cannot type a cell`,
    );
    const upd = await as(
      "authenticated",
      uid,
      `UPDATE public.job_ledger_overrides SET value = 1 WHERE job_id = '${jobA}' RETURNING 1`,
    );
    check(upd.rows.length === 0, `${who} cannot change a typed cell`);
    const del = await as(
      "authenticated",
      uid,
      `DELETE FROM public.job_ledger_overrides WHERE job_id = '${jobA}' RETURNING 1`,
    );
    check(del.rows.length === 0, `${who} cannot put a cell back to calculated`);
  }
  await refused(
    as(
      "anon",
      null,
      `INSERT INTO public.job_ledger_overrides (job_id, cell_key, value) VALUES ('${jobA}', 'garbage', 1)`,
    ),
    "anon cannot type a cell",
  );
  await refused(
    as(
      "authenticated",
      owner,
      `INSERT INTO public.job_ledger_override_changes (job_id, cell_key, new_value) VALUES ('${jobA}', 'garbage', 1)`,
    ),
    "nobody writes the trail directly, the owner included",
  );

  /* ---- 2: who reads --------------------------------------------------- */
  check(
    JSON.stringify(await cells(owner)) === JSON.stringify(["days", "equipment", "garbage", "paid"]),
    "the owner reads every cell",
  );
  check(
    JSON.stringify(await cells(salesHead)) ===
      JSON.stringify(["days", "equipment", "garbage", "paid"]),
    "a sales head (finance + view_costs, in the office) reads every cell",
  );
  check(
    JSON.stringify(await cells(office)) === JSON.stringify(["days"]),
    "office (view_costs but not finance) reads only the effort, as the ledger shows them today",
  );
  check(
    JSON.stringify(await cells(crew)) === JSON.stringify(["days"]),
    "crew on the job read only the effort",
  );
  check((await cells(outsider)).length === 0, "someone who cannot see the job reads nothing");
  check((await cells(gone)).length === 0, "an inactive owner reads nothing");
  check(
    (await cells(salesHead, jobB)).length === 0,
    "a sales head reads nothing on another office's job",
  );
  const trailOffice = await as(
    "authenticated",
    office,
    `SELECT DISTINCT cell_key FROM public.job_ledger_override_changes WHERE job_id = '${jobA}'`,
  );
  check(
    trailOffice.rows.length === 1 && trailOffice.rows[0].cell_key === "days",
    "the trail follows the same rule: office sees only the effort entries",
  );
  // Revoking job.view_costs from the sales head hides the money again.
  await db.exec(`DELETE FROM public.perms WHERE user_id = '${salesHead}'`);
  check(
    JSON.stringify(await cells(salesHead)) === JSON.stringify(["days"]),
    "without job.view_costs the money cells disappear",
  );
  await refused(
    as(
      "authenticated",
      salesHead,
      `INSERT INTO public.job_ledger_overrides (job_id, cell_key, value) VALUES ('${jobA}', 'misc_fees', 1)`,
    ),
    "and cannot be typed",
  );
  await db.exec(`INSERT INTO public.perms VALUES ('${salesHead}', 'job.view_costs')`);

  /* ---- 4: stamping ---------------------------------------------------- */
  await as(
    "authenticated",
    salesHead,
    `UPDATE public.job_ledger_overrides
        SET value = 2500, created_by = '${outsider}', updated_by = '${outsider}',
            cell_key = 'labor', job_id = '${jobB}'
      WHERE job_id = '${jobA}' AND cell_key = 'equipment'`,
  );
  const stamped = (
    await db.query(
      `SELECT job_id, cell_key, value, created_by, updated_by FROM public.job_ledger_overrides
        WHERE job_id = '${jobA}' AND cell_key = 'equipment'`,
    )
  ).rows[0];
  check(stamped && Number(stamped.value) === 2500, "the update landed on the same cell");
  check(stamped.created_by === owner, "created_by is who first typed it, not what was sent");
  check(stamped.updated_by === salesHead, "updated_by is the session, not what was sent");

  /* ---- 5: the trail --------------------------------------------------- */
  await as(
    "authenticated",
    owner,
    `UPDATE public.job_ledger_overrides SET value = value WHERE job_id = '${jobA}' AND cell_key = 'garbage'`,
  );
  await as(
    "authenticated",
    owner,
    `DELETE FROM public.job_ledger_overrides WHERE job_id = '${jobA}' AND cell_key = 'equipment'`,
  );
  const trail = (
    await db.query(
      `SELECT cell_key, old_value, new_value, changed_by FROM public.job_ledger_override_changes
        WHERE job_id = '${jobA}' AND cell_key IN ('equipment', 'garbage') ORDER BY id`,
    )
  ).rows.map((r) => [
    r.cell_key,
    r.old_value == null ? null : Number(r.old_value),
    r.new_value == null ? null : Number(r.new_value),
    r.changed_by,
  ]);
  check(
    JSON.stringify(trail) ===
      JSON.stringify([
        ["garbage", null, 350, owner],
        ["equipment", null, 2000, owner],
        ["equipment", 2000, 2500, salesHead],
        ["equipment", 2500, null, owner],
      ]),
    "set, change and back-to-calculated are each one trail row with who, old and new; a no-change save is none",
  );
  await db.exec(`DELETE FROM public.jobs WHERE id = '${jobB}'`);
  const leftB = (
    await db.query(
      `SELECT (SELECT count(*) FROM public.job_ledger_overrides WHERE job_id = '${jobB}')::int AS o,
              (SELECT count(*) FROM public.job_ledger_override_changes WHERE job_id = '${jobB}')::int AS c`,
    )
  ).rows[0];
  check(
    leftB.o === 0 && leftB.c === 0,
    "deleting a job takes its cells and its trail, without failing",
  );

  /* ---- 7: what cannot be typed ---------------------------------------- */
  for (const k of ["referral", "commission", "total_expenses", "profit"]) {
    await assert.rejects(
      as(
        "authenticated",
        owner,
        `INSERT INTO public.job_ledger_overrides (job_id, cell_key, value) VALUES ('${jobA}', '${k}', 1)`,
      ),
      /check constraint/,
      `${k} is not a typeable cell`,
    );
    assertions++;
  }
  await assert.rejects(
    as(
      "authenticated",
      owner,
      `INSERT INTO public.job_ledger_overrides (job_id, cell_key, value) VALUES ('${jobA}', 'hours', -1)`,
    ),
    /check constraint/,
    "negative hours are refused",
  );
  assertions++;

  /* ---- 6: portal and the functions ------------------------------------ */
  const restrictive = await db.query(
    `SELECT tablename, policyname, permissive FROM pg_policies
      WHERE schemaname = 'public' AND tablename LIKE 'job_ledger_override%'
        AND policyname IN ('portal_customer_denied', 'active_profile_required', 'anonymous_business_access_denied')`,
  );
  check(restrictive.rows.length === 6, "both tables carry all three house guards");
  check(
    restrictive.rows.every((r) => r.permissive === "RESTRICTIVE"),
    "and every one of them is RESTRICTIVE",
  );
  await db.exec(`
    GRANT SELECT ON public.job_ledger_overrides, public.job_ledger_override_changes TO portal_customer;
    CREATE POLICY wide_open ON public.job_ledger_overrides FOR SELECT TO portal_customer USING (true);
    CREATE POLICY wide_open ON public.job_ledger_override_changes FOR SELECT TO portal_customer USING (true);
  `);
  for (const t of ["job_ledger_overrides", "job_ledger_override_changes"]) {
    const r = await as("portal_customer", owner, `SELECT count(*)::int AS n FROM public.${t}`);
    check(
      r.rows[0].n === 0,
      `portal_customer sees nothing in ${t}, even granted and with a permissive policy`,
    );
  }
  const fns = await db.query(
    `SELECT p.proname, p.prosecdef, p.proconfig,
            has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
            has_function_privilege('portal_customer', p.oid, 'EXECUTE') AS portal_exec
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname LIKE '%job_ledger%'`,
  );
  check(fns.rows.length === 4, "four functions: two checks, two triggers");
  for (const f of fns.rows) {
    check(
      (f.proconfig ?? []).some((c) => c.startsWith("search_path=")),
      `${f.proname} pins search_path`,
    );
    check(f.anon_exec === false, `${f.proname} is not executable by anon`);
    check(f.portal_exec === false, `${f.proname} is not executable by portal_customer`);
  }
  check(
    fns.rows
      .filter((f) => f.prosecdef)
      .map((f) => f.proname)
      .sort()
      .join() === "job_ledger_cell_readable,job_ledger_cell_writable,tg_job_ledger_overrides_audit",
    "only the two checks and the trail writer are SECURITY DEFINER",
  );

  console.log(`job-ledger-overrides.pglite: ${assertions} assertions passed`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.close();
}
