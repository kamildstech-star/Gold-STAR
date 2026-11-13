// Run with: node supabase/tests/referral-commission-rules.pglite.mjs <PGlite dist/index.js>
// In-memory fixtures only. No connection string, network access or live writes.
//
// The referrer commission rules (migration 20261007224100). Mark, 7 Oct:
// "(in admin we need to be able put the rates for each referral) ... or a
// flat fee". The migration is READ FROM THE FILE, never retyped here.
//
// What it proves:
//   1. READ is whoever can see commission today: admin/owner/dev, the finance
//      roles, job.view_costs, commission.view. A crew member reads nothing.
//   2. WRITE is whoever can edit Settings › Commissions (is_privileged): an
//      office manager who can read the deals cannot add, change or remove one.
//   3. The restrictive trio: an inactive profile sees nothing; anon has no
//      grant at all; portal_customer is denied.
//   4. The CHECKs: exactly one payee, kind percent|flat, a percent <= 100,
//      no negative value, a window that does not end before it starts.
//   5. One deal at a time per payee: an overlapping window is refused with
//      23P01, a back-to-back one is accepted, and the same dates on a
//      DIFFERENT payee are fine.
//   6. Deleting the company or person deletes their deal.
//   7. The guard trigger's function pins search_path and no client role can
//      execute it.
//
// Access helpers are stubs over small roles/permissions tables, the way the
// other fixtures here do it.
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

const ADMIN = "11111111-1111-4111-8111-111111111111";
const OFFICE = "22222222-2222-4222-8222-222222222222"; // job.view_costs
const SALES_MGR = "33333333-3333-4333-8333-333333333333"; // commission.view
const CREW = "44444444-4444-4444-8444-444444444444";
const GONE = "55555555-5555-4555-8555-555555555555"; // admin, deactivated
const HEAD = "66666666-6666-4666-8666-666666666666"; // sales_head: finance
const ACME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BETA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const JANE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

try {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE ROLE portal_customer;
    CREATE SCHEMA auth; CREATE SCHEMA goldstar_private;
    GRANT USAGE ON SCHEMA public, auth, goldstar_private TO anon, authenticated, service_role, portal_customer;

    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);

    CREATE TABLE public.profiles (user_id uuid PRIMARY KEY, is_active boolean NOT NULL);
    CREATE TABLE public.user_roles (user_id uuid, role text);
    CREATE TABLE public.user_perms (user_id uuid, key text);
    GRANT SELECT ON public.profiles, public.user_roles, public.user_perms TO authenticated;

    CREATE FUNCTION goldstar_private.profile_is_active(_u uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER AS
      $$ SELECT EXISTS (SELECT 1 FROM public.profiles WHERE user_id = _u AND is_active) $$;
    CREATE FUNCTION public.is_privileged(_u uuid) RETURNS boolean LANGUAGE sql STABLE AS
      $$ SELECT goldstar_private.profile_is_active(_u) AND EXISTS (
           SELECT 1 FROM public.user_roles WHERE user_id = _u AND role IN ('admin','owner','dev')) $$;
    CREATE FUNCTION public.can_view_finance(_u uuid) RETURNS boolean LANGUAGE sql STABLE AS
      $$ SELECT goldstar_private.profile_is_active(_u) AND EXISTS (
           SELECT 1 FROM public.user_roles WHERE user_id = _u AND role IN ('admin','owner','dev','sales_head')) $$;
    CREATE FUNCTION public.has_permission(_u uuid, _key text, _loc uuid) RETURNS boolean
      LANGUAGE sql STABLE AS
      $$ SELECT goldstar_private.profile_is_active(_u) AND EXISTS (
           SELECT 1 FROM public.user_perms WHERE user_id = _u AND key = _key) $$;

    CREATE TABLE public.accounts (id uuid PRIMARY KEY, name text);
    CREATE TABLE public.contacts (id uuid PRIMARY KEY, full_name text, account_id uuid);
    GRANT SELECT ON public.accounts, public.contacts TO authenticated;

    INSERT INTO auth.users VALUES ('${ADMIN}'), ('${OFFICE}'), ('${SALES_MGR}'), ('${CREW}'), ('${GONE}'), ('${HEAD}');
    INSERT INTO public.profiles VALUES ('${ADMIN}', true), ('${OFFICE}', true), ('${SALES_MGR}', true),
      ('${CREW}', true), ('${GONE}', false), ('${HEAD}', true);
    INSERT INTO public.user_roles VALUES ('${ADMIN}', 'admin'), ('${OFFICE}', 'office'),
      ('${SALES_MGR}', 'sales_manager'), ('${CREW}', 'crew'), ('${GONE}', 'admin'), ('${HEAD}', 'sales_head');
    INSERT INTO public.user_perms VALUES ('${OFFICE}', 'job.view_costs'), ('${SALES_MGR}', 'commission.view');
    INSERT INTO public.accounts VALUES ('${ACME}', 'Acme Brokers'), ('${BETA}', 'Beta Adjusters');
    INSERT INTO public.contacts VALUES ('${JANE}', 'Jane Broker', '${ACME}');

    -- Supabase's default privileges: every new table is handed to anon and
    -- authenticated. The migration must take that back itself.
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated;
  `);

  await db.exec(migration("20261007224100_referral_commission_rules.sql"));

  const as = async (uid, sql, role = "authenticated") => {
    await db.exec(
      `SET ROLE ${role}; SELECT set_config('request.jwt.claim.sub', '${uid ?? ""}', false)`,
    );
    try {
      return await db.query(sql);
    } finally {
      await db.exec("RESET ROLE; SELECT set_config('request.jwt.claim.sub','',false)");
    }
  };
  const fails = async (fn, code, what) => {
    try {
      await fn();
    } catch (e) {
      if (code) assert.equal(e.code, code, `${what}: wrong error ${e.code} ${e.message}`);
      assertions++;
      return;
    }
    assert.fail(`${what}: expected a refusal`);
  };
  const seen = async (uid) =>
    (await as(uid, "SELECT count(*)::int AS n FROM public.referral_commission_rules")).rows[0].n;

  /* ---- 2. write: admin only ------------------------------------------- */
  await as(
    ADMIN,
    `INSERT INTO public.referral_commission_rules (account_id, kind, value)
     VALUES ('${ACME}', 'percent', 8)`,
  );
  await as(
    ADMIN,
    `INSERT INTO public.referral_commission_rules (contact_id, kind, value, effective_from)
     VALUES ('${JANE}', 'flat', 250, '2026-07-01')`,
  );
  const stamped = (
    await db.query(
      `SELECT created_by FROM public.referral_commission_rules WHERE account_id = '${ACME}'`,
    )
  ).rows[0];
  check(stamped.created_by === ADMIN, "created_by defaults to the admin who wrote it");

  for (const [uid, who] of [
    [OFFICE, "an office manager with job.view_costs"],
    [SALES_MGR, "a sales manager with commission.view"],
    [HEAD, "a sales head (finance, not settings)"],
    [CREW, "a crew member"],
  ]) {
    await fails(
      () =>
        as(
          uid,
          `INSERT INTO public.referral_commission_rules (account_id, kind, value)
                 VALUES ('${BETA}', 'percent', 5)`,
        ),
      "42501",
      `${who} cannot add a deal`,
    );
    const upd = await as(
      uid,
      `UPDATE public.referral_commission_rules SET value = 99 RETURNING id`,
    );
    check(upd.rows.length === 0, `${who} cannot change a deal`);
    const del = await as(uid, `DELETE FROM public.referral_commission_rules RETURNING id`);
    check(del.rows.length === 0, `${who} cannot remove a deal`);
  }
  check(
    (
      await db.query(
        `SELECT value FROM public.referral_commission_rules WHERE account_id = '${ACME}'`,
      )
    ).rows[0].value === "8.00",
    "the refused writes changed nothing",
  );

  /* ---- 1. read ---------------------------------------------------------- */
  check((await seen(ADMIN)) === 2, "the admin sees both deals");
  check((await seen(HEAD)) === 2, "finance (sales head) sees both deals");
  check((await seen(OFFICE)) === 2, "job.view_costs sees both deals");
  check((await seen(SALES_MGR)) === 2, "commission.view sees both deals");
  check((await seen(CREW)) === 0, "a crew member sees no deal");

  /* ---- 3. the restrictive trio ----------------------------------------- */
  check((await seen(GONE)) === 0, "a deactivated admin sees nothing");
  await fails(
    () =>
      as(
        GONE,
        `INSERT INTO public.referral_commission_rules (account_id, kind, value)
                VALUES ('${BETA}', 'percent', 5)`,
      ),
    "42501",
    "a deactivated admin cannot write",
  );
  await fails(
    () => as(null, "SELECT * FROM public.referral_commission_rules", "anon"),
    "42501",
    "anon has no grant on the table at all",
  );
  await fails(
    () => as(null, "SELECT * FROM public.referral_commission_rules", "portal_customer"),
    "42501",
    "a portal customer has no grant on the table",
  );
  const policies = (
    await db.query(`SELECT policyname, permissive, roles::text AS roles FROM pg_policies
                    WHERE tablename = 'referral_commission_rules'`)
  ).rows;
  for (const [name, role] of [
    ["active_profile_required", "authenticated"],
    ["anonymous_business_access_denied", "anon"],
    ["portal_customer_denied", "portal_customer"],
  ]) {
    const p = policies.find((x) => x.policyname === name);
    check(
      !!p && p.permissive === "RESTRICTIVE" && p.roles.includes(role),
      `${name} is restrictive on ${role}`,
    );
  }
  const anonGrants = (
    await db.query(`SELECT count(*)::int AS n FROM information_schema.role_table_grants
                    WHERE table_name = 'referral_commission_rules' AND grantee IN ('anon','PUBLIC')`)
  ).rows[0].n;
  check(anonGrants === 0, "the default grant to anon was taken back");

  /* ---- 4. checks ------------------------------------------------------- */
  const bad = [
    [
      `(account_id, contact_id, kind, value) VALUES ('${BETA}', '${JANE}', 'percent', 5)`,
      "both a company and a person",
    ],
    [`(kind, value) VALUES ('percent', 5)`, "neither a company nor a person"],
    [`(account_id, kind, value) VALUES ('${BETA}', 'bonus', 5)`, "an unknown kind"],
    [`(account_id, kind, value) VALUES ('${BETA}', 'percent', 101)`, "a percentage over 100"],
    [`(account_id, kind, value) VALUES ('${BETA}', 'flat', -1)`, "a negative fee"],
    [
      `(account_id, kind, value, effective_from, effective_to) VALUES ('${BETA}', 'flat', 1, '2026-10-01', '2026-09-01')`,
      "a window that ends before it starts",
    ],
  ];
  for (const [values, what] of bad) {
    await fails(
      () => as(ADMIN, `INSERT INTO public.referral_commission_rules ${values}`),
      "23514",
      `refuses ${what}`,
    );
  }
  await as(
    ADMIN,
    `INSERT INTO public.referral_commission_rules (account_id, kind, value) VALUES ('${BETA}', 'flat', 1500)`,
  );
  check(
    (
      await db.query(
        `SELECT value FROM public.referral_commission_rules WHERE account_id = '${BETA}'`,
      )
    ).rows[0].value === "1500.00",
    "a flat fee over 100 dollars is fine",
  );

  /* ---- 5. one deal at a time per payee --------------------------------- */
  await fails(
    () =>
      as(
        ADMIN,
        `INSERT INTO public.referral_commission_rules (account_id, kind, value, effective_from)
                 VALUES ('${ACME}', 'percent', 9, '2027-01-01')`,
      ),
    "23P01",
    "an always-on deal leaves no room for a second one",
  );
  await as(
    ADMIN,
    `UPDATE public.referral_commission_rules SET effective_to = '2026-12-31' WHERE account_id = '${ACME}'`,
  );
  await as(
    ADMIN,
    `INSERT INTO public.referral_commission_rules (account_id, kind, value, effective_from)
     VALUES ('${ACME}', 'percent', 9, '2027-01-01')`,
  );
  check(
    (
      await db.query(
        `SELECT count(*)::int AS n FROM public.referral_commission_rules WHERE account_id = '${ACME}'`,
      )
    ).rows[0].n === 2,
    "ending the old deal makes room for the renegotiated one, back to back",
  );
  await fails(
    () =>
      as(
        ADMIN,
        `UPDATE public.referral_commission_rules SET effective_to = '2027-02-01'
                 WHERE account_id = '${ACME}' AND value = 8`,
      ),
    "23P01",
    "stretching the old deal over the new one is refused",
  );
  const upd = (
    await db.query(
      `SELECT updated_by FROM public.referral_commission_rules WHERE account_id = '${ACME}' AND value = 8`,
    )
  ).rows[0];
  check(upd.updated_by === ADMIN, "an edit records who made it");

  /* ---- 6. cascades ------------------------------------------------------ */
  await db.exec(`DELETE FROM public.contacts WHERE id = '${JANE}'`);
  check(
    (
      await db.query(
        `SELECT count(*)::int AS n FROM public.referral_commission_rules WHERE contact_id = '${JANE}'`,
      )
    ).rows[0].n === 0,
    "deleting the person deletes their deal",
  );
  await db.exec(`DELETE FROM public.accounts WHERE id = '${BETA}'`);
  check(
    (
      await db.query(
        `SELECT count(*)::int AS n FROM public.referral_commission_rules WHERE account_id = '${BETA}'`,
      )
    ).rows[0].n === 0,
    "deleting the company deletes its deal",
  );

  /* ---- 7. the trigger function ----------------------------------------- */
  const fn = (
    await db.query(`SELECT p.proconfig, p.prosecdef,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
        has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec
      FROM pg_proc p WHERE p.proname = 'tg_referral_commission_rules_guard'`)
  ).rows[0];
  check(
    (fn.proconfig ?? []).some((c) => c.startsWith("search_path=")),
    "the guard pins search_path",
  );
  check(
    fn.auth_exec === false && fn.anon_exec === false,
    "no client role can call the guard directly",
  );

  console.log(`referral-commission-rules.pglite: ${assertions} assertions passed`);
} finally {
  await db.close();
}
