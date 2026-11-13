// Run with: node supabase/tests/microsoft-connections.pglite.mjs <existing PGlite dist/index.js>
// In-memory fixtures only. No connection string, network access or live writes.
//
// The row boundary around Microsoft 365 delegated connections. The migration
// under test is READ FROM THE FILE, never retyped here, so this cannot drift
// from what ships.
//
// What it proves:
//   1. Supabase's default privileges (every new public table granted to anon
//      and authenticated) are taken back: anon has nothing on either table,
//      authenticated has SELECT on the metadata table and NOTHING on the
//      secrets table — not even a column.
//   2. A person reads their own connection row and nobody else's; they cannot
//      insert, update or delete any row, their own included.
//   3. The encrypted refresh token is unreadable to every client role, the
//      owner's included, and stays unreadable even if a grant is added by
//      mistake later (RLS on, no policy).
//   4. A deactivated person no longer sees their own row.
//   5. portal_customer is denied by a RESTRICTIVE policy on both tables, even
//      with a grant it should never have.
//   6. One Microsoft account belongs to one Recovery Hub user; deleting the
//      auth user deletes the connection and the token.
//   7. The migration is re-runnable.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
const migration = (name) => readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8");
const FILE = "20261007200000_microsoft_delegated_connections.sql";

let assertions = 0;
const check = (value, what) => {
  assert.equal(value, true, what);
  assertions++;
};
const refused = async (promise, pattern, what) => {
  await assert.rejects(promise, pattern, what);
  assertions++;
};

const alice = "11111111-1111-4111-8111-111111111111";
const bob = "22222222-2222-4222-8222-222222222222";
const gone = "33333333-3333-4333-8333-333333333333";
const tenant = "9f1c1b5e-0000-4000-8000-000000000001";

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
    -- client roles. The migration must undo this, not rely on its absence.
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;

    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);

    CREATE TABLE public.profiles (
      user_id uuid PRIMARY KEY,
      is_active boolean NOT NULL DEFAULT true,
      approval_status text NOT NULL DEFAULT 'approved'
    );
    CREATE FUNCTION goldstar_private.profile_is_active(_user_id uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
      SELECT EXISTS (SELECT 1 FROM public.profiles p
        WHERE p.user_id = _user_id AND p.is_active IS TRUE AND p.approval_status = 'approved');
    $$;
    GRANT EXECUTE ON FUNCTION goldstar_private.profile_is_active(uuid) TO authenticated, service_role;

    INSERT INTO auth.users VALUES ('${alice}'), ('${bob}'), ('${gone}');
    INSERT INTO public.profiles (user_id) VALUES ('${alice}'), ('${bob}'), ('${gone}');
  `);

  /* ---- The migration, verbatim, twice --------------------------------- */
  await db.exec(migration(FILE));
  await db.exec(migration(FILE));
  check(true, "the migration applies twice without error");

  // Seed as the service role, the way the server writes.
  await db.exec(`
    SET ROLE service_role;
    INSERT INTO public.microsoft_connections (user_id, tenant_id, ms_user_id, upn, scopes)
      VALUES ('${alice}', '${tenant}', 'oid-alice', 'alice@goldstar.test', ARRAY['Mail.Read']),
             ('${bob}', '${tenant}', 'oid-bob', 'bob@goldstar.test', ARRAY['Mail.Read']),
             ('${gone}', '${tenant}', 'oid-gone', 'gone@goldstar.test', ARRAY['Mail.Read']);
    INSERT INTO public.microsoft_connection_secrets (user_id, refresh_token_ciphertext, refresh_token_iv)
      VALUES ('${alice}', 'CIPHERTEXT-ALICE', 'IV-ALICE'),
             ('${bob}', 'CIPHERTEXT-BOB', 'IV-BOB'),
             ('${gone}', 'CIPHERTEXT-GONE', 'IV-GONE');
    RESET ROLE;
  `);

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
  const anyColumn = async (role, table) =>
    (
      await db.query(
        `SELECT bool_or(has_column_privilege('${role}', 'public.${table}', attname, 'SELECT')) AS ok
           FROM pg_attribute WHERE attrelid = 'public.${table}'::regclass AND attnum > 0 AND NOT attisdropped`,
      )
    ).rows[0].ok;

  /* ---- 1: grants ------------------------------------------------------ */
  for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
    check(
      (await priv("anon", "microsoft_connections", p)) === false,
      `anon has no ${p} on connections`,
    );
    check(
      (await priv("anon", "microsoft_connection_secrets", p)) === false,
      `anon has no ${p} on secrets`,
    );
    check(
      (await priv("authenticated", "microsoft_connection_secrets", p)) === false,
      `authenticated has no ${p} on secrets`,
    );
  }
  check(
    (await anyColumn("authenticated", "microsoft_connection_secrets")) === false,
    "authenticated cannot read a single column of the secrets table",
  );
  check(
    (await priv("authenticated", "microsoft_connections", "SELECT")) === true,
    "authenticated may SELECT connections",
  );
  for (const p of ["INSERT", "UPDATE", "DELETE"]) {
    check(
      (await priv("authenticated", "microsoft_connections", p)) === false,
      `authenticated has no ${p} on connections`,
    );
  }

  /* ---- 2: own row only ------------------------------------------------- */
  const mine = await as(
    "authenticated",
    alice,
    "SELECT user_id, upn FROM public.microsoft_connections",
  );
  check(mine.rows.length === 1 && mine.rows[0].user_id === alice, "alice sees exactly her own row");
  const peek = await as(
    "authenticated",
    alice,
    `SELECT count(*)::int AS n FROM public.microsoft_connections WHERE user_id = '${bob}'`,
  );
  check(peek.rows[0].n === 0, "alice cannot see bob's connection, even by asking for it");
  const nobody = await as(
    "authenticated",
    null,
    "SELECT count(*)::int AS n FROM public.microsoft_connections",
  );
  check(nobody.rows[0].n === 0, "an authenticated role with no uid sees nothing");

  await refused(
    as(
      "authenticated",
      alice,
      `UPDATE public.microsoft_connections SET upn = 'x' WHERE user_id = '${alice}'`,
    ),
    /permission denied/i,
    "alice cannot edit her own connection from the browser",
  );
  await refused(
    as(
      "authenticated",
      alice,
      `DELETE FROM public.microsoft_connections WHERE user_id = '${alice}'`,
    ),
    /permission denied/i,
    "alice cannot delete rows directly (disconnect is server code)",
  );
  await refused(
    as(
      "authenticated",
      alice,
      `INSERT INTO public.microsoft_connections (user_id, tenant_id, ms_user_id, upn) VALUES ('${alice}', 't', 'o', 'u')`,
    ),
    /permission denied/i,
    "alice cannot forge a connection",
  );

  /* ---- 3: the token is unreadable -------------------------------------- */
  await refused(
    as(
      "authenticated",
      alice,
      "SELECT refresh_token_ciphertext FROM public.microsoft_connection_secrets",
    ),
    /permission denied/i,
    "alice cannot read even her own encrypted token",
  );
  await refused(
    as("anon", null, "SELECT * FROM public.microsoft_connection_secrets"),
    /permission denied/i,
    "anon cannot read tokens",
  );
  await refused(
    as("anon", null, "SELECT * FROM public.microsoft_connections"),
    /permission denied/i,
    "anon cannot read connections",
  );
  // A mistaken grant later still returns nothing: RLS is on and no client
  // policy exists on the secrets table.
  await db.exec("GRANT SELECT ON public.microsoft_connection_secrets TO authenticated");
  const leaked = await as(
    "authenticated",
    alice,
    "SELECT count(*)::int AS n FROM public.microsoft_connection_secrets",
  );
  check(leaked.rows[0].n === 0, "a stray grant on secrets still yields no rows");
  await db.exec("REVOKE SELECT ON public.microsoft_connection_secrets FROM authenticated");
  const svc = await as(
    "service_role",
    null,
    "SELECT count(*)::int AS n FROM public.microsoft_connection_secrets",
  );
  check(svc.rows[0].n === 3, "the service role (server code) reads tokens");

  /* ---- 4: deactivated -------------------------------------------------- */
  await db.exec(`UPDATE public.profiles SET is_active = false WHERE user_id = '${gone}'`);
  const inactive = await as(
    "authenticated",
    gone,
    "SELECT count(*)::int AS n FROM public.microsoft_connections",
  );
  check(inactive.rows[0].n === 0, "a deactivated person no longer sees their own row");

  /* ---- 5: portal customer ---------------------------------------------- */
  const policies = await db.query(
    `SELECT tablename, permissive FROM pg_policies
      WHERE policyname = 'portal_customer_denied' AND schemaname = 'public'
        AND tablename IN ('microsoft_connections', 'microsoft_connection_secrets')`,
  );
  check(policies.rows.length === 2, "both tables carry portal_customer_denied");
  check(
    policies.rows.every((r) => r.permissive === "RESTRICTIVE"),
    "portal_customer_denied is RESTRICTIVE on both",
  );
  await db.exec(`
    GRANT SELECT ON public.microsoft_connections, public.microsoft_connection_secrets TO portal_customer;
    CREATE POLICY wide_open ON public.microsoft_connections FOR SELECT TO portal_customer USING (true);
    CREATE POLICY wide_open ON public.microsoft_connection_secrets FOR SELECT TO portal_customer USING (true);
  `);
  for (const table of ["microsoft_connections", "microsoft_connection_secrets"]) {
    const r = await as("portal_customer", alice, `SELECT count(*)::int AS n FROM public.${table}`);
    check(
      r.rows[0].n === 0,
      `portal_customer sees nothing in ${table}, even granted and with a permissive policy`,
    );
  }
  await db.exec(`
    DROP POLICY wide_open ON public.microsoft_connections;
    DROP POLICY wide_open ON public.microsoft_connection_secrets;
    REVOKE SELECT ON public.microsoft_connections, public.microsoft_connection_secrets FROM portal_customer;
  `);

  /* ---- 5b: the convention's restrictive policies, as applied live ------- */
  const conv = await db.query(
    `SELECT tablename, policyname, permissive, roles::text AS roles FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename IN ('microsoft_connections', 'microsoft_connection_secrets')
        AND policyname IN ('active_profile_required', 'anonymous_business_access_denied')`,
  );
  for (const table of ["microsoft_connections", "microsoft_connection_secrets"]) {
    for (const [name, role] of [
      ["active_profile_required", "authenticated"],
      ["anonymous_business_access_denied", "anon"],
    ]) {
      const p = conv.rows.find((r) => r.tablename === table && r.policyname === name);
      check(
        Boolean(p) && p.permissive === "RESTRICTIVE" && p.roles.includes(role),
        `${table} carries RESTRICTIVE ${name} for ${role}`,
      );
    }
  }

  /* ---- 6: one account, one user; cascade ------------------------------- */
  await refused(
    db.query(
      `INSERT INTO public.microsoft_connections (user_id, tenant_id, ms_user_id, upn)
         SELECT '${gone}'::uuid, '${tenant}', 'oid-alice', 'alice@goldstar.test'
         ON CONFLICT (user_id) DO UPDATE SET ms_user_id = EXCLUDED.ms_user_id`,
    ),
    /microsoft_connections_ms_account|duplicate key/i,
    "a second Recovery Hub user cannot link alice's Microsoft account",
  );
  await db.exec(`DELETE FROM auth.users WHERE id = '${bob}'`);
  const afterDelete = await db.query(
    `SELECT (SELECT count(*) FROM public.microsoft_connections WHERE user_id = '${bob}')::int AS c,
            (SELECT count(*) FROM public.microsoft_connection_secrets WHERE user_id = '${bob}')::int AS s`,
  );
  check(
    afterDelete.rows[0].c === 0 && afterDelete.rows[0].s === 0,
    "deleting the auth user deletes the connection and its token",
  );
  await db.exec(`DELETE FROM public.microsoft_connections WHERE user_id = '${alice}'`);
  const orphan = await db.query(
    `SELECT count(*)::int AS n FROM public.microsoft_connection_secrets WHERE user_id = '${alice}'`,
  );
  check(orphan.rows[0].n === 0, "deleting a connection never leaves its token behind");

  console.log(`microsoft-connections.pglite: ${assertions} assertions passed`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.close();
}
