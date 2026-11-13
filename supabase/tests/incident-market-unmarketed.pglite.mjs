// Run with: node supabase/tests/incident-market-unmarketed.pglite.mjs <PGlite dist/index.js>
// In-memory fixtures only. No connection string, network access or live writes.
//
// Alerts with no market can be claimed (migration 20261014150000, READ FROM
// THE FILE). Live, 14 Oct: an NYC whole-market chaser could not accept the
// Rockland fire-feed alert at 29 Calvert Dr, Viola — the incident has no
// market, and incident_market_allowed refused every chaser with a territory.
//
// The real claim_incident, incident_rule and incident_active_responders are
// READ FROM 20260814194528 (the newest claim_incident in the repo, which is
// the one live calls), and the old incident_market_allowed body is READ FROM
// 20260812145532, so the fixture first reproduces the bug and then proves the
// fix.
//
// What it proves:
//   1. before: a chaser with a market gets 'Out of market' on a market-less
//      incident (the live bug);
//   2. after: that chaser can claim a market-less incident;
//   3. that chaser still cannot claim another market's incident;
//   4. that chaser can still claim their own market's incident;
//   5. a user with no territory claims everything, as before;
//   6. incident_market_allowed for every (territory, incident market) pair;
//   7. the function keeps STABLE, SECURITY DEFINER, PARALLEL SAFE, the
//      search_path and the authenticated grant, and the migration re-runs.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
const read = (name) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");

const migration = read("20261014150000_incident_market_allows_unmarketed.sql");
const marketWall = read("20260812145532_6fc958ba-d0cf-42cc-b387-8a186d381c7a.sql");
const rules = read("20260814194528_995c791e-3585-4723-9224-e1dc89481f72.sql");

/** One CREATE FUNCTION statement, header through its closing `$$;`. */
const fn = (src, header) => {
  const start = src.indexOf(header);
  assert.ok(start >= 0, `${header} not found`);
  const end = src.indexOf("\n$$;", start);
  assert.ok(end > start, `${header} has no closing $$;`);
  return src.slice(start, end + 4);
};

let assertions = 0;
const check = (value, what) => {
  assert.equal(value, true, what);
  assertions++;
};

const NYC = "a0000000-0000-4000-8000-000000000001";
const LA = "a0000000-0000-4000-8000-000000000002";
const NYC_CHASER = "c0000000-0000-4000-8000-000000000001";
const NO_TERRITORY = "c0000000-0000-4000-8000-000000000002";

let seq = 0;
const newIncident = async (marketId) => {
  seq++;
  const id = `10000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
  await db.query(`INSERT INTO public.incidents (id, market_id) VALUES ($1, $2)`, [id, marketId]);
  return id;
};

/** Call claim_incident as `uid`. Returns { claimed } or { error }. */
const claimAs = async (uid, incidentId) => {
  await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [uid]);
  try {
    const r = await db.query(`SELECT public.claim_incident($1) AS r`, [incidentId]);
    return { claimed: r.rows[0].r.claimed };
  } catch (e) {
    return { error: e.message };
  }
};

try {
  await db.exec(`
    CREATE ROLE authenticated NOLOGIN;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;

    CREATE TABLE public.markets (id uuid PRIMARY KEY, name text);
    INSERT INTO public.markets VALUES ('${NYC}', 'New York City'), ('${LA}', 'Los Angeles');

    CREATE TABLE public.chaser_territories (user_id uuid PRIMARY KEY, market_id uuid NOT NULL);
    INSERT INTO public.chaser_territories VALUES ('${NYC_CHASER}', '${NYC}');

    CREATE TABLE public.profiles (user_id uuid PRIMARY KEY, full_name text);

    CREATE TABLE public.incidents (
      id uuid PRIMARY KEY,
      market_id uuid,
      zone_id uuid,
      status text NOT NULL DEFAULT 'new',
      lifecycle text NOT NULL DEFAULT 'live',
      accepted_by uuid,
      accepted_at timestamptz,
      locked_by uuid,
      locked_at timestamptz,
      needs_backup boolean NOT NULL DEFAULT false,
      claim_expires_at timestamptz,
      eta_at timestamptz,
      exposure_group_id uuid,
      dedupe_key text,
      escalation_tier smallint,
      severity_key text,
      units_dispatched integer,
      alarm_level text,
      building_type text
    );

    CREATE TABLE public.incident_dispatches (
      incident_id uuid NOT NULL,
      user_id uuid NOT NULL,
      tier smallint NOT NULL,
      responded_at timestamptz,
      response text NOT NULL DEFAULT 'pending',
      released_at timestamptz,
      release_reason text,
      UNIQUE (incident_id, user_id)
    );

    CREATE TABLE public.incident_events (
      incident_id uuid, event_type text, actor_id uuid, payload jsonb
    );

    CREATE TABLE public.chase_assignment_rules (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      key text NOT NULL UNIQUE,
      label text NOT NULL,
      description text,
      max_responders integer NOT NULL DEFAULT 1,
      zone_exclusive boolean NOT NULL DEFAULT false,
      arrival_timeout_minutes integer NOT NULL DEFAULT 45,
      sort_order integer NOT NULL DEFAULT 0,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO public.chase_assignment_rules (key, label, max_responders, zone_exclusive)
    VALUES ('single_family', 'Single family', 1, true);
  `);

  // The old market wall, exactly as the repo (and live) define it.
  await db.exec(
    fn(marketWall, "CREATE OR REPLACE FUNCTION public.incident_market_allowed(") +
      "\nALTER FUNCTION public.incident_market_allowed(uuid, uuid) PARALLEL SAFE;" +
      "\nGRANT EXECUTE ON FUNCTION public.incident_market_allowed(uuid, uuid) TO authenticated;",
  );
  await db.exec(fn(rules, "CREATE OR REPLACE FUNCTION public.incident_rule("));
  await db.exec(fn(rules, "CREATE OR REPLACE FUNCTION public.incident_active_responders("));
  await db.exec(fn(rules, "CREATE OR REPLACE FUNCTION public.claim_incident("));

  // 1. The bug.
  const before = await claimAs(NYC_CHASER, await newIncident(null));
  check(
    /Out of market/.test(before.error ?? ""),
    `before the fix a market chaser is refused a market-less alert (${JSON.stringify(before)})`,
  );

  await db.exec(migration);
  await db.exec(migration);

  // 2–5. Claims after the fix.
  const unmarketed = await claimAs(NYC_CHASER, await newIncident(null));
  check(
    unmarketed.claimed === true,
    `a market chaser claims a market-less alert (${JSON.stringify(unmarketed)})`,
  );

  const otherMarket = await claimAs(NYC_CHASER, await newIncident(LA));
  check(
    /Out of market/.test(otherMarket.error ?? ""),
    `a market chaser is still refused another market's alert (${JSON.stringify(otherMarket)})`,
  );

  const ownMarket = await claimAs(NYC_CHASER, await newIncident(NYC));
  check(ownMarket.claimed === true, "a market chaser still claims their own market's alert");

  for (const m of [null, NYC, LA]) {
    const r = await claimAs(NO_TERRITORY, await newIncident(m));
    check(r.claimed === true, `no territory claims a ${m ?? "market-less"} alert, as before`);
  }

  const claimedRow = (
    await db.query(
      `SELECT accepted_by, status FROM public.incidents WHERE accepted_by = $1 AND market_id IS NULL`,
      [NYC_CHASER],
    )
  ).rows;
  check(
    claimedRow.length === 1 && claimedRow[0].status === "accepted",
    "the market-less claim really lands on the incident",
  );

  // 6. The truth table.
  const allowed = async (uid, m) =>
    (await db.query(`SELECT public.incident_market_allowed($1, $2) AS ok`, [uid, m])).rows[0].ok;
  check((await allowed(NYC_CHASER, null)) === true, "territory + no market -> allowed");
  check((await allowed(NYC_CHASER, NYC)) === true, "territory + own market -> allowed");
  check((await allowed(NYC_CHASER, LA)) === false, "territory + other market -> refused");
  check((await allowed(NO_TERRITORY, null)) === true, "no territory + no market -> allowed");
  check((await allowed(NO_TERRITORY, LA)) === true, "no territory + any market -> allowed");

  // 7. Attributes and grant survive the replace.
  const meta = (
    await db.query(`SELECT provolatile, prosecdef, proparallel, proconfig, prolang
                      FROM pg_proc WHERE proname = 'incident_market_allowed'`)
  ).rows;
  check(meta.length === 1, "exactly one incident_market_allowed after two applies");
  check(meta[0].provolatile === "s", "still STABLE");
  check(meta[0].prosecdef === true, "still SECURITY DEFINER");
  check(meta[0].proparallel === "s", "still PARALLEL SAFE");
  check(
    JSON.stringify(meta[0].proconfig) === JSON.stringify(["search_path=public"]),
    "still search_path=public",
  );
  const granted = (
    await db.query(
      `SELECT has_function_privilege('authenticated', 'public.incident_market_allowed(uuid, uuid)', 'EXECUTE') AS g`,
    )
  ).rows[0].g;
  check(granted === true, "authenticated can still execute it");

  console.log(`incident-market-unmarketed.pglite: ${assertions} assertions passed`);
} finally {
  await db.close();
}
