// Run with: node supabase/tests/cron-hook-timeouts.pglite.mjs <existing PGlite dist/index.js>
// In-memory fixtures only. The migration under test is READ FROM THE FILE.
//
// What it proves about 20261012120000:
//   1. every database caller of an app hook — kahi_sync_kick, raven_sync_kick,
//      drying_weather_kick, email_release_kick, tg_automation_notify and the
//      inline cron job run-automations-15min — now asks pg_net for 60 s;
//   2. otherwise they post exactly what they did (URL, header, body);
//   3. the kick functions stay SECURITY DEFINER with their search_path and are
//      executable by service_role only;
//   4. run-automations-15min keeps its jobid, schedule and active flag (it is
//      altered, not recreated), is scheduled if missing, and applying twice
//      changes nothing.
//
// pg_net, pg_cron and Vault are stubbed with plain SQL of the same shape.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const FILE = "20261012120000_cron_hook_timeouts.sql";
const migration = readFileSync(new URL("../migrations/" + FILE, import.meta.url), "utf8");
const RUN_AUTOMATIONS =
  "https://project--b0a4cfc7-3fd3-46ba-aa5d-90a925aaa67c.lovable.app/api/public/hooks/run-automations";

let assertions = 0;
const check = (value, what) => {
  assert.equal(value, true, what);
  assertions++;
};

const FIXTURE = `
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
  CREATE TABLE public.app_settings (key text PRIMARY KEY, value jsonb NOT NULL);
  CREATE TABLE public.email_messages (id serial PRIMARY KEY, status text, release_at timestamptz);
  CREATE TABLE public.tasks (id serial PRIMARY KEY, title text);

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

  -- What the live functions looked like before: default timeout, and the
  -- default grant (EXECUTE to PUBLIC) that 20261011130000 then revoked.
  CREATE FUNCTION public.kahi_sync_kick() RETURNS void LANGUAGE sql AS $$ SELECT $$;
  CREATE FUNCTION public.raven_sync_kick(_mode text DEFAULT 'positions') RETURNS void LANGUAGE sql AS $$ SELECT $$;
  CREATE FUNCTION public.drying_weather_kick() RETURNS void LANGUAGE sql AS $$ SELECT $$;
  CREATE FUNCTION public.email_release_kick() RETURNS void LANGUAGE sql AS $$ SELECT $$;
  CREATE FUNCTION public.tg_automation_notify() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
  CREATE TRIGGER tasks_automation AFTER INSERT ON public.tasks
    FOR EACH ROW EXECUTE FUNCTION public.tg_automation_notify('["task_created"]');

  CREATE SCHEMA cron;
  CREATE TABLE cron.job (
    jobid serial PRIMARY KEY, jobname text UNIQUE, schedule text, command text,
    active boolean NOT NULL DEFAULT true
  );
  CREATE FUNCTION cron.schedule(job_name text, schedule text, command text) RETURNS bigint
  LANGUAGE sql AS $$
    INSERT INTO cron.job (jobname, schedule, command) VALUES (job_name, schedule, command)
    RETURNING jobid::bigint
  $$;
  CREATE FUNCTION cron.unschedule(job_name text) RETURNS boolean
  LANGUAGE sql AS $$ DELETE FROM cron.job WHERE jobname = job_name RETURNING true $$;
  CREATE FUNCTION cron.alter_job(
    job_id bigint, schedule text DEFAULT NULL, command text DEFAULT NULL,
    database text DEFAULT NULL, username text DEFAULT NULL, active boolean DEFAULT NULL
  ) RETURNS void LANGUAGE sql AS $$
    UPDATE cron.job
       SET schedule = COALESCE(alter_job.schedule, cron.job.schedule),
           command = COALESCE(alter_job.command, cron.job.command),
           active = COALESCE(alter_job.active, cron.job.active)
     WHERE jobid = job_id
  $$;
`;

const PROBE = "SELECT 1 FROM pg_extension WHERE extname = 'pg_cron'";
const LIVE_JOB = `
  select net.http_post(
    url:='${RUN_AUTOMATIONS}',
    headers:=jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', public.cron_secret()),
    body:='{}'::jsonb
  ) as request_id;
  `;

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

  check(migration.split(PROBE).length === 2, "the pg_cron probe appears exactly once");
  const withCron = migration.replace(PROBE, "SELECT 1");

  /* ---- run-automations-15min missing: scheduled ---------------------- */
  const fresh = new PGlite();
  await fresh.exec(FIXTURE);
  await fresh.exec(withCron);
  const made = await fresh.query(`SELECT schedule, command FROM cron.job`);
  check(made.rows.length === 1, "a missing run-automations-15min is scheduled");
  check(made.rows[0].schedule === "*/15 * * * *", "every 15 minutes");
  await fresh.close();

  /* ---- run-automations-15min live: altered in place ------------------ */
  const db = new PGlite();
  await db.exec(FIXTURE);
  await db.exec(`INSERT INTO cron.job (jobid, jobname, schedule, command, active)
                 VALUES (18, 'run-automations-15min', '*/15 * * * *', $c$${LIVE_JOB}$c$, true)`);
  await db.exec(`INSERT INTO cron.job (jobid, jobname, schedule, command)
                 VALUES (14, 'kahi-equipment-sync', '*/15 * * * *', 'SELECT public.kahi_sync_kick();')`);
  await db.exec(withCron);
  await db.exec(withCron);
  const jobs = await db.query(
    `SELECT jobid, jobname, schedule, command, active FROM cron.job ORDER BY jobid`,
  );
  check(jobs.rows.length === 2, "no job added or dropped after applying twice");
  const ra = jobs.rows.find((j) => j.jobname === "run-automations-15min");
  check(ra.jobid === 18, "run-automations-15min keeps its jobid");
  check(ra.schedule === "*/15 * * * *" && ra.active === true, "and its schedule and active flag");
  check(
    jobs.rows.find((j) => j.jobid === 14).command === "SELECT public.kahi_sync_kick();",
    "other jobs are untouched",
  );

  // Run the job's command and see what it posts.
  await db.exec(ra.command);
  let call = (await db.query(`SELECT * FROM net.calls`)).rows.at(-1);
  check(call.url === RUN_AUTOMATIONS, "run-automations-15min posts to the same URL");
  check(call.headers["x-cron-secret"] === "test-cron-secret", "with the cron secret");
  check(JSON.stringify(call.body) === "{}", "and the same empty body");
  check(call.timeout_milliseconds === 60000, "run-automations-15min: 60-second timeout");
  check(
    ra.command.replace(/,\s*timeout_milliseconds:=60000/, "").replace(/\s+/g, " ") ===
      LIVE_JOB.replace(/\s+/g, " "),
    "run-automations-15min's command is the live one plus the timeout, nothing else",
  );

  /* ---- the kick functions -------------------------------------------- */
  await db.exec(`INSERT INTO public.app_settings VALUES
    ('kahi', '{"hook_url": "https://app.test/api/public/hooks/kahi-sync"}'),
    ('raven', '{"hook_url": "https://app.test/api/public/hooks/raven-sync"}'),
    ('drying_weather', '{"hook_url": "https://app.test/api/public/hooks/drying-weather"}'),
    ('automations', '{"hook_url": "https://app.test/api/public/hooks/run-automations"}')`);
  await db.exec(
    `INSERT INTO public.email_messages (status, release_at) VALUES ('held', now() - interval '1 minute')`,
  );

  const cases = [
    ["kahi_sync_kick()", "SELECT public.kahi_sync_kick()", "kahi-sync", { mode: "assets" }],
    [
      "raven_sync_kick(text)",
      "SELECT public.raven_sync_kick('positions')",
      "raven-sync",
      { mode: "positions" },
    ],
    ["drying_weather_kick()", "SELECT public.drying_weather_kick()", "drying-weather", {}],
    ["email_release_kick()", "SELECT public.email_release_kick()", "email-release", {}],
    [
      "tg_automation_notify()",
      "INSERT INTO public.tasks (title) VALUES ('x')",
      "run-automations",
      { triggers: ["task_created"] },
    ],
  ];
  for (const [sig, run, hook, body] of cases) {
    await db.exec(run);
    call = (await db.query(`SELECT * FROM net.calls`)).rows.at(-1);
    check(call.url.endsWith(`/api/public/hooks/${hook}`), `${sig} posts to ${hook}`);
    check(call.headers["x-cron-secret"] === "test-cron-secret", `${sig} sends the cron secret`);
    check(JSON.stringify(call.body) === JSON.stringify(body), `${sig} sends the same body`);
    check(call.timeout_milliseconds === 60000, `${sig}: 60-second timeout`);

    const fn = await db.query(
      `SELECT prosecdef, proconfig FROM pg_proc WHERE oid = 'public.${sig}'::regprocedure`,
    );
    check(fn.rows[0].prosecdef === true, `${sig} is SECURITY DEFINER`);
    const sp = ["email_release_kick()"].includes(sig) ? 'search_path=""' : "search_path=public";
    check(JSON.stringify(fn.rows[0].proconfig) === JSON.stringify([sp]), `${sig} keeps ${sp}`);
    if (sig === "tg_automation_notify()") continue;
    for (const role of ["anon", "authenticated"]) {
      const r = await db.query(
        `SELECT has_function_privilege('${role}', 'public.${sig}', 'EXECUTE') AS ok`,
      );
      check(r.rows[0].ok === false, `${role} cannot execute ${sig}`);
    }
    const svc = await db.query(
      `SELECT has_function_privilege('service_role', 'public.${sig}', 'EXECUTE') AS ok`,
    );
    check(svc.rows[0].ok === true, `service_role can execute ${sig}`);
  }

  /* ---- no caller of net.http_post left on the default ---------------- */
  const stragglers = await db.query(`
    SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prosrc ILIKE '%net.http_post%'
       AND p.prosrc NOT ILIKE '%timeout_milliseconds := 60000%'`);
  check(stragglers.rows.length === 0, "every public caller of net.http_post passes 60000");

  await db.close();
  console.log(`cron-hook-timeouts.pglite: ${assertions} assertions passed`);
} catch (error) {
  console.error(error);
  process.exit(1);
}
