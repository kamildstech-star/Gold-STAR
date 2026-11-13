// Run with: node supabase/tests/graph-sync-cron.pglite.mjs <existing PGlite dist/index.js>
// In-memory fixtures only. The migration under test is READ FROM THE FILE.
//
// What it proves about 20261011120000:
//   1. graph_sync_kick() is SECURITY DEFINER with search_path pinned to '',
//      and only service_role (never PUBLIC, anon or authenticated) may run it;
//   2. it posts nothing while no mailbox is enabled, or while app_settings
//      'graph_sync'.enabled is false;
//   3. otherwise it posts once to the app's graph-sync hook with the cron
//      secret in x-cron-secret and a 60-second timeout, and an app_settings
//      hook_url overrides the URL;
//   4. without pg_cron it applies cleanly and schedules nothing; with pg_cron
//      it schedules exactly one 'graph-sync' job, every 15 minutes, however
//      many times it is applied.
//
// pg_net, pg_cron and Vault are stubbed with plain SQL of the same shape.
// PGlite has no pg_cron extension, so step 4's "with pg_cron" half runs the
// file with its pg_extension probe answered true — the one line it changes is
// asserted to exist exactly once.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const FILE = "20261011120000_graph_sync_cron.sql";
const migration = readFileSync(new URL("../migrations/" + FILE, import.meta.url), "utf8");
const DEFAULT_URL =
  "https://project--b0a4cfc7-3fd3-46ba-aa5d-90a925aaa67c.lovable.app/api/public/hooks/graph-sync";

let assertions = 0;
const check = (value, what) => {
  assert.equal(value, true, what);
  assertions++;
};

const FIXTURE = `
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
  CREATE TABLE public.graph_mailboxes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    upn text NOT NULL UNIQUE,
    enabled boolean NOT NULL DEFAULT true
  );
  CREATE TABLE public.app_settings (key text PRIMARY KEY, value jsonb NOT NULL);

  CREATE FUNCTION public.cron_secret() RETURNS text LANGUAGE sql AS $$ SELECT 'test-cron-secret' $$;

  CREATE SCHEMA net;
  CREATE TABLE net.calls (url text, headers jsonb, body jsonb, timeout_milliseconds int);
  CREATE FUNCTION net.http_post(
    url text, body jsonb DEFAULT '{}'::jsonb, params jsonb DEFAULT '{}'::jsonb,
    headers jsonb DEFAULT '{"Content-Type": "application/json"}'::jsonb,
    timeout_milliseconds integer DEFAULT 5000
  ) RETURNS bigint LANGUAGE plpgsql AS $$
  BEGIN
    INSERT INTO net.calls VALUES (url, headers, body, timeout_milliseconds);
    RETURN 1;
  END $$;

  CREATE SCHEMA cron;
  CREATE TABLE cron.job (jobid serial PRIMARY KEY, jobname text UNIQUE, schedule text, command text);
  CREATE FUNCTION cron.schedule(job_name text, schedule text, command text) RETURNS bigint
  LANGUAGE sql AS $$
    INSERT INTO cron.job (jobname, schedule, command) VALUES (job_name, schedule, command)
    RETURNING jobid::bigint
  $$;
  CREATE FUNCTION cron.unschedule(job_name text) RETURNS boolean
  LANGUAGE sql AS $$ DELETE FROM cron.job WHERE jobname = job_name RETURNING true $$;
`;

const PROBE = "SELECT 1 FROM pg_extension WHERE extname = 'pg_cron'";

try {
  /* ---- without pg_cron ---------------------------------------------- */
  const bare = new PGlite();
  await bare.exec(FIXTURE);
  await bare.exec(migration);
  await bare.exec(migration);
  check(true, "applies twice without pg_cron");
  const none = await bare.query(`SELECT count(*)::int AS n FROM cron.job`);
  check(none.rows[0].n === 0, "and schedules nothing without pg_cron");
  await bare.close();

  /* ---- with pg_cron ------------------------------------------------- */
  check(migration.split(PROBE).length === 2, "the pg_cron probe appears exactly once");
  const withCron = migration.replace(PROBE, "SELECT 1");
  const db = new PGlite();
  await db.exec(FIXTURE);
  await db.exec(withCron);
  await db.exec(withCron);
  const jobs = await db.query(`SELECT jobname, schedule, command FROM cron.job`);
  check(jobs.rows.length === 1, "exactly one job after applying twice");
  check(jobs.rows[0].jobname === "graph-sync", "named graph-sync");
  check(jobs.rows[0].schedule === "7-59/15 * * * *", "every 15 minutes, offset to :07");
  check(
    jobs.rows[0].command.trim() === "SELECT public.graph_sync_kick();",
    "runs the kick function and nothing else",
  );

  /* ---- the function's shape and grants ------------------------------- */
  const fn = await db.query(`
    SELECT p.prosecdef, p.proconfig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'graph_sync_kick'`);
  check(fn.rows[0].prosecdef === true, "SECURITY DEFINER");
  check(
    JSON.stringify(fn.rows[0].proconfig) === JSON.stringify(['search_path=""']),
    "search_path pinned to ''",
  );
  for (const role of ["anon", "authenticated"]) {
    const r = await db.query(
      `SELECT has_function_privilege('${role}', 'public.graph_sync_kick()', 'EXECUTE') AS ok`,
    );
    check(r.rows[0].ok === false, `${role} cannot execute graph_sync_kick`);
  }
  const pub = await db.query(`
    SELECT EXISTS (
      SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
       WHERE p.proname = 'graph_sync_kick' AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
    ) AS ok`);
  check(pub.rows[0].ok === false, "PUBLIC holds no EXECUTE");
  const svc = await db.query(
    `SELECT has_function_privilege('service_role', 'public.graph_sync_kick()', 'EXECUTE') AS ok`,
  );
  check(svc.rows[0].ok === true, "service_role can execute it");

  /* ---- what a run does ----------------------------------------------- */
  const calls = async () => (await db.query(`SELECT * FROM net.calls`)).rows;
  const kick = () => db.exec(`SELECT public.graph_sync_kick()`);

  await kick();
  check((await calls()).length === 0, "no mailboxes: no HTTP call");

  await db.exec(
    `INSERT INTO public.graph_mailboxes (upn, enabled) VALUES ('rep@goldstar.test', false)`,
  );
  await kick();
  check((await calls()).length === 0, "only a disabled mailbox: no HTTP call");

  await db.exec(`UPDATE public.graph_mailboxes SET enabled = true`);
  await kick();
  const [first] = await calls();
  check((await calls()).length === 1, "an enabled mailbox: one call");
  check(first.url === DEFAULT_URL, "to the app's graph-sync hook on the shared app origin");
  check(first.headers["x-cron-secret"] === "test-cron-secret", "carrying the Vault cron secret");
  check(first.timeout_milliseconds === 60000, "with a 60-second timeout");

  await db.exec(`INSERT INTO public.app_settings VALUES ('graph_sync', '{"enabled": false}')`);
  await kick();
  check((await calls()).length === 1, "switched off in app_settings: no call");

  await db.exec(`UPDATE public.app_settings
    SET value = '{"hook_url": "https://goldstar.falconstaging.com/api/public/hooks/graph-sync"}'
    WHERE key = 'graph_sync'`);
  await kick();
  const last = (await calls()).at(-1);
  check(
    last.url === "https://goldstar.falconstaging.com/api/public/hooks/graph-sync",
    "hook_url overrides the URL",
  );

  await db.close();
  console.log(`graph-sync-cron.pglite: ${assertions} assertions passed`);
} catch (error) {
  console.error(error);
  process.exit(1);
}
