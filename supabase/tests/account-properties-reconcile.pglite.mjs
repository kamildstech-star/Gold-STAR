// Run with: node supabase/tests/account-properties-reconcile.pglite.mjs <existing PGlite dist/index.js>
// In-memory fixtures only. No connection string, network access or live writes.
//
// Buildings under a company (account_properties / account_property_contacts):
// 20260903090500 was never applied, Lovable's 20260907164530 made the tables
// in its own shape, and 20261007090000 reconciles the two. Every migration is
// READ FROM ITS FILE, never retyped here; Lovable's file is sliced to the two
// tables' sections (its other tables are not under test).
//
// Two databases are built, because the reconcile has to be right on both:
//
//   REPLAY -- a fresh replay of the repo: our 20260903090500 runs, then
//             Lovable's (whose CREATE TABLE IF NOT EXISTS is skipped, but whose
//             permissive policies and update_* triggers still land), with no
//             portal_customer_denied yet.
//   LIVE   -- what production has today, read from the catalogue on
//             2026-10-07: only Lovable's shape, plus the is_demo partial
//             indexes and the three restrictive policies.
//
// What it proves:
//   1. both databases end in the SAME shape -- policies (name, verb,
//      permissive, roles, USING, WITH CHECK), triggers, columns, and index
//      definitions -- and the file runs twice on each without error;
//   2. no duplicates: one unique (account_id, address_key), one updated_at
//      trigger per table, no index that repeats the unique's leading column,
//      and no permissive policy left over from Lovable's shape;
//   3. existing rows survive, and is_demo / updated_at exist on both tables;
//   4. access is 20260903090500's: a member of the office who cannot manage
//      it reads but no longer writes (Lovable's policy let them); the office's
//      manager writes; the account's assigned rep reads and writes from
//      another office; its creator reads; another office sees nothing;
//   5. a contact from another company cannot be put on a building, by insert
//      or by update, and nobody can EXECUTE the guard directly;
//   6. portal customers are refused even if a permissive grant were added by
//      mistake; anon has no privilege at all;
//   7. updated_at moves on UPDATE of either table, on both databases (a replay
//      without the column would fail every assignment edit).
//
// can_view_location / can_manage_location are stand-ins with the production
// signature and meaning for this purpose: members of the office see it, its
// managers manage it. auth.uid() reads a session setting, the way the other
// fixtures here do it.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const migration = (name) => readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8");

const OURS = "20260903090500_account_properties.sql";
const LOVABLE = "20260907164530_03c8da0d-9169-4740-a307-6b43faae9b7a.sql";
const RECONCILE = "20261007090000_account_properties_reconcile.sql";

let assertions = 0;
const check = (value, what) => {
  assert.equal(value, true, what);
  assertions++;
};
const same = (actual, expected, what) => {
  assert.deepEqual(actual, expected, what);
  assertions++;
};
const refuses = async (promise, pattern, what) => {
  await assert.rejects(promise, pattern, what);
  assertions++;
};

const manager = "11111111-1111-4111-8111-111111111111"; // manages office N
const member = "22222222-2222-4222-8222-222222222222"; // member of N, cannot manage
const rep = "33333333-3333-4333-8333-333333333333"; // assigned rep of acme, office S only
const creator = "44444444-4444-4444-8444-444444444444"; // created acme, no office
const stranger = "55555555-5555-4555-8555-555555555555"; // manages office S only
const officeN = "66666666-6666-4666-8666-666666666666";
const officeS = "77777777-7777-4777-8777-777777777777";
const acme = "88888888-8888-4888-8888-888888888888"; // account in N
const other = "99999999-9999-4999-8999-999999999999"; // another company in N
const acmeSuper = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // contact at acme
const otherSuper = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // contact at the other company
const acmeBilling = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"; // second contact at acme
const maple = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"; // a building that already exists
const mapleSuper = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"; // its existing assignment

// Lovable's file, cut to what it does to these two tables.
const lovable = migration(LOVABLE);
const lovableTables = lovable.slice(
  lovable.indexOf("-- 3. Buildings"),
  lovable.indexOf("-- 4. Trade show booth captures"),
);
const lovableTriggers =
  /DROP TRIGGER IF EXISTS update_account_properties_updated_at[\s\S]*?update_account_property_contacts_updated_at BEFORE UPDATE[^;]*;/.exec(
    lovable,
  )?.[0];
assert.ok(lovableTables.includes("CREATE TABLE IF NOT EXISTS public.account_properties"));
assert.ok(lovableTables.includes("Members of the owning office manage building contacts"));
assert.ok(lovableTriggers, "found Lovable's two updated_at triggers");

async function base(db) {
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS;
    CREATE ROLE portal_customer;
    CREATE SCHEMA auth;
    CREATE SCHEMA goldstar_private;
    GRANT USAGE ON SCHEMA public, auth, goldstar_private
      TO anon, authenticated, service_role, portal_customer;

    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE FUNCTION goldstar_private.profile_is_active(_user_id uuid) RETURNS boolean
      LANGUAGE sql STABLE AS $$ SELECT true $$;
    GRANT EXECUTE ON FUNCTION goldstar_private.profile_is_active(uuid) TO authenticated;

    -- Production's two are the same one line; each file names its own.
    CREATE FUNCTION public.set_updated_at() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN NEW.updated_at := now() + interval '1 hour'; RETURN NEW; END $$;
    CREATE FUNCTION public.update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN NEW.updated_at := now() + interval '1 hour'; RETURN NEW; END $$;

    CREATE TABLE public.accounts (
      id uuid PRIMARY KEY, location_id uuid, assigned_rep uuid, created_by uuid);
    CREATE TABLE public.contacts (id uuid PRIMARY KEY, account_id uuid REFERENCES public.accounts(id));
    CREATE TABLE public.location_members (user_id uuid, location_id uuid, can_manage boolean);
    INSERT INTO public.accounts VALUES
      ('${acme}', '${officeN}', '${rep}', '${creator}'),
      ('${other}', '${officeN}', NULL, NULL);
    INSERT INTO public.contacts VALUES
      ('${acmeSuper}', '${acme}'), ('${acmeBilling}', '${acme}'), ('${otherSuper}', '${other}');
    INSERT INTO public.location_members VALUES
      ('${manager}', '${officeN}', true),
      ('${member}', '${officeN}', false),
      ('${rep}', '${officeS}', false),
      ('${stranger}', '${officeS}', true);
    GRANT SELECT ON public.accounts, public.contacts TO authenticated;

    CREATE FUNCTION public.can_view_location(_user_id uuid, _location_id uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT EXISTS (SELECT 1 FROM public.location_members m
                      WHERE m.user_id = _user_id AND m.location_id = _location_id)
    $$;
    CREATE FUNCTION public.can_manage_location(_user_id uuid, _location_id uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT EXISTS (SELECT 1 FROM public.location_members m
                      WHERE m.user_id = _user_id AND m.location_id = _location_id AND m.can_manage)
    $$;
    GRANT EXECUTE ON FUNCTION public.can_view_location(uuid, uuid),
      public.can_manage_location(uuid, uuid) TO authenticated, portal_customer;
  `);
}

// The restrictive policies the later sweeps put on every RLS table.
const restrictive = (table, withPortal) => `
  CREATE POLICY active_profile_required ON public.${table} AS RESTRICTIVE FOR ALL TO authenticated
    USING ((SELECT goldstar_private.profile_is_active(auth.uid())))
    WITH CHECK ((SELECT goldstar_private.profile_is_active(auth.uid())));
  CREATE POLICY anonymous_business_access_denied ON public.${table} AS RESTRICTIVE FOR ALL TO anon
    USING (false) WITH CHECK (false);
  ${
    withPortal
      ? `CREATE POLICY portal_customer_denied ON public.${table} AS RESTRICTIVE FOR ALL
           TO portal_customer USING (false) WITH CHECK (false);`
      : ""
  }
`;

// A building and its Super, as they would be before the reconcile runs.
const seed = `
  INSERT INTO public.account_properties (id, account_id, name, address, address_key)
    VALUES ('${maple}', '${acme}', 'Maple Court', '12 Maple Ave.', '12 maple avenue');
  INSERT INTO public.account_property_contacts (id, property_id, contact_id)
    VALUES ('${mapleSuper}', '${maple}', '${acmeSuper}');
`;

async function replayDb() {
  const db = new PGlite();
  await base(db);
  await db.exec(migration(OURS));
  await db.exec(lovableTables);
  await db.exec(lovableTriggers);
  await db.exec(
    restrictive("account_properties", false) + restrictive("account_property_contacts", false),
  );
  // Seeded with the guard in place (ours ran), so a valid assignment.
  await db.exec(seed);
  return db;
}

async function liveDb() {
  const db = new PGlite();
  await base(db);
  await db.exec(lovableTables);
  await db.exec(lovableTriggers);
  await db.exec(`
    CREATE INDEX account_properties_is_demo_idx ON public.account_properties (is_demo) WHERE is_demo;
    CREATE INDEX account_property_contacts_is_demo_idx ON public.account_property_contacts (is_demo) WHERE is_demo;
  `);
  await db.exec(
    restrictive("account_properties", true) + restrictive("account_property_contacts", true),
  );
  await db.exec(seed);
  return db;
}

const TABLES = `('account_properties', 'account_property_contacts')`;

async function shape(db) {
  const policies = (
    await db.query(`
      SELECT c.relname AS t, p.polname AS name, p.polcmd AS cmd, p.polpermissive AS permissive,
             array(SELECT rolname FROM pg_roles WHERE oid = ANY (p.polroles) ORDER BY 1)::text AS roles,
             pg_get_expr(p.polqual, p.polrelid) AS qual,
             pg_get_expr(p.polwithcheck, p.polrelid) AS wcheck
        FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
       WHERE c.relname IN ${TABLES}
       ORDER BY 1, 2`)
  ).rows;
  const triggers = (
    await db.query(`
      SELECT c.relname AS t, t.tgname AS name, p.proname AS fn
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid
       WHERE c.relname IN ${TABLES} AND NOT t.tgisinternal
       ORDER BY 1, 2`)
  ).rows;
  const columns = (
    await db.query(`
      SELECT table_name AS t, column_name AS name, data_type, is_nullable, column_default
        FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name IN ${TABLES}
       ORDER BY 1, 2`)
  ).rows;
  // Definitions without names: live's unique is Lovable's constraint, a
  // replay's is our index, and they are the same index.
  const indexes = (
    await db.query(`
      SELECT tablename AS t, regexp_replace(indexdef, 'INDEX \\S+ ON', 'INDEX ON') AS def
        FROM pg_indexes
       WHERE schemaname = 'public' AND tablename IN ${TABLES}
       ORDER BY 1, 2`)
  ).rows;
  return { policies, triggers, columns, indexes };
}

const as = async (db, user, sql, params = [], role = "authenticated") => {
  await db.exec(`SET ROLE ${role}; SELECT set_config('request.jwt.claim.sub', '${user}', false);`);
  try {
    return await db.query(sql, params);
  } finally {
    await db.exec(`RESET ROLE;`);
  }
};

async function behaviour(db, label) {
  const at = (what) => `${label}: ${what}`;
  const seesMaple = async (user) =>
    (await as(db, user, `SELECT id FROM public.account_properties WHERE id = $1`, [maple])).rows
      .length === 1;
  const seesAssignment = async (user) =>
    (
      await as(db, user, `SELECT id FROM public.account_property_contacts WHERE id = $1`, [
        mapleSuper,
      ])
    ).rows.length === 1;
  const addBuilding = (user, key) =>
    as(
      db,
      user,
      `INSERT INTO public.account_properties (account_id, address, address_key)
       VALUES ($1, $2, $2) RETURNING id`,
      [acme, key],
    );
  const rename = async (user) =>
    (
      await as(
        db,
        user,
        `UPDATE public.account_properties SET name = 'Renamed by ' || $2 WHERE id = $1 RETURNING id`,
        [maple, user],
      )
    ).rows.length;

  /* 3: rows survive, columns exist */
  check(
    (await db.query(`SELECT name FROM public.account_properties WHERE id = $1`, [maple])).rows[0]
      ?.name === "Maple Court",
    at("the existing building survives"),
  );
  check(
    (await db.query(`SELECT count(*)::int AS n FROM public.account_property_contacts`)).rows[0]
      .n === 1,
    at("the existing assignment survives"),
  );

  /* 4: reads */
  check(await seesMaple(manager), at("the office's manager sees the building"));
  check(await seesMaple(member), at("a member of the office sees the building"));
  check(await seesMaple(rep), at("the account's assigned rep sees it from another office"));
  check(await seesMaple(creator), at("the account's creator sees it"));
  check(!(await seesMaple(stranger)), at("another office's manager does not see it"));
  check(await seesAssignment(member), at("a member of the office sees who covers it"));
  check(await seesAssignment(rep), at("the assigned rep sees who covers it"));
  check(!(await seesAssignment(stranger)), at("another office does not see who covers it"));

  /* 4: writes */
  check(
    (await addBuilding(manager, "1 manager st")).rows.length === 1,
    at("the manager adds a building"),
  );
  check(
    (await addBuilding(rep, "2 rep st")).rows.length === 1,
    at("the assigned rep adds a building"),
  );
  await refuses(
    addBuilding(member, "3 member st"),
    /row-level security/,
    at("a member who cannot manage the office cannot add a building"),
  );
  await refuses(
    addBuilding(creator, "4 creator st"),
    /row-level security/,
    at("the account's creator alone cannot add a building"),
  );
  await refuses(
    addBuilding(stranger, "5 stranger st"),
    /row-level security/,
    at("another office cannot add a building"),
  );
  check((await rename(member)) === 0, at("a member cannot rename the building"));
  check((await rename(stranger)) === 0, at("another office cannot rename the building"));
  check((await rename(manager)) === 1, at("the manager renames the building"));
  const memberDelete = await as(
    db,
    member,
    `DELETE FROM public.account_property_contacts WHERE id = $1 RETURNING id`,
    [mapleSuper],
  );
  check(memberDelete.rows.length === 0, at("a member cannot take a Super off the building"));
  await refuses(
    as(
      db,
      member,
      `INSERT INTO public.account_property_contacts (property_id, contact_id) VALUES ($1, $2)`,
      [maple, acmeBilling],
    ),
    /row-level security/,
    at("a member cannot put a person on the building"),
  );
  const repAssign = await as(
    db,
    rep,
    `INSERT INTO public.account_property_contacts (property_id, contact_id) VALUES ($1, $2) RETURNING id`,
    [maple, acmeBilling],
  );
  check(repAssign.rows.length === 1, at("the assigned rep puts a person on the building"));

  /* 5: the guard */
  await refuses(
    as(
      db,
      manager,
      `INSERT INTO public.account_property_contacts (property_id, contact_id) VALUES ($1, $2)`,
      [maple, otherSuper],
    ),
    /does not work for the company/,
    at("a contact from another company cannot be put on the building"),
  );
  await refuses(
    as(db, manager, `UPDATE public.account_property_contacts SET contact_id = $2 WHERE id = $1`, [
      mapleSuper,
      otherSuper,
    ]),
    /does not work for the company/,
    at("nor swapped in by an update"),
  );
  const guardPriv = (
    await db.query(
      `SELECT has_function_privilege('authenticated', 'public.guard_property_contact_account()', 'EXECUTE') AS a,
              has_function_privilege('anon', 'public.guard_property_contact_account()', 'EXECUTE') AS b,
              (SELECT prosecdef FROM pg_proc WHERE proname = 'guard_property_contact_account') AS definer,
              (SELECT proconfig::text FROM pg_proc WHERE proname = 'guard_property_contact_account') AS config`,
    )
  ).rows[0];
  check(!guardPriv.a && !guardPriv.b, at("nobody can EXECUTE the guard directly"));
  check(
    guardPriv.definer && guardPriv.config === "{search_path=public}",
    at("the guard is SECURITY DEFINER with a pinned search_path"),
  );

  /* 7: updated_at moves on both tables */
  const before = (
    await db.query(
      `SELECT (SELECT updated_at FROM public.account_properties WHERE id = $1) AS p,
              (SELECT updated_at FROM public.account_property_contacts WHERE id = $2) AS c`,
      [maple, mapleSuper],
    )
  ).rows[0];
  await as(
    db,
    manager,
    `UPDATE public.account_property_contacts SET sort_order = 3 WHERE id = $1`,
    [mapleSuper],
  );
  await as(
    db,
    manager,
    `UPDATE public.account_properties SET notes = 'gate code 1234' WHERE id = $1`,
    [maple],
  );
  const after = (
    await db.query(
      `SELECT (SELECT updated_at FROM public.account_properties WHERE id = $1) AS p,
              (SELECT updated_at FROM public.account_property_contacts WHERE id = $2) AS c`,
      [maple, mapleSuper],
    )
  ).rows[0];
  check(after.p > before.p, at("editing a building moves its updated_at"));
  check(after.c > before.c, at("editing an assignment moves its updated_at"));

  /* 6: portal customers and anon */
  await db.exec(`
    GRANT SELECT, INSERT ON public.account_properties, public.account_property_contacts TO portal_customer;
    CREATE POLICY mistaken_portal_read ON public.account_properties FOR ALL TO portal_customer
      USING (true) WITH CHECK (true);
  `);
  const portalRead = await as(
    db,
    manager,
    `SELECT id FROM public.account_properties`,
    [],
    "portal_customer",
  );
  check(portalRead.rows.length === 0, at("a portal customer reads no building, even when granted"));
  await refuses(
    as(
      db,
      manager,
      `INSERT INTO public.account_properties (account_id, address, address_key) VALUES ($1, 'x', 'x')`,
      [acme],
      "portal_customer",
    ),
    /row-level security/,
    at("a portal customer cannot add a building, even when granted"),
  );
  await db.exec(`
    DROP POLICY mistaken_portal_read ON public.account_properties;
    REVOKE ALL ON public.account_properties, public.account_property_contacts FROM portal_customer;
  `);
  await refuses(
    as(db, manager, `SELECT id FROM public.account_properties`, [], "anon"),
    /permission denied/,
    at("anon has no privilege on buildings"),
  );
  await refuses(
    as(db, manager, `SELECT id FROM public.account_property_contacts`, [], "anon"),
    /permission denied/,
    at("anon has no privilege on assignments"),
  );
}

try {
  const replay = await replayDb();
  const live = await liveDb();

  // Before: Lovable's permissive policy is there on both; a replay also has ours.
  const permissiveBefore = async (db) =>
    (
      await db.query(
        `SELECT polname FROM pg_policy WHERE polrelid = 'public.account_properties'::regclass
           AND polpermissive ORDER BY 1`,
      )
    ).rows.map((r) => r.polname);
  same(
    await permissiveBefore(replay),
    [
      "Members of the owning office manage buildings",
      "account_properties_select",
      "account_properties_write",
    ],
    "before: a replay has both sets of permissive policies",
  );
  same(
    await permissiveBefore(live),
    ["Members of the owning office manage buildings"],
    "before: live has only Lovable's",
  );

  /* 1: runs twice on each */
  for (const db of [replay, live]) {
    await db.exec(migration(RECONCILE));
    await db.exec(migration(RECONCILE));
  }
  check(true, "the reconcile runs twice on a replay and on live without error");

  /* 1: same end state */
  const a = await shape(replay);
  const b = await shape(live);
  same(a.policies, b.policies, "replay and live end with the same policies");
  same(a.triggers, b.triggers, "replay and live end with the same triggers");
  same(a.columns, b.columns, "replay and live end with the same columns");
  same(a.indexes, b.indexes, "replay and live end with the same indexes");

  /* 2: exactly the intended set, no duplicates */
  same(
    a.policies.map(
      (p) => `${p.t} ${p.name} ${p.cmd} ${p.permissive ? "permissive" : "restrictive"} ${p.roles}`,
    ),
    [
      "account_properties account_properties_select r permissive {authenticated}",
      "account_properties account_properties_write * permissive {authenticated}",
      "account_properties active_profile_required * restrictive {authenticated}",
      "account_properties anonymous_business_access_denied * restrictive {anon}",
      "account_properties portal_customer_denied * restrictive {portal_customer}",
      "account_property_contacts account_property_contacts_select r permissive {authenticated}",
      "account_property_contacts account_property_contacts_write * permissive {authenticated}",
      "account_property_contacts active_profile_required * restrictive {authenticated}",
      "account_property_contacts anonymous_business_access_denied * restrictive {anon}",
      "account_property_contacts portal_customer_denied * restrictive {portal_customer}",
    ],
    "the policies are 20260903090500's plus the three restrictive ones, nothing of Lovable's",
  );
  const writePolicy = a.policies.find((p) => p.name === "account_properties_write");
  check(
    /can_manage_location/.test(writePolicy.qual) &&
      /can_manage_location/.test(writePolicy.wcheck) &&
      !/can_view_location/.test(writePolicy.qual + writePolicy.wcheck),
    "writing a building is gated on managing the office, not seeing it",
  );
  same(
    a.triggers.map((t) => `${t.t} ${t.name} ${t.fn}`),
    [
      "account_properties update_account_properties_updated_at update_updated_at_column",
      "account_property_contacts guard_property_contact_account guard_property_contact_account",
      "account_property_contacts update_account_property_contacts_updated_at update_updated_at_column",
    ],
    "one updated_at trigger per table, and the guard",
  );
  const defs = a.indexes.map((i) =>
    i.def.replace(/^CREATE (UNIQUE )?INDEX ON public\.\w+ USING /, "$1"),
  );
  same(
    defs,
    [
      "btree (address_key)",
      "btree (is_demo) WHERE is_demo",
      "UNIQUE btree (account_id, address_key)",
      "UNIQUE btree (id)",
      "btree (contact_id)",
      "btree (is_demo) WHERE is_demo",
      "UNIQUE btree (id)",
      "UNIQUE btree (property_id, contact_id)",
    ],
    "the intended indexes, each once",
  );
  for (const want of [
    "account_properties is_demo",
    "account_property_contacts is_demo",
    "account_property_contacts updated_at",
  ]) {
    const [t, c] = want.split(" ");
    check(
      a.columns.some((col) => col.t === t && col.name === c && col.is_nullable === "NO"),
      `${t}.${c} exists, NOT NULL`,
    );
  }

  /* 3-7 on both */
  await behaviour(replay, "replay");
  await behaviour(live, "live");

  console.log(`account-properties-reconcile.pglite: ${assertions} assertions passed`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
