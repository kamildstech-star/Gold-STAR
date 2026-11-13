// Run with: node supabase/tests/app-base-url.pglite.mjs <existing PGlite dist/index.js>
// In-memory fixtures only. The migration under test is READ FROM THE FILE.
//
// What it proves about 20261012150000:
//   1. applied to a database shaped like live (each hook_url row as it is
//      today), every caller posts to EXACTLY the URL it posted to before;
//   2. one UPDATE of app_settings 'app_base_url' moves every caller that has
//      no override of its own — the six kick functions, the automation
//      trigger and the run-automations-15min cron job;
//   3. a per-job hook_url still wins over the base;
//   4. a base that is not `https://host[:port]` falls back to the Lovable host
//      instead of sending the cron secret somewhere odd;
//   5. a signed-in user — even one app_settings_write lets in — can neither
//      read nor write the app_base_url row, and still reaches every other row;
//   6. grants and shape: kick functions SECURITY DEFINER with their live
//      search_path, service_role-only EXECUTE; helpers service_role-only;
//      tg_automation_notify keeps authenticated, anon/PUBLIC hold nothing;
//   7. re-runnable: applied twice the stored base wins, the cron job keeps its
//      jobid, and without pg_cron it applies cleanly.
//
// pg_net, pg_cron and Vault are stubbed with plain SQL of the same shape.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const FILE = "20261012150000_app_base_url.sql";
const migration = readFileSync(new URL("../migrations/" + FILE, import.meta.url), "utf8");
const LOVABLE = "https://project--b0a4cfc7-3fd3-46ba-aa5d-90a925aaa67c.lovable.app";
const STAGING = "https://goldstar.falconstaging.com";
const NEW = "https://goldstar.example.workers.dev";

let assertions = 0;
const check = (value, what) => {
  assert.equal(value, true, what);
  assertions++;
};

const FIXTURE = `
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
  CREATE TABLE public.app_settings (key text PRIMARY KEY, value jsonb NOT NULL DEFAULT '{}'::jsonb);
  ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.app_settings TO authenticated;
  -- Live: select for every signed-in user, write for is_privileged(). The
  -- test user is privileged, so only the new restrictive policy stops them.
  CREATE POLICY app_settings_select ON public.app_settings FOR SELECT TO authenticated USING (true);
  CREATE POLICY app_settings_write ON public.app_settings FOR ALL TO authenticated USING (true) WITH CHECK (true);

  CREATE TABLE public.email_messages (
    status text, release_at timestamptz, sent_at timestamptz, delivery_reason text,
    supply_request_id uuid, created_at timestamptz DEFAULT now(), delivery_attempts int DEFAULT 0,
    next_attempt_at timestamptz, claimed_at timestamptz
  );
  CREATE TABLE public.graph_mailboxes (enabled boolean);
  CREATE TABLE public.fire_feed_areas (active boolean);
  CREATE TABLE public.fire_feed_sources (enabled boolean, last_fetched_at timestamptz, poll_minutes int);
  CREATE TABLE public.fire_feed_runs (status text, started_at timestamptz);
  CREATE TABLE public.accounts (id int);

  CREATE FUNCTION public.cron_secret() RETURNS text LANGUAGE sql AS $$ SELECT 'test-cron-secret' $$;

  CREATE SCHEMA net;
  GRANT USAGE ON SCHEMA net TO authenticated;
  CREATE TABLE net.calls (id serial, url text, headers jsonb, body jsonb, timeout_milliseconds int);
  CREATE FUNCTION net.http_post(
    url text, body jsonb DEFAULT '{}'::jsonb, params jsonb DEFAULT '{}'::jsonb,
    headers jsonb DEFAULT '{"Content-Type": "application/json"}'::jsonb,
    timeout_milliseconds integer DEFAULT 5000
  ) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER AS $$
  BEGIN
    INSERT INTO net.calls (url, headers, body, timeout_milliseconds)
    VALUES (url, headers, body, timeout_milliseconds);
    RETURN 1;
  END $$;

  CREATE SCHEMA cron;
  CREATE TABLE cron.job (jobid serial PRIMARY KEY, jobname text UNIQUE, schedule text, command text, active boolean DEFAULT true);
  CREATE FUNCTION cron.schedule(job_name text, schedule text, command text) RETURNS bigint
  LANGUAGE sql AS $$
    INSERT INTO cron.job (jobname, schedule, command) VALUES (job_name, schedule, command)
    RETURNING jobid::bigint
  $$;
  CREATE FUNCTION cron.alter_job(job_id bigint, schedule text DEFAULT NULL, command text DEFAULT NULL,
    database text DEFAULT NULL, username text DEFAULT NULL, active boolean DEFAULT NULL) RETURNS void
  LANGUAGE sql AS $$
    UPDATE cron.job SET command = COALESCE(alter_job.command, cron.job.command),
                        schedule = COALESCE(alter_job.schedule, cron.job.schedule)
     WHERE jobid = job_id
  $$;

  -- Live, read 2026-10-11 (hosts only; nothing secret lives in these rows).
  INSERT INTO public.app_settings VALUES
    ('kahi', '{"enabled": true, "hook_url": "${LOVABLE}/api/public/hooks/kahi-sync"}'),
    ('raven', '{"hook_url": "${STAGING}/api/public/hooks/raven-sync"}'),
    ('drying_weather', '{"enabled": true, "hook_url": "${STAGING}/api/public/hooks/drying-weather"}'),
    ('automations', '{"event_driven": true, "hook_url": "${LOVABLE}/api/public/hooks/run-automations"}'),
    ('email_send', '{}'),
    ('fire_feed', '{"enabled": true}');
  INSERT INTO public.email_messages (status, release_at) VALUES ('held', now() - interval '1 minute');
  INSERT INTO public.graph_mailboxes VALUES (true);
  INSERT INTO public.fire_feed_areas VALUES (true);
  INSERT INTO public.fire_feed_sources VALUES (true, NULL, 5);
`;

// The live cron job before this migration: a hard-coded host inline.
const LIVE_JOB = `
  INSERT INTO cron.job (jobid, jobname, schedule, command) VALUES (18, 'run-automations-15min', '*/15 * * * *',
  $c$ select net.http_post(url:='${LOVABLE}/api/public/hooks/run-automations',
      headers:=jsonb_build_object('x-cron-secret', public.cron_secret()), body:='{}'::jsonb) $c$);
`;

const PROBE = "SELECT 1 FROM pg_extension WHERE extname = 'pg_cron'";

async function fire(db) {
  await db.exec(`TRUNCATE net.calls`);
  await db.exec(`
    SELECT public.kahi_sync_kick();
    SELECT public.raven_sync_kick('positions');
    SELECT public.drying_weather_kick();
    SELECT public.email_release_kick();
    SELECT public.graph_sync_kick();
    SELECT public.fire_feed_kick();
    INSERT INTO public.accounts VALUES (1);
  `);
  const job = await db.query(
    `SELECT command FROM cron.job WHERE jobname = 'run-automations-15min'`,
  );
  await db.exec(job.rows[0].command);
  const rows = (
    await db.query(`SELECT url, headers, timeout_milliseconds FROM net.calls ORDER BY id`)
  ).rows;
  return rows;
}

const PATHS = [
  "kahi-sync",
  "raven-sync",
  "drying-weather",
  "email-release",
  "graph-sync",
  "fire-feed",
  "run-automations", // the trigger
  "run-automations", // the cron job
];

try {
  /* ---- without pg_cron ---------------------------------------------- */
  const bare = new PGlite();
  await bare.exec(FIXTURE);
  await bare.exec(migration);
  await bare.exec(migration);
  check(true, "applies twice without pg_cron");
  const none = await bare.query(`SELECT count(*)::int AS n FROM cron.job`);
  check(none.rows[0].n === 0, "and touches no cron job without pg_cron");
  await bare.close();

  /* ---- with pg_cron, on a live-shaped database ------------------------ */
  check(migration.split(PROBE).length === 2, "the pg_cron probe appears exactly once");
  const withCron = migration.replace(PROBE, "SELECT 1");
  const db = new PGlite();
  await db.exec(FIXTURE);
  await db.exec(LIVE_JOB);
  await db.exec(withCron);
  await db.exec(`
    CREATE TRIGGER automation_notify AFTER INSERT ON public.accounts
    FOR EACH STATEMENT EXECUTE FUNCTION public.tg_automation_notify('["account_created"]');
  `);

  const job = await db.query(
    `SELECT jobid, schedule FROM cron.job WHERE jobname = 'run-automations-15min'`,
  );
  check(job.rows.length === 1 && job.rows[0].jobid === 18, "the cron job keeps its jobid");
  check(job.rows[0].schedule === "*/15 * * * *", "and its schedule");

  // 1. Nothing moves on apply.
  const before = await fire(db);
  check(before.length === PATHS.length, `every caller posts once (${before.length})`);
  const expectedToday = [
    `${LOVABLE}/api/public/hooks/kahi-sync`,
    `${STAGING}/api/public/hooks/raven-sync`,
    `${STAGING}/api/public/hooks/drying-weather`,
    `${LOVABLE}/api/public/hooks/email-release`,
    `${LOVABLE}/api/public/hooks/graph-sync`,
    `${LOVABLE}/api/public/hooks/fire-feed`,
    `${LOVABLE}/api/public/hooks/run-automations`,
    `${LOVABLE}/api/public/hooks/run-automations`,
  ];
  before.forEach((c, i) =>
    check(c.url === expectedToday[i], `unchanged today: ${expectedToday[i]}`),
  );
  check(
    before.every((c) => c.headers["x-cron-secret"] === "test-cron-secret"),
    "every call carries the cron secret",
  );
  check(
    before.every((c) => c.timeout_milliseconds === 60000),
    "every call has the 60-second timeout",
  );

  const kept = await db.query(
    `SELECT key, value->>'hook_url' AS h FROM public.app_settings WHERE key IN ('kahi','automations','raven','drying_weather') ORDER BY key`,
  );
  const hook = Object.fromEntries(kept.rows.map((r) => [r.key, r.h]));
  check(hook.kahi === null, "kahi's override, identical to the base, is dropped");
  check(hook.automations === null, "automations' override, identical to the base, is dropped");
  check(
    hook.raven === `${STAGING}/api/public/hooks/raven-sync`,
    "raven's staging override is kept",
  );
  check(
    hook.drying_weather === `${STAGING}/api/public/hooks/drying-weather`,
    "drying_weather's staging override is kept",
  );

  // email_release_kick keeps #360's second wake-up: a parked queued row due a
  // retry, with no held mail at all — and stays quiet once it is out of tries.
  const emailCalls = async () => {
    await db.exec(`TRUNCATE net.calls; SELECT public.email_release_kick();`);
    return (await db.query(`SELECT url FROM net.calls`)).rows;
  };
  await db.exec(`DELETE FROM public.email_messages`);
  check((await emailCalls()).length === 0, "no mail due: email_release_kick is quiet");
  await db.exec(`INSERT INTO public.email_messages (status, delivery_reason, delivery_attempts)
                 VALUES ('queued', 'outlook_send_failed', 2)`);
  const retry = await emailCalls();
  check(
    retry.length === 1 && retry[0].url === `${LOVABLE}/api/public/hooks/email-release`,
    "a parked queued row due a retry wakes the release hook (#360)",
  );
  await db.exec(`UPDATE public.email_messages SET delivery_attempts = 6`);
  check((await emailCalls()).length === 0, "out of attempts: quiet again");
  await db.exec(`DELETE FROM public.email_messages;
                 INSERT INTO public.email_messages (status, release_at) VALUES ('held', now() - interval '1 minute')`);

  // 2. One UPDATE moves every caller without an override.
  await db.exec(
    `UPDATE public.app_settings SET value = jsonb_build_object('url', '${NEW}/') WHERE key = 'app_base_url'`,
  );
  const moved = await fire(db);
  moved.forEach((c, i) => {
    const overridden = PATHS[i] === "raven-sync" || PATHS[i] === "drying-weather";
    const want = overridden ? expectedToday[i] : `${NEW}/api/public/hooks/${PATHS[i]}`;
    check(c.url === want, `after the UPDATE: ${want}`);
  });

  // 3. The documented cutover statement clears the remaining overrides too.
  await db.exec(`
    UPDATE public.app_settings
       SET value = CASE WHEN key = 'app_base_url' THEN jsonb_build_object('url', '${NEW}')
                        ELSE value - 'hook_url' END
     WHERE key IN ('app_base_url', 'kahi', 'raven', 'drying_weather', 'automations', 'graph_sync', 'fire_feed');
  `);
  const all = await fire(db);
  all.forEach((c, i) =>
    check(
      c.url === `${NEW}/api/public/hooks/${PATHS[i]}`,
      `after cutover: ${PATHS[i]} on the new host`,
    ),
  );

  // 4. A base that is not https://host falls back to Lovable.
  for (const bad of [
    "http://goldstar.example.com",
    "https://goldstar.example.com/app",
    "https://attacker.test@goldstar.example.com",
    "goldstar.example.com",
    "",
  ]) {
    await db.query(
      `UPDATE public.app_settings SET value = jsonb_build_object('url', $1::text) WHERE key = 'app_base_url'`,
      [bad],
    );
    const r = await db.query(`SELECT public.app_base_url() AS u`);
    check(r.rows[0].u === LOVABLE, `"${bad}" falls back to the Lovable host`);
  }
  await db.exec(`DELETE FROM public.app_settings WHERE key = 'app_base_url'`);
  check(
    (await db.query(`SELECT public.app_base_url() AS u`)).rows[0].u === LOVABLE,
    "no row: the Lovable host",
  );
  check(
    (await db.query(`SELECT public.app_hook_url('x', '  ') AS u`)).rows[0].u ===
      `${LOVABLE}/api/public/hooks/x`,
    "a blank override is no override",
  );

  // 7. Re-run: the stored base wins.
  await db.exec(
    `INSERT INTO public.app_settings VALUES ('app_base_url', jsonb_build_object('url', '${NEW}'))`,
  );
  await db.exec(withCron);
  check(
    (await db.query(`SELECT public.app_base_url() AS u`)).rows[0].u === NEW,
    "re-applying keeps the stored base",
  );
  check(
    (await db.query(`SELECT jobid FROM cron.job WHERE jobname = 'run-automations-15min'`)).rows[0]
      .jobid === 18,
    "re-applying keeps the cron job's id",
  );

  // 5. Signed-in users cannot see or change the row.
  await db.exec(`SET ROLE authenticated`);
  const seen = await db.query(`SELECT key FROM public.app_settings ORDER BY key`);
  check(!seen.rows.some((r) => r.key === "app_base_url"), "authenticated cannot read app_base_url");
  check(
    seen.rows.some((r) => r.key === "kahi"),
    "but still reads the other rows",
  );
  const upd = await db.query(
    `UPDATE public.app_settings SET value = '{"url":"https://evil.test"}' WHERE key = 'app_base_url' RETURNING key`,
  );
  check(upd.rows.length === 0, "authenticated cannot update app_base_url");
  const del = await db.query(
    `DELETE FROM public.app_settings WHERE key = 'app_base_url' RETURNING key`,
  );
  check(del.rows.length === 0, "authenticated cannot delete app_base_url");
  // Insert, on a database where the row is missing: refused by the policy,
  // not by the primary key.
  await db.exec(
    `RESET ROLE; DELETE FROM public.app_settings WHERE key = 'app_base_url'; SET ROLE authenticated`,
  );
  let refusal = "";
  try {
    await db.exec(
      `INSERT INTO public.app_settings VALUES ('app_base_url', '{"url":"https://evil.test"}')`,
    );
  } catch (e) {
    refusal = String(e.message);
  }
  check(
    /row-level security/.test(refusal),
    `authenticated cannot insert app_base_url (${refusal})`,
  );
  await db.exec(
    `RESET ROLE; INSERT INTO public.app_settings VALUES ('app_base_url', jsonb_build_object('url', '${NEW}')); SET ROLE authenticated`,
  );
  const other = await db.query(
    `UPDATE public.app_settings SET value = value || '{"enabled": true}' WHERE key = 'kahi' RETURNING key`,
  );
  check(other.rows.length === 1, "an admin still writes the other rows");
  await db.exec(`RESET ROLE`);
  check(
    (await db.query(`SELECT public.app_base_url() AS u`)).rows[0].u === NEW,
    "and the base is untouched",
  );

  // 6. Shape and grants.
  const shape = await db.query(`
    SELECT p.proname, p.prosecdef, p.proconfig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'`);
  const fn = Object.fromEntries(shape.rows.map((r) => [r.proname, r]));
  const LIVE_PATH = {
    kahi_sync_kick: ["search_path=public"],
    raven_sync_kick: ["search_path=public"],
    drying_weather_kick: ["search_path=public"],
    email_release_kick: ['search_path=""'],
    graph_sync_kick: ['search_path=""'],
    fire_feed_kick: ['search_path=""'],
    tg_automation_notify: ["search_path=public"],
  };
  for (const [name, path] of Object.entries(LIVE_PATH)) {
    check(fn[name].prosecdef === true, `${name} is SECURITY DEFINER`);
    check(
      JSON.stringify(fn[name].proconfig) === JSON.stringify(path),
      `${name} keeps its search_path`,
    );
  }
  for (const name of ["app_base_url", "app_hook_url"]) {
    check(fn[name].prosecdef === false, `${name} runs as its caller`);
    check(
      JSON.stringify(fn[name].proconfig) === JSON.stringify(['search_path=""']),
      `${name} pins search_path to ''`,
    );
  }
  const SIGS = [
    "public.kahi_sync_kick()",
    "public.raven_sync_kick(text)",
    "public.drying_weather_kick()",
    "public.email_release_kick()",
    "public.graph_sync_kick()",
    "public.fire_feed_kick()",
    "public.app_base_url()",
    "public.app_hook_url(text, text)",
  ];
  for (const sig of SIGS) {
    for (const role of ["anon", "authenticated"]) {
      const r = await db.query(
        `SELECT has_function_privilege('${role}', '${sig}', 'EXECUTE') AS ok`,
      );
      check(r.rows[0].ok === false, `${role} cannot execute ${sig}`);
    }
    const s = await db.query(
      `SELECT has_function_privilege('service_role', '${sig}', 'EXECUTE') AS ok`,
    );
    check(s.rows[0].ok === true, `service_role can execute ${sig}`);
  }
  const pub = await db.query(`
    SELECT count(*)::int AS n FROM pg_proc p, aclexplode(p.proacl) a
     WHERE p.proname IN ('kahi_sync_kick','raven_sync_kick','drying_weather_kick','email_release_kick',
                         'graph_sync_kick','fire_feed_kick','app_base_url','app_hook_url','tg_automation_notify')
       AND a.grantee = 0`);
  check(pub.rows[0].n === 0, "PUBLIC holds nothing on any of them");
  const tg = await db.query(
    `SELECT has_function_privilege('anon', 'public.tg_automation_notify()', 'EXECUTE') AS ok`,
  );
  check(tg.rows[0].ok === false, "anon cannot execute tg_automation_notify");

  await db.close();
  console.log(`app-base-url.pglite: ${assertions} assertions passed`);
} catch (error) {
  console.error(error);
  process.exit(1);
}
