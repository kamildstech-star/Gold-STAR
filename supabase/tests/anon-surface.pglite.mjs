// Run with: node supabase/tests/anon-surface.pglite.mjs <existing PGlite dist/index.js>
// In-memory fixtures only. No connection string, network access or live writes.
//
// The security review's section 1, as a database test: with ONLY the anon
// role's permissions — and anon starting with exactly what Supabase gives it,
// default privileges included — every table refuses read and write, every
// function refuses EXECUTE except the deliberate allowlist (empty), and no
// bucket is public except the deliberate allowlist (empty).
//
// Both migrations are READ FROM THE FILES, never retyped:
//   20260924120000_revoke_anon_function_access  (the first sweep, PUBLIC only)
//   20260929120000_anon_surface_sweep           (anon by name, tables, buckets)
//
// The objects below are the SHAPES that can exist in production: a function
// created after 20260924120000 whose migration revoked nothing (Supabase's
// defaults grant anon by name, and 0924's default-privilege line turned out
// to be a no-op), a table whose policy is written TO public, a table with no
// RLS, a view, a sequence, and a goldstar_private helper that authenticated
// reaches only through PUBLIC.
// Then, after the sweep, a brand-new function and table — the "future
// migration that forgets" — which must start closed.
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
const refuses = async (promise, what) => {
  await assert.rejects(promise, /permission denied/i, what);
  assertions++;
};
const as = async (role, sql) => {
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
    CREATE ROLE supabase_admin NOLOGIN;  -- exists in production; both migrations name it
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    CREATE SCHEMA goldstar_private;
    REVOKE ALL ON SCHEMA goldstar_private FROM PUBLIC;
    GRANT USAGE ON SCHEMA goldstar_private TO authenticated, service_role;

    -- Supabase's own defaults: every new table, function and sequence in
    -- public goes to all three API roles BY NAME.
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;

    CREATE SCHEMA storage;
    CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean NOT NULL DEFAULT false);
    INSERT INTO storage.buckets VALUES
      ('project-photos', 'project-photos', true),   -- made public from a dashboard
      ('documents', 'documents', false);

    /* ---- Objects from before the first sweep ------------------------- */
    CREATE TABLE public.jobs (id serial PRIMARY KEY, address text);
    ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;
    CREATE POLICY jobs_staff ON public.jobs FOR ALL TO authenticated USING (true) WITH CHECK (true);
    INSERT INTO public.jobs (address) VALUES ('12 Maple Ave');

    CREATE FUNCTION public.global_activity() RETURNS int LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT 1 $$;
  `);

  // As production: the first sweep ran on 2026-09-24.
  await db.exec(migration("20260924120000_revoke_anon_function_access.sql"));

  await db.exec(`
    /* ---- Objects created AFTER the first sweep ----------------------- */
    -- The slip: a trigger function whose migration revoked nothing
    -- (20260926121000). Supabase's defaults hand it to anon by name.
    CREATE FUNCTION public.tg_automation_rules_validate() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RETURN NEW; END $$;
    -- And the dangerous shape of the same slip: a callable definer function.
    CREATE FUNCTION public.run_vehicle_due_alerts() RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 42 $$;

    -- A policy written TO public: anon would read through it if it held SELECT.
    CREATE TABLE public.option_lists (id serial PRIMARY KEY, label text);
    ALTER TABLE public.option_lists ENABLE ROW LEVEL SECURITY;
    CREATE POLICY anyone ON public.option_lists FOR SELECT TO public USING (true);
    INSERT INTO public.option_lists (label) VALUES ('Water');

    -- No RLS at all: only grants stand between this and a session.
    CREATE TABLE public.staff_ledger (id serial PRIMARY KEY, margin numeric);
    INSERT INTO public.staff_ledger (margin) VALUES (41);
    CREATE VIEW public.ledger_view AS SELECT * FROM public.staff_ledger;
    CREATE SEQUENCE public.job_number_seq;

    -- A private helper authenticated reaches ONLY through PUBLIC's grant.
    CREATE FUNCTION goldstar_private.profile_is_active(u int) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
  `);

  // Before: the surface is really open, so the rest of this file proves a fix.
  check((await as("anon", "SELECT * FROM public.option_lists")).rows.length === 1,
    "fixture: anon really could read through the TO public policy");
  check((await as("anon", "SELECT * FROM public.staff_ledger")).rows.length === 1,
    "fixture: anon really could read the no-RLS table");
  check((await as("anon", "SELECT public.run_vehicle_due_alerts() AS v")).rows[0].v === 42,
    "fixture: anon really could call the post-sweep definer function");

  const sweep = migration("20260929120000_anon_surface_sweep.sql");
  await db.exec(sweep);
  await db.exec(sweep); // re-runnable: a second pass is a no-op, not an error

  /* ---- 1. Tables: every one refuses read and write ------------------- */
  for (const t of ["jobs", "option_lists", "staff_ledger", "ledger_view"]) {
    await refuses(as("anon", `SELECT * FROM public.${t}`), `anon SELECT ${t}`);
  }
  for (const t of ["jobs", "option_lists", "staff_ledger"]) {
    await refuses(as("anon", `INSERT INTO public.${t} DEFAULT VALUES`), `anon INSERT ${t}`);
    await refuses(as("anon", `UPDATE public.${t} SET id = id`), `anon UPDATE ${t}`);
    await refuses(as("anon", `DELETE FROM public.${t}`), `anon DELETE ${t}`);
  }
  await refuses(as("anon", "SELECT nextval('public.job_number_seq')"), "anon nextval");

  /* ---- 2. Functions: every one refuses EXECUTE ------------------------ */
  await refuses(as("anon", "SELECT public.global_activity()"), "pre-sweep definer function");
  await refuses(as("anon", "SELECT public.run_vehicle_due_alerts()"), "post-sweep definer function");
  const anonExec = await db.query(`
    SELECT p.oid::regprocedure::text AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname IN ('public', 'goldstar_private') AND has_function_privilege('anon', p.oid, 'EXECUTE')`);
  check(anonExec.rows.length === 0, `anon executes nothing (allowlist is empty): ${anonExec.rows.map((r) => r.sig)}`);

  /* ---- 3. Buckets: none public ---------------------------------------- */
  const publicBuckets = await db.query("SELECT id FROM storage.buckets WHERE public");
  check(publicBuckets.rows.length === 0, "no bucket left public");

  /* ---- 4. Signed-in users and the server lost nothing ----------------- */
  check((await as("authenticated", "SELECT * FROM public.jobs")).rows.length === 1, "authenticated still reads jobs");
  check((await as("authenticated", "SELECT public.run_vehicle_due_alerts() AS v")).rows[0].v === 42,
    "authenticated keeps EXECUTE it held by name");
  check((await as("authenticated", "SELECT goldstar_private.profile_is_active(1) AS v")).rows[0].v === true,
    "authenticated keeps a function it held only through PUBLIC — made explicit before PUBLIC was dropped");
  check((await as("service_role", "SELECT goldstar_private.profile_is_active(1) AS v")).rows[0].v === true,
    "service_role likewise");

  /* ---- 5. The future: a migration that forgets ------------------------- */
  await db.exec(`
    CREATE FUNCTION public.forgot_to_revoke() RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 7 $$;
    CREATE TABLE public.new_feature (id serial PRIMARY KEY, secret text);
    INSERT INTO public.new_feature (secret) VALUES ('x');
  `);
  await refuses(as("anon", "SELECT public.forgot_to_revoke()"), "a function created after the sweep starts closed to anon");
  await refuses(as("anon", "SELECT * FROM public.new_feature"), "a table created after the sweep starts closed to anon");
  check((await as("authenticated", "SELECT public.forgot_to_revoke() AS v")).rows[0].v === 7,
    "…and still open to authenticated, as Supabase intends");

  /* ---- 6. The audit really refuses a leak ------------------------------ */
  await db.exec("GRANT EXECUTE ON FUNCTION public.forgot_to_revoke() TO anon");
  const auditOnly = sweep.slice(sweep.lastIndexOf("-- The audit."));
  await assert.rejects(db.exec(auditOnly), /anon audit: anon can still execute: forgot_to_revoke\(\)/,
    "the audit rolls the migration back when anon can still execute something");
  assertions++;

  console.log(`anon-surface.pglite: ${assertions} assertions passed`);
} catch (e) {
  console.error(e);
  process.exit(1);
}
