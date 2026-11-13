// Run with: node supabase/tests/fire-feed-government-sources.pglite.mjs <existing PGlite dist/index.js>
// In-memory fixtures only. No connection string, network access or live writes.
//
// The data-only migration 20261012090000 (READ FROM THE FILE), on top of the
// fire feed's own 20261011140000, against offices shaped like production's
// (CAT's placeholder point in Brooklyn, the real NJ office in Lakewood).
//
// What it proves:
//   1. five sources arrive, every one SWITCHED OFF, each pinned to its area;
//   2. Rockland carries the government confirmation, the http URL and the
//      two-minute poll; Notify NYC its English author filter; Houston its
//      table id; the Lakewood Scoop its do-not-enable note;
//   3. a second run adds nothing and does not touch an admin's change;
//   4. the Lakewood area moves off the placeholder point to the NJ office,
//      and an area an admin has already moved is left alone;
//   5. nothing else changes: no new table, policy, grant or function.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const migration = (name) => readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8");

let assertions = 0;
const check = (value, what) => {
  assert.equal(value, true, what);
  assertions++;
};

async function freshDb() {
  const db = new PGlite();
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
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE TABLE public.profiles (user_id uuid PRIMARY KEY, is_active boolean NOT NULL DEFAULT true);
    CREATE FUNCTION goldstar_private.profile_is_active(_user_id uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
      SELECT EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = _user_id AND p.is_active);
    $$;
    CREATE TABLE public.user_roles (user_id uuid, role text);
    CREATE FUNCTION public.is_privileged(_user_id uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
      $$ SELECT false $$;
    CREATE TABLE public.locations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text, name text, locality text, region text,
      lat double precision, lon double precision, active boolean NOT NULL DEFAULT true);
    CREATE TABLE public.incidents (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source text NOT NULL, external_ref text,
      reported_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE public.app_settings (key text PRIMARY KEY, value jsonb NOT NULL);
    CREATE FUNCTION net.http_post(url text, headers jsonb, body jsonb, timeout_milliseconds int DEFAULT 5000)
    RETURNS bigint LANGUAGE sql AS $$ SELECT 1::bigint $$;
    CREATE FUNCTION public.cron_secret() RETURNS text LANGUAGE sql AS $$ SELECT 'x' $$;

    -- Production's offices, as they were on 11 Oct 2026.
    INSERT INTO public.locations (code, name, locality, region, lat, lon) VALUES
      ('CAT', 'CAT', 'Lakewood', 'NJ', 40.68, -73.94),
      ('NJ', 'NJ', 'Lakewood', 'NJ', 40.102142, -74.171273),
      ('NY', 'NY', 'Brooklyn', 'NY', 40.627671, -73.942121),
      ('NY-UP', 'NY-Upstate', 'Haverstraw', 'NY', 41.197858, -73.963419),
      ('TX', 'HTX', 'Houston', 'TX', 29.653674, -95.509832),
      ('CA', 'CA', 'Los Angeles', 'CA', 33.989125, -118.275249);
  `);
  await db.exec(migration("20261011140000_fire_feed.sql"));
  return db;
}

const one = async (db, sql) => (await db.query(sql)).rows[0];
const SNAPSHOT = `
  SELECT
    (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace)::int AS rels,
    (SELECT count(*) FROM pg_policies WHERE schemaname = 'public')::int AS policies,
    (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace)::int AS fns,
    (SELECT count(*) FROM information_schema.role_table_grants WHERE table_schema = 'public')::int AS grants`;

const db = await freshDb();
try {
  const before = await one(db, SNAPSHOT);
  check(
    Number(
      (await one(db, `SELECT center_lat FROM public.fire_feed_areas WHERE locality = 'Lakewood'`))
        .center_lat,
    ) === 40.68,
    "the seed put Lakewood on CAT's placeholder point, as production has it",
  );

  await db.exec(migration("20261012090000_fire_feed_government_sources.sql"));

  /* ---- 1 ------------------------------------------------------------------ */
  const rows = (
    await db.query(`
      SELECT s.kind, s.label, s.url, s.poll_minutes, s.enabled, s.config, a.locality AS area
        FROM public.fire_feed_sources s LEFT JOIN public.fire_feed_areas a ON a.id = s.area_id
       WHERE s.kind <> 'google_news' ORDER BY s.url`)
  ).rows;
  const byUrl = Object.fromEntries(rows.map((r) => [r.url, r]));
  check(rows.length === 5, "five sources");
  check(
    rows.every((r) => r.enabled === false),
    "every one of them switched off",
  );
  const rock = byUrl["http://firewatch.44-control.net/status.json"];
  const nyc = byUrl["https://feeds.everbridge.net/feeds/453003085617722/rss/rss.xml"];
  const lafd = byUrl["https://lafd.org/alerts-rss.xml"];
  const hou = byUrl["https://cohweb.houstontx.gov/ActiveIncidents/Combined.aspx?agency=F"];
  const scoop = byUrl["https://thelakewoodscoop.com/feed/"];
  check(
    rock.area === "Haverstraw" && nyc.area === "Brooklyn" && lafd.area === "Los Angeles",
    "Rockland → Haverstraw, Notify NYC → Brooklyn, LAFD → Los Angeles",
  );
  check(
    hou.area === "Houston" && scoop.area === "Lakewood",
    "Houston → Houston, the Lakewood Scoop → Lakewood",
  );
  check(
    rock.poll_minutes === 2 &&
      nyc.poll_minutes === 5 &&
      lafd.poll_minutes === 10 &&
      hou.poll_minutes === 5,
    "2 / 5 / 10 / 5 minutes",
  );

  /* ---- 2 ------------------------------------------------------------------ */
  check(
    rock.kind === "public_page" &&
      rock.config.preset === "json" &&
      rock.config.government_ack === true,
    "Rockland: a confirmed government JSON page",
  );
  check(
    rock.config.json.items_path === "Fire" && rock.config.json.fields.time === "Time Reported",
    "Rockland: the field map",
  );
  check(rock.config.exclude_statuses === undefined, "Rockland keeps completed calls");
  check(
    nyc.kind === "rss" && nyc.config.author_filter === "NYCEM [English]",
    "Notify NYC: English copies only",
  );
  check(lafd.config.timezone === "America/Los_Angeles", "LAFD: Pacific time");
  check(
    hou.kind === "public_page" &&
      hou.config.table.id === "GridView2" &&
      hou.config.timezone === "America/Chicago",
    "Houston: #GridView2, Central time",
  );
  check(hou.config.government_ack === undefined, "Houston needs no confirmation (houstontx.gov)");
  check(/Do not enable yet/.test(scoop.config.note), "the Lakewood Scoop says why it is off");

  /* ---- 3 ------------------------------------------------------------------ */
  await db.exec(
    `UPDATE public.fire_feed_sources SET poll_minutes = 3 WHERE url LIKE 'http://firewatch%'`,
  );
  await db.exec(migration("20261012090000_fire_feed_government_sources.sql"));
  check(
    Number((await one(db, `SELECT count(*) AS n FROM public.fire_feed_sources`)).n) === 6,
    "a second run adds nothing",
  );
  check(
    (
      await one(
        db,
        `SELECT poll_minutes FROM public.fire_feed_sources WHERE url LIKE 'http://firewatch%'`,
      )
    ).poll_minutes === 3,
    "and leaves an admin's change alone",
  );

  /* ---- 4 ------------------------------------------------------------------ */
  const lkw = await one(
    db,
    `SELECT center_lat, center_lon FROM public.fire_feed_areas WHERE locality = 'Lakewood'`,
  );
  check(
    Number(lkw.center_lat) === 40.102142 && Number(lkw.center_lon) === -74.171273,
    "Lakewood moves to the NJ office",
  );

  /* ---- 5 ------------------------------------------------------------------ */
  const after = await one(db, SNAPSHOT);
  check(
    JSON.stringify(after) === JSON.stringify(before),
    "no table, policy, function or grant changed",
  );
} finally {
  await db.close();
}

// An area an admin already moved is not touched.
const db2 = await freshDb();
try {
  await db2.exec(
    `UPDATE public.fire_feed_areas SET center_lat = 40.09, center_lon = -74.2 WHERE locality = 'Lakewood'`,
  );
  await db2.exec(migration("20261012090000_fire_feed_government_sources.sql"));
  const lkw = await one(
    db2,
    `SELECT center_lat FROM public.fire_feed_areas WHERE locality = 'Lakewood'`,
  );
  check(Number(lkw.center_lat) === 40.09, "an admin's own Lakewood centre stays");
} finally {
  await db2.close();
}

console.log(`fire-feed-government-sources.pglite: ${assertions} assertions passed`);
