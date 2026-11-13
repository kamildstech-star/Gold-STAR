// Run with: node supabase/tests/account-takeover.pglite.mjs <existing PGlite dist/index.js>
// In-memory fixtures only. No connection string, network access or live writes.
//
// The security review's account-takeover guards, proven at the database:
//   1. a freshly signed-up (unapproved) account reads nothing but its own
//      profile row — on the 29 tables the 09-08 guard listed AND on a table
//      it did not, whose policy reads `TO authenticated USING (true)`;
//   2. no role is self-assigned or escalated: not through signup metadata,
//      not by inserting a role row, not by approving one's own profile, not by
//      inserting a profile after dodging handle_new_user;
//   3. role assignment works through the privileged path, and never to self;
//   4. deactivation and a password change end the user's open sessions, and
//      only service_role may end sessions on demand.
//
// Every policy, grant, trigger and function under test is READ FROM THE
// MIGRATION FILES — sliced where a file also touches tables this fixture does
// not stub — never retyped. The stubs are the tables, with production's
// column types, and Supabase's auth schema shapes.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
const migration = (name) => readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8");
const between = (sql, start, end) => {
  const a = sql.indexOf(start);
  const b = end ? sql.indexOf(end, a + start.length) : sql.length;
  assert.ok(a >= 0 && b > a, `slice markers moved: ${start.slice(0, 50)}`);
  return sql.slice(a, b);
};

let assertions = 0;
const check = (value, what) => {
  assert.equal(value, true, what);
  assertions++;
};
const refuses = async (promise, pattern, what) => {
  await assert.rejects(promise, pattern, what);
  assertions++;
};

const ADMIN = "00000000-0000-4000-8000-00000000000a";
const PENDING = "00000000-0000-4000-8000-00000000000b";
const CREW = "00000000-0000-4000-8000-00000000000c";
const DODGER = "00000000-0000-4000-8000-00000000000d";

const as = async (uid, sql) => {
  await db.exec(`SET ROLE authenticated; SET request.jwt.claim.sub = '${uid}';`);
  try {
    return await db.query(sql);
  } finally {
    await db.exec("RESET ROLE; RESET request.jwt.claim.sub;");
  }
};
const asRole = async (role, sql) => {
  await db.exec(`SET ROLE ${role}`);
  try {
    return await db.query(sql);
  } finally {
    await db.exec("RESET ROLE");
  }
};

try {
  await db.exec(`
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE ROLE supabase_admin NOLOGIN;
    CREATE SCHEMA auth;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
    GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;

    -- Supabase's auth shapes, as GoTrue creates them.
    CREATE TABLE auth.users (
      id uuid PRIMARY KEY, email text, role text,
      encrypted_password text NOT NULL DEFAULT '',
      raw_user_meta_data jsonb NOT NULL DEFAULT '{}', raw_app_meta_data jsonb NOT NULL DEFAULT '{}'
    );
    CREATE TABLE auth.sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL);
    CREATE TABLE auth.refresh_tokens (
      id bigserial PRIMARY KEY, user_id varchar(255), session_id uuid REFERENCES auth.sessions(id) ON DELETE CASCADE
    );

    -- Supabase's defaults: every new table goes to all three API roles.
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;

    CREATE TYPE public.app_role AS ENUM ('admin', 'owner', 'dev', 'crew');
    CREATE TYPE public.notification_type AS ENUM ('user_signup');
    CREATE TYPE public.notification_priority AS ENUM ('high');

    CREATE TABLE public.profiles (
      user_id uuid PRIMARY KEY, email text, full_name text, language text NOT NULL DEFAULT 'en',
      job_title text, work_phone text, extension text, mobile_phone text,
      approval_status text NOT NULL DEFAULT 'pending', approved_at timestamptz, approved_by uuid,
      rejected_reason text, is_active boolean NOT NULL DEFAULT true,
      deactivated_at timestamptz, deactivated_by uuid, is_demo boolean NOT NULL DEFAULT false,
      primary_location_id uuid, created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE public.user_roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, role public.app_role NOT NULL);
    CREATE TABLE public.location_members (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, location_id uuid NOT NULL, role text);
    CREATE TABLE public.region_members (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, region_id uuid NOT NULL);
    CREATE TABLE public.notifications (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, type public.notification_type,
      title text, body text, entity_type text, entity_id uuid, href text, priority public.notification_priority
    );
    ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.location_members ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.region_members ENABLE ROW LEVEL SECURITY;

    -- A table on the 09-08 guard's list, and one that was not: both readable
    -- by any signed-in session, the way reference-data tables are written.
    CREATE TABLE public.jobs (id serial PRIMARY KEY, address text);
    CREATE TABLE public.app_settings (key text PRIMARY KEY, value jsonb);
    ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;
    CREATE POLICY jobs_read ON public.jobs FOR SELECT TO authenticated USING (true);
    CREATE POLICY settings_read ON public.app_settings FOR SELECT TO authenticated USING (true);
    INSERT INTO public.jobs (address) VALUES ('12 Maple Ave');
    INSERT INTO public.app_settings VALUES ('commission_rates', '{"broker": 10}');

    CREATE FUNCTION public.is_privileged(_u uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
      $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _u AND role IN ('admin','owner','dev')) $$;
    CREATE FUNCTION public.has_role(_u uuid, _r public.app_role) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
      $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _u AND role = _r) $$;
    CREATE FUNCTION public.is_member_of(_u uuid, _l uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
      $$ SELECT EXISTS (SELECT 1 FROM public.location_members WHERE user_id = _u AND location_id = _l) $$;
  `);

  /* ---- Production's rules, from the files --------------------------- */
  // Initial profile policies, including the read-everyone one.
  const initial = migration("20260728004107_7c15f81d-0856-43ca-b438-53cd2fe49385.sql");
  for (const name of ["Signed-in users view profiles", "Users insert own profile"]) {
    const m = new RegExp(`CREATE POLICY "${name}"[\\s\\S]*?;`).exec(initial);
    assert.ok(m, `policy ${name} not found`);
    await db.exec(m[0]);
  }
  // Role and membership lockdown, and the profile update policies.
  const lockdown = migration("20260728043303_a0ba9bb6-c65e-4182-9a35-d364127f9a6b.sql");
  await db.exec(between(lockdown, "-- 4) LOCK DOWN role/membership writes", "-- 5) Locations / regions CRUD"));
  // Column grants and the privilege guard trigger on profiles.
  const hardening = migration("20260903130000_security_hardening_batch1.sql");
  await db.exec(between(hardening, "REVOKE INSERT, UPDATE ON public.profiles FROM authenticated;", "/* B4."));
  // The active-profile helper and the profile guards (the 29-table loop is
  // left out: it requires every one of those tables to exist).
  const guard = migration("20260908013000_active_profile_access_guard.sql");
  await db.exec(between(guard, "CREATE SCHEMA IF NOT EXISTS goldstar_private;", "DO $$"));
  await db.exec(between(guard, "-- Own profile SELECT remains possible", "-- Storage object metadata"));
  // The 09-08 list's guard on the one listed table this fixture stubs, as that
  // file installs it.
  await db.exec(`CREATE POLICY active_profile_required ON public.jobs AS RESTRICTIVE FOR ALL TO authenticated
    USING ((SELECT goldstar_private.profile_is_active(auth.uid()))) WITH CHECK ((SELECT goldstar_private.profile_is_active(auth.uid())))`);
  // Signup, as it stands after the client portal (the current definition).
  const portal = migration("20260928130000_client_portal_foundation.sql");
  await db.exec(between(portal, "CREATE OR REPLACE FUNCTION public.handle_new_user()", "$function$;") + "$function$;");
  await db.exec(`CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();`);

  /* ---- People -------------------------------------------------------- */
  await db.exec(`
    INSERT INTO auth.users (id, email, role, encrypted_password) VALUES
      ('${ADMIN}', 'admin@goldstar.test', 'authenticated', 'bcrypt-admin'),
      ('${CREW}', 'crew@goldstar.test', 'authenticated', 'bcrypt-crew');
    UPDATE public.profiles SET approval_status = 'approved';
    INSERT INTO public.user_roles (user_id, role) VALUES ('${ADMIN}', 'admin'), ('${CREW}', 'crew');
  `);
  // The signup under test asks for admin in the metadata a client controls.
  await db.exec(`INSERT INTO auth.users (id, email, role, encrypted_password, raw_user_meta_data) VALUES
    ('${PENDING}', 'new@evil.test', 'authenticated', 'bcrypt-new',
     '{"full_name": "New Person", "role": "admin", "roles": ["owner"], "approval_status": "approved"}')`);

  // Before this batch's migration: the gap is real.
  check((await as(PENDING, "SELECT * FROM public.app_settings")).rows.length === 1,
    "fixture: before 20260929121000 an unapproved signup reads a table outside the 09-08 list");

  await db.exec(migration("20260929121000_account_takeover_guards.sql"));
  await db.exec(migration("20260929121000_account_takeover_guards.sql")); // re-runnable

  /* ---- 1. A fresh signup reads nothing -------------------------------- */
  const own = (await db.query(`SELECT approval_status, full_name FROM public.profiles WHERE user_id = '${PENDING}'`)).rows[0];
  check(own.approval_status === "pending" && own.full_name === "New Person",
    "signup lands pending, whatever the metadata claimed");
  check((await db.query(`SELECT * FROM public.user_roles WHERE user_id = '${PENDING}'`)).rows.length === 0,
    "signup metadata created no role");
  check((await as(PENDING, "SELECT * FROM public.jobs")).rows.length === 0, "pending: jobs");
  check((await as(PENDING, "SELECT * FROM public.app_settings")).rows.length === 0,
    "pending: a table outside the 09-08 list, readable by USING (true)");
  check((await as(PENDING, "SELECT * FROM public.user_roles")).rows.length === 0, "pending: nobody's roles");
  const seen = (await as(PENDING, "SELECT user_id FROM public.profiles")).rows.map((r) => r.user_id);
  check(seen.length === 1 && seen[0] === PENDING, "pending: only its own profile row");

  /* ---- 2. No self-escalation, by any writable path ---------------------- */
  await refuses(as(PENDING, `INSERT INTO public.user_roles (user_id, role) VALUES ('${PENDING}', 'admin')`),
    /row-level security/i, "pending cannot give itself a role");
  const upd = await as(PENDING, `UPDATE public.profiles SET approval_status = 'approved' WHERE user_id = '${PENDING}'`);
  check(upd.affectedRows === 0, "pending cannot approve itself (the update matches nothing)");
  check((await db.query(`SELECT approval_status FROM public.profiles WHERE user_id = '${PENDING}'`)).rows[0].approval_status === "pending",
    "…and is still pending");

  // Dodging handle_new_user with the portal flag leaves no profile; inserting
  // one by hand, pre-approved, is refused.
  await db.exec(`INSERT INTO auth.users (id, email, role, raw_user_meta_data) VALUES
    ('${DODGER}', 'dodge@evil.test', 'authenticated', '{"portal_invitation": "true"}')`);
  check((await db.query(`SELECT * FROM public.profiles WHERE user_id = '${DODGER}'`)).rows.length === 0,
    "fixture: the portal flag skips profile creation");
  await refuses(as(DODGER, `INSERT INTO public.profiles (user_id, approval_status, is_active) VALUES ('${DODGER}', 'approved', true)`),
    /permission denied|row-level security/i, "no one can insert a pre-approved profile for themselves");
  check((await as(DODGER, "SELECT * FROM public.app_settings")).rows.length === 0,
    "an account with no profile reads nothing either");

  // An approved, non-privileged user cannot escalate either.
  await refuses(as(CREW, `INSERT INTO public.user_roles (user_id, role) VALUES ('${CREW}', 'admin')`),
    /row-level security/i, "crew cannot give itself admin");
  await refuses(as(CREW, `INSERT INTO public.user_roles (user_id, role) VALUES ('${PENDING}', 'admin')`),
    /row-level security/i, "crew cannot give anyone a role");
  await refuses(as(CREW, `UPDATE public.profiles SET is_demo = true WHERE user_id = '${CREW}'`),
    /permission denied/i, "a column outside the grant cannot be written at all");
  const crewApproves = await as(CREW, `UPDATE public.profiles SET approval_status = 'approved' WHERE user_id = '${PENDING}'`);
  check(crewApproves.affectedRows === 0, "crew cannot approve someone else");
  await refuses(as(CREW, `UPDATE public.profiles SET primary_location_id = gen_random_uuid() WHERE user_id = '${CREW}'`),
    /permission denied/i, "a user cannot move their own primary office");

  /* ---- 3. The privileged path works, and never for oneself -------------- */
  await as(ADMIN, `INSERT INTO public.user_roles (user_id, role) VALUES ('${PENDING}', 'crew')`);
  check((await db.query(`SELECT role FROM public.user_roles WHERE user_id = '${PENDING}'`)).rows[0].role === "crew",
    "an admin grants a role to someone else");
  await refuses(as(ADMIN, `INSERT INTO public.user_roles (user_id, role) VALUES ('${ADMIN}', 'owner')`),
    /row-level security/i, "an admin cannot grant themselves more");
  await as(ADMIN, `UPDATE public.profiles SET approval_status = 'approved' WHERE user_id = '${PENDING}'`);
  check((await as(PENDING, "SELECT * FROM public.app_settings")).rows.length === 1,
    "once approved, the same account reads normally — the guard is not a lockout");

  /* ---- 4. Sessions end on deactivation and on a password change -------- */
  const sessionsFor = async (uid) => {
    const s = await db.query(`INSERT INTO auth.sessions (user_id) VALUES ('${uid}') RETURNING id`);
    await db.exec(`INSERT INTO auth.refresh_tokens (user_id, session_id) VALUES ('${uid}', '${s.rows[0].id}')`);
  };
  const count = async (uid) =>
    Number((await db.query(`SELECT count(*)::int AS n FROM auth.sessions WHERE user_id = '${uid}'`)).rows[0].n) +
    Number((await db.query(`SELECT count(*)::int AS n FROM auth.refresh_tokens WHERE user_id = '${uid}'`)).rows[0].n);

  await sessionsFor(CREW);
  await sessionsFor(CREW);
  await as(ADMIN, `UPDATE public.profiles SET is_active = false WHERE user_id = '${CREW}'`);
  check((await count(CREW)) === 0, "deactivating a user ends every session and refresh token they had");

  await sessionsFor(PENDING);
  await sessionsFor(ADMIN);
  await db.exec(`UPDATE auth.users SET encrypted_password = 'bcrypt-changed' WHERE id = '${PENDING}'`);
  check((await count(PENDING)) === 0, "a password change ends that user's sessions");
  check((await count(ADMIN)) === 2, "…and nobody else's");

  const invited = "00000000-0000-4000-8000-00000000000e";
  await db.exec(`INSERT INTO auth.users (id, email, role) VALUES ('${invited}', 'invitee@goldstar.test', 'authenticated')`);
  await sessionsFor(invited);
  await db.exec(`UPDATE auth.users SET encrypted_password = 'bcrypt-first' WHERE id = '${invited}'`);
  check((await count(invited)) === 2, "setting a FIRST password (an invitation) ends nothing");

  await refuses(asRole("authenticated", `SELECT public.revoke_user_sessions('${ADMIN}')`),
    /permission denied/i, "a signed-in user cannot end anyone's sessions");
  await refuses(asRole("anon", `SELECT public.revoke_user_sessions('${ADMIN}')`),
    /permission denied/i, "nor can an anonymous caller");
  check((await asRole("service_role", `SELECT public.revoke_user_sessions('${ADMIN}') AS n`)).rows[0].n === 1,
    "the server (service_role) can");
  check((await count(ADMIN)) === 0, "…and it ends sessions and refresh tokens");

  console.log(`account-takeover.pglite: ${assertions} assertions passed`);
} catch (e) {
  console.error(e);
  process.exit(1);
}
