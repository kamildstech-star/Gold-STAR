// Run with: node supabase/tests/fire-feed.pglite.mjs <existing PGlite dist/index.js>
// In-memory fixtures only. No connection string, network access or live writes.
//
// The fire feed (migration 20261011140000, READ FROM THE FILE).
// Mark: "we need to make a feed that crawls google and x for fires in certain
// areas and gathers those and can implement it into the program in place of
// bnn", then "I don't want to pay API fees."
//
// What it proves:
//   1. the seed: one watch area per active office town (two Lakewood offices
//      share one), one Google News source, the master switch OFF — and a
//      re-run adds nothing and does not undo an admin's switch;
//   2. incidents.source_links defaults to [] and must be an array;
//   3. only is_privileged configures areas and sources; crew, a deactivated
//      admin, anon and a portal customer cannot read or write them;
//   4. admins write configuration columns only — the hook's fetch state
//      (last_error, etag, …) and the stamps are not theirs;
//   5. the Google News row cannot be deleted; an RSS row can;
//   6. runs and the ledger are admin-read, service-written; cursors are
//      machine-only;
//   7. the CHECKs: two-minute floor per URL, a URL for every non-Google
//      source, a real state, five-digit ZIPs, one Google News row;
//   8. the kick posts only when the feed is on, an area is active, a source
//      is due and no run is in flight — and only the scheduler may call it;
//   9. anon and PUBLIC hold no grant on any of it.
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
const crew = "22222222-2222-4222-8222-222222222222";
const gone = "33333333-3333-4333-8333-333333333333"; // deactivated admin

try {
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS;
    CREATE ROLE portal_customer NOLOGIN NOINHERIT;
    CREATE SCHEMA auth;
    CREATE SCHEMA goldstar_private;
    CREATE SCHEMA net;
    GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role, portal_customer;
    GRANT USAGE ON SCHEMA goldstar_private TO authenticated, service_role;
    GRANT USAGE ON SCHEMA net TO service_role;

    -- Supabase's own default: every table created in public is granted to the
    -- client roles. The migration must undo this, not rely on its absence.
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

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
      $$ SELECT goldstar_private.profile_is_active(_user_id) AND EXISTS (
           SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role IN ('owner', 'admin', 'dev')) $$;
    GRANT EXECUTE ON FUNCTION public.is_privileged(uuid) TO authenticated;

    CREATE TABLE public.locations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text, name text, locality text, region text,
      lat double precision, lon double precision, active boolean NOT NULL DEFAULT true);
    CREATE TABLE public.incidents (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source text NOT NULL, external_ref text,
      reported_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE public.app_settings (key text PRIMARY KEY, value jsonb NOT NULL);

    CREATE TABLE net.calls (url text, headers jsonb, body jsonb, timeout_milliseconds int);
    CREATE FUNCTION net.http_post(url text, headers jsonb, body jsonb, timeout_milliseconds int DEFAULT 5000)
    RETURNS bigint LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO net.calls VALUES (url, headers, body, timeout_milliseconds);
      RETURN 1;
    END $$;
    CREATE FUNCTION public.cron_secret() RETURNS text LANGUAGE sql AS $$ SELECT 'test-cron-secret' $$;
    REVOKE ALL ON FUNCTION public.cron_secret() FROM PUBLIC, anon, authenticated;

    INSERT INTO public.profiles VALUES ('${admin}', true), ('${crew}', true), ('${gone}', false);
    INSERT INTO public.user_roles VALUES ('${admin}', 'admin'), ('${crew}', 'crew'), ('${gone}', 'admin');
    INSERT INTO public.locations (code, name, locality, region, lat, lon, active) VALUES
      ('CAT', 'CAT', 'Lakewood', 'NJ', 40.08, -74.21, true),
      ('NJ',  'NJ',  'Lakewood', 'NJ', 40.09, -74.22, true),
      ('NY-UP', 'NY-Upstate', 'Haverstraw', 'NY', 41.20, -73.96, true),
      ('OLD', 'Closed', 'Trenton', 'NJ', 40.22, -74.76, false),
      ('XX', 'No town', NULL, 'NJ', NULL, NULL, true);
  `);

  await db.exec(migration("20261011140000_fire_feed.sql"));

  const as = async (uid, sql, role = "authenticated") => {
    await db.exec(`SET ROLE ${role}; SET request.jwt.claim.sub = '${uid ?? ""}'`);
    try {
      return await db.query(sql);
    } finally {
      await db.exec("RESET ROLE; SELECT set_config('request.jwt.claim.sub','',false)");
    }
  };
  const one = async (sql) => (await db.query(sql)).rows[0];
  const n = async (sql) => Number((await one(sql)).n);

  /* ---- 1: the seed -------------------------------------------------------- */
  check(
    (await n(`SELECT count(*) AS n FROM public.fire_feed_areas`)) === 2,
    "one area per active office town",
  );
  const lakewood = await one(`SELECT * FROM public.fire_feed_areas WHERE locality = 'Lakewood'`);
  check(
    lakewood.state === "NJ" && Number(lakewood.radius_miles) === 15 && lakewood.active,
    "Lakewood, NJ, 15 miles, on",
  );
  check(lakewood.label === "Lakewood, NJ", "labelled the way a person writes it");
  check(
    (await n(`SELECT count(*) AS n FROM public.fire_feed_areas WHERE locality = 'Trenton'`)) === 0,
    "a closed office seeds nothing",
  );
  check(
    (await n(`SELECT count(*) AS n FROM public.fire_feed_sources WHERE kind = 'google_news'`)) ===
      1,
    "one Google News source",
  );
  check(
    (await one(`SELECT value FROM public.app_settings WHERE key = 'fire_feed'`)).value.enabled ===
      false,
    "the master switch starts OFF",
  );
  await db.exec(
    `UPDATE public.app_settings SET value = '{"enabled": true}' WHERE key = 'fire_feed'`,
  );
  await db.exec(migration("20261011140000_fire_feed.sql"));
  check(
    (await n(`SELECT count(*) AS n FROM public.fire_feed_areas`)) === 2,
    "a re-run seeds no second area",
  );
  check(
    (await n(`SELECT count(*) AS n FROM public.fire_feed_sources`)) === 1,
    "a re-run adds no second Google News row",
  );
  check(
    (await one(`SELECT value FROM public.app_settings WHERE key = 'fire_feed'`)).value.enabled ===
      true,
    "and does not switch off a feed an admin turned on",
  );
  await db.exec(
    `UPDATE public.app_settings SET value = '{"enabled": false}' WHERE key = 'fire_feed'`,
  );

  /* ---- 2: incidents.source_links ------------------------------------------- */
  await db.exec(`INSERT INTO public.incidents (source, external_ref) VALUES ('bnn', 'a1')`);
  check(
    JSON.stringify(
      (await one(`SELECT source_links FROM public.incidents WHERE external_ref = 'a1'`))
        .source_links,
    ) === "[]",
    "an incident from any source starts with no links (BNN rows unchanged)",
  );
  await refuses(
    db.query(`UPDATE public.incidents SET source_links = '{"url": "x"}' WHERE external_ref = 'a1'`),
    /check constraint/,
    "source_links must be an array",
  );

  /* ---- 3: who configures ---------------------------------------------------- */
  check(
    (await as(crew, `SELECT count(*)::int AS n FROM public.fire_feed_areas`)).rows[0].n === 0,
    "crew see no watch areas",
  );
  check(
    (await as(gone, `SELECT count(*)::int AS n FROM public.fire_feed_sources`)).rows[0].n === 0,
    "a deactivated admin sees no sources (active_profile_required)",
  );
  await refuses(
    as(crew, `INSERT INTO public.fire_feed_areas (label, locality, state) VALUES ('X', 'X', 'NJ')`),
    /row-level security/,
    "crew cannot add an area",
  );
  await refuses(
    as(null, `SELECT count(*) FROM public.fire_feed_areas`, "anon"),
    /permission denied/,
    "anon has no grant on areas",
  );
  await refuses(
    as(crew, `SELECT count(*) FROM public.fire_feed_sources`, "portal_customer"),
    /permission denied/,
    "a portal customer has no grant on sources",
  );
  await db.exec(`GRANT SELECT ON public.fire_feed_areas TO portal_customer`);
  check(
    (await as(crew, `SELECT count(*)::int AS n FROM public.fire_feed_areas`, "portal_customer"))
      .rows[0].n === 0,
    "a stray grant still shows a portal customer nothing (portal_customer_denied)",
  );
  await db.exec(`REVOKE SELECT ON public.fire_feed_areas FROM portal_customer`);

  check(
    (await as(admin, `SELECT count(*)::int AS n FROM public.fire_feed_areas`)).rows[0].n === 2,
    "an admin sees every area",
  );
  await as(
    admin,
    `INSERT INTO public.fire_feed_areas (label, locality, county, state, postal_codes, radius_miles)
     VALUES ('Toms River, NJ', 'Toms River', 'Ocean', 'NJ', '{08753,08755}', 8)`,
  );
  check(
    (
      await one(
        `SELECT updated_by::text AS u FROM public.fire_feed_areas WHERE locality = 'Toms River'`,
      )
    ).u === admin,
    "an admin adds an area, stamped with who added it",
  );
  await as(admin, `UPDATE public.fire_feed_areas SET active = false WHERE locality = 'Haverstraw'`);
  check(
    (await one(`SELECT active FROM public.fire_feed_areas WHERE locality = 'Haverstraw'`))
      .active === false,
    "an admin switches an area off",
  );
  await as(
    admin,
    `INSERT INTO public.fire_feed_sources (kind, label, url, poll_minutes)
     VALUES ('rss', 'Monroe County 911', 'https://www.monroecounty.gov/incidents911.rss', 5)`,
  );
  check(
    (await n(`SELECT count(*) AS n FROM public.fire_feed_sources WHERE kind = 'rss'`)) === 1,
    "an admin adds an RSS feed",
  );

  /* ---- 4: configuration columns only ---------------------------------------- */
  await refuses(
    as(admin, `UPDATE public.fire_feed_sources SET last_error = 'hi' WHERE kind = 'rss'`),
    /permission denied/,
    "the fetch state is the hook's, not an admin's",
  );
  await refuses(
    as(admin, `UPDATE public.fire_feed_sources SET etag = 'W/"x"' WHERE kind = 'rss'`),
    /permission denied/,
    "an admin cannot plant a validator that would hide new items behind a 304",
  );
  await refuses(
    as(
      admin,
      `UPDATE public.fire_feed_areas SET updated_by = '${crew}' WHERE locality = 'Toms River'`,
    ),
    /permission denied/,
    "nobody writes the stamp by hand",
  );
  await refuses(
    as(admin, `UPDATE public.fire_feed_sources SET kind = 'public_page' WHERE kind = 'rss'`),
    /permission denied/,
    "a source's kind is fixed once added",
  );
  await as(
    admin,
    `UPDATE public.fire_feed_sources SET enabled = false, poll_minutes = 10 WHERE kind = 'rss'`,
  );
  check(
    (await one(`SELECT enabled, poll_minutes FROM public.fire_feed_sources WHERE kind = 'rss'`))
      .poll_minutes === 10,
    "an admin changes a feed's schedule and switch",
  );

  /* ---- 5: Google News stays ---------------------------------------------------- */
  const gnDel = await as(
    admin,
    `DELETE FROM public.fire_feed_sources WHERE kind = 'google_news' RETURNING id`,
  );
  check(gnDel.rows.length === 0, "the Google News row cannot be deleted, only switched off");
  const rssDel = await as(
    admin,
    `DELETE FROM public.fire_feed_sources WHERE kind = 'rss' RETURNING id`,
  );
  check(rssDel.rows.length === 1, "an RSS feed can be removed");

  /* ---- 6: runs, ledger, cursors ---------------------------------------------- */
  await db.exec(`INSERT INTO public.fire_feed_runs (status, leads_created) VALUES ('ok', 2)`);
  const gnId = (await one(`SELECT id FROM public.fire_feed_sources WHERE kind = 'google_news'`)).id;
  await db.exec(`
    INSERT INTO public.fire_feed_items (item_key, source_id, source_kind, decision, reason)
    VALUES ('gnews:abc', '${gnId}', 'google_news', 'skipped', 'not_a_fire');
    INSERT INTO public.fire_feed_cursors (source_id, query_key, cursor) VALUES ('${gnId}', 'area:x', '{}');
  `);
  check(
    (await as(admin, `SELECT count(*)::int AS n FROM public.fire_feed_runs`)).rows[0].n === 1 &&
      (await as(admin, `SELECT count(*)::int AS n FROM public.fire_feed_items`)).rows[0].n === 1,
    "an admin reads the run log and the ledger",
  );
  check(
    (await as(crew, `SELECT count(*)::int AS n FROM public.fire_feed_runs`)).rows[0].n === 0,
    "crew read no runs",
  );
  await refuses(
    as(admin, `INSERT INTO public.fire_feed_runs (status) VALUES ('ok')`),
    /permission denied/,
    "only the hook writes a run",
  );
  await refuses(
    as(admin, `DELETE FROM public.fire_feed_items`),
    /permission denied/,
    "only the hook prunes the ledger",
  );
  await refuses(
    as(admin, `SELECT * FROM public.fire_feed_cursors`),
    /permission denied/,
    "cursors are machine state, not even admin-readable",
  );

  /* ---- 7: the CHECKs ----------------------------------------------------------- */
  await refuses(
    as(
      admin,
      `INSERT INTO public.fire_feed_sources (kind, label, url, poll_minutes) VALUES ('rss', 'Fast', 'https://a.example/f', 1)`,
    ),
    /check constraint/,
    "no URL is polled more often than every two minutes",
  );
  await refuses(
    as(
      admin,
      `INSERT INTO public.fire_feed_sources (kind, label) VALUES ('public_page', 'No URL')`,
    ),
    /check constraint/,
    "every source but Google News needs a URL",
  );
  await refuses(
    as(
      admin,
      `INSERT INTO public.fire_feed_sources (kind, label, url) VALUES ('x', 'Paid', 'https://api.x.com/2')`,
    ),
    /check constraint/,
    "no paid X source kind exists",
  );
  await refuses(
    as(
      admin,
      `INSERT INTO public.fire_feed_sources (kind, label, url) VALUES ('rss', 'Bad', 'javascript:alert(1)')`,
    ),
    /check constraint/,
    "only http(s) URLs",
  );
  await refuses(
    as(
      admin,
      `INSERT INTO public.fire_feed_areas (label, locality, state) VALUES ('X', 'X', 'New Jersey')`,
    ),
    /check constraint/,
    "a state is two capital letters",
  );
  await refuses(
    as(
      admin,
      `INSERT INTO public.fire_feed_areas (label, locality, state, postal_codes) VALUES ('X', 'X', 'NJ', '{0870}')`,
    ),
    /check constraint/,
    "ZIPs are five digits",
  );
  await refuses(
    as(admin, `INSERT INTO public.fire_feed_areas (label, state) VALUES ('Nowhere', 'NJ')`),
    /check constraint/,
    "an area needs a town or a county to search for",
  );
  await refuses(
    as(
      admin,
      `INSERT INTO public.fire_feed_sources (kind, label) VALUES ('google_news', 'Second')`,
    ),
    /duplicate key/,
    "one Google News row",
  );

  /* ---- 8: the kick ------------------------------------------------------------- */
  const calls = async () => n(`SELECT count(*) AS n FROM net.calls`);
  await db.exec(`SELECT public.fire_feed_kick()`);
  check((await calls()) === 0, "switched off: no request");
  await db.exec(
    `UPDATE public.app_settings SET value = '{"enabled": true}' WHERE key = 'fire_feed'`,
  );
  await db.exec(`SELECT public.fire_feed_kick()`);
  check((await calls()) === 1, "on, an area active, Google News never fetched: one request");
  const call = await one(`SELECT * FROM net.calls`);
  check(call.headers["x-cron-secret"] === "test-cron-secret", "carrying the cron secret");
  check(/\/api\/public\/hooks\/fire-feed$/.test(call.url), "to the fire-feed hook");
  check(call.timeout_milliseconds === 60000, "with a minute to finish");

  await db.exec(
    `UPDATE public.fire_feed_sources SET last_fetched_at = now() WHERE kind = 'google_news'`,
  );
  await db.exec(`SELECT public.fire_feed_kick()`);
  check((await calls()) === 1, "nothing due: no request");
  await db.exec(
    `UPDATE public.fire_feed_sources SET last_fetched_at = now() - interval '20 minutes' WHERE kind = 'google_news'`,
  );
  await db.exec(
    `INSERT INTO public.fire_feed_runs (status, started_at) VALUES ('running', now() - interval '1 minute')`,
  );
  await db.exec(`SELECT public.fire_feed_kick()`);
  check((await calls()) === 1, "a run still in flight: no second request");
  await db.exec(`UPDATE public.fire_feed_runs SET status = 'failed' WHERE status = 'running'`);
  await db.exec(`UPDATE public.fire_feed_areas SET active = false`);
  await db.exec(`SELECT public.fire_feed_kick()`);
  check((await calls()) === 1, "no active area: no request");
  await db.exec(`UPDATE public.fire_feed_areas SET active = true WHERE locality = 'Lakewood'`);
  await db.exec(
    `UPDATE public.app_settings SET value = '{"enabled": true, "hook_url": "https://staging.example/api/public/hooks/fire-feed"}' WHERE key = 'fire_feed'`,
  );
  await db.exec(`SELECT public.fire_feed_kick()`);
  check(
    (await one(`SELECT url FROM net.calls ORDER BY ctid DESC LIMIT 1`)).url ===
      "https://staging.example/api/public/hooks/fire-feed",
    "the hook URL can be pointed elsewhere from app_settings, like the other kicks",
  );
  await refuses(
    as(admin, `SELECT public.fire_feed_kick()`),
    /permission denied/,
    "an admin cannot call the kick",
  );
  await refuses(
    as(null, `SELECT public.fire_feed_kick()`, "anon"),
    /permission denied/,
    "anon cannot call the kick",
  );

  /* ---- 9: grants ----------------------------------------------------------------- */
  const grants = (
    await db.query(
      `SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants
        WHERE table_name LIKE 'fire_feed_%' AND grantee IN ('anon', 'PUBLIC', 'portal_customer')`,
    )
  ).rows;
  check(grants.length === 0, "no anon, PUBLIC or portal grant on any fire feed table");
  const fnGrants = (
    await db.query(
      `SELECT grantee FROM information_schema.role_routine_grants
        WHERE routine_name IN ('fire_feed_kick', 'fire_feed_stamp') AND grantee IN ('anon', 'PUBLIC', 'authenticated')`,
    )
  ).rows;
  check(
    fnGrants.length === 0,
    "the kick and the stamp are not executable by anon, PUBLIC or authenticated",
  );

  console.log(`fire-feed.pglite: ${assertions} assertions passed`);
} finally {
  await db.close();
}
