// Run with: node supabase/tests/goal-activity-actuals.pglite.mjs <PGlite dist/index.js>
// In-memory fixtures only. No connection string, network access or live writes.
//
// REGRESSION TEST for the six activity goal metrics Mark asked for on
// 16 Sep 2026 — "add fires chased, cold leak converted, cold calls, new deals
// worked on, active client reach out (... messaging, emails, texts, calls,
// etc), cold email outreach" — computed by `goal_activity_actuals` in
// 20260916130100 and surfaced through `leaderboard_standings` and
// `sales_director_reps`.
//
// The migrations are READ FROM THE FILES rather than retyped, so this cannot
// drift from what ships. The tables are the live shapes minus columns nothing
// here reads; the authorisation helpers the two big functions call
// (list_business_reps, can_view_location, is_privileged, has_role,
// has_permission, auth.uid) are stubbed to "yes", because what is under test
// is the counting, not the gate — the gate is the previous definition's,
// verbatim.
//
// What it proves:
//   1. a house account's touches are credited to nobody;
//   2. a touch to a prospect is never a client reach-out, and a touch to a
//      client is never a cold call or cold email — judged at the moment of
//      the touch, so a call the week before the green light stays cold;
//   3. a call logged in both touchpoints and contact_attempts counts twice,
//      exactly as the leaderboard's calls_made already counts it;
//   4. inbound mail is not outreach; a row with no account is not counted;
//   5. "new deals" means the rep's FIRST touch on the account is in the
//      window — a prospect worked last month is not new this month;
//   6. a cold lead converted is a won-stage move in the window on an account
//      that passed through Active Outreach, credited to the assigned rep;
//   7. fires chased is incidents accepted in the window;
//   8. both readers execute and carry the six columns, and the director row
//      reads the target off `goals` by metric name.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
const enumMigration = readFileSync(
  new URL("../migrations/20260916130000_goal_metric_six_activity_values.sql", import.meta.url),
  "utf8",
);
const migration = readFileSync(
  new URL("../migrations/20260916130100_goal_activity_actuals.sql", import.meta.url),
  "utf8",
);

let assertions = 0;
const check = (value, what) => {
  assert.equal(value, true, what);
  assertions++;
};
const eq = (actual, expected, what) => {
  assert.equal(actual, expected, `${what} (got ${actual}, wanted ${expected})`);
  assertions++;
};

// People
const REP = "aaaaaaaa-0000-4000-8000-000000000001"; // the rep under test
const OTHER = "aaaaaaaa-0000-4000-8000-000000000002"; // a colleague
const MANAGER = "aaaaaaaa-0000-4000-8000-000000000009"; // clicks Activate on reps' behalf
const OFFICE = "bbbbbbbb-0000-4000-8000-000000000001";
// Stages
const PIPE = "cccccccc-0000-4000-8000-000000000000";
const ST_READY = "cccccccc-0000-4000-8000-000000000001";
const ST_OUTREACH = "cccccccc-0000-4000-8000-000000000002";
const ST_CONV = "cccccccc-0000-4000-8000-000000000003";
const ST_WON = "cccccccc-0000-4000-8000-000000000004";
const HEALTHY = "cccccccc-0000-4000-8000-000000000011";
// Accounts
const P = "dddddddd-0000-4000-8000-000000000001"; // prospect in Active Outreach
const C = "dddddddd-0000-4000-8000-000000000002"; // client, green light 10 Sep, owned by OTHER
const H = "dddddddd-0000-4000-8000-000000000003"; // house account
const V = "dddddddd-0000-4000-8000-000000000004"; // converted cold lead, owned by REP
const W = "dddddddd-0000-4000-8000-000000000005"; // warm lead: never in Active Outreach
const X = "dddddddd-0000-4000-8000-000000000006"; // converted before the window
const Q = "dddddddd-0000-4000-8000-000000000007"; // prospect REP was already working in August
const TAG_HOUSE = "eeeeeeee-0000-4000-8000-000000000001";

try {
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT '${MANAGER}'::uuid $$;

    CREATE TYPE public.app_role AS ENUM (
      'owner','admin','dev','regional','location_manager','sales_head','sales_manager',
      'sales_person','sales_rep','outside_sales_rep','cold_caller','field_chaser','field','crew'
    );
    CREATE TYPE public.account_status AS ENUM ('prospect','onboarding','active','dormant','lost');
    CREATE TYPE public.touchpoint_type AS ENUM (
      'call','email','meeting_in_person','meeting_virtual','gift','seasonal_send','other','text','linkedin','mail'
    );
    CREATE TYPE public.comm_direction AS ENUM ('outbound','inbound','not_applicable');
    CREATE TYPE public.contact_channel AS ENUM ('call','sms','email','door','other');
    CREATE TYPE public.goal_metric AS ENUM (
      'meetings_held','touchpoints','accounts_advanced','new_accounts','contracts_signed',
      'jobs_won','billed_value','collected_value','median_tta_minutes','conversion_rate'
    );

    CREATE TABLE public.profiles (user_id uuid PRIMARY KEY, full_name text, email text, is_active boolean DEFAULT true);
    CREATE TABLE public.user_roles (user_id uuid, role public.app_role);
    CREATE TABLE public.location_members (user_id uuid, location_id uuid);
    CREATE TABLE public.pipeline_stages (
      id uuid PRIMARY KEY, pipeline_id uuid, key text, name text, sort_order int,
      is_won boolean DEFAULT false, is_lost boolean DEFAULT false, is_active boolean DEFAULT true
    );
    CREATE TABLE public.accounts (
      id uuid PRIMARY KEY, name text, location_id uuid, assigned_rep uuid,
      stage text, stage_id uuid, status public.account_status DEFAULT 'prospect',
      health_stage_id uuid, health_changed_at timestamptz, green_light_date date,
      stage_changed_at timestamptz DEFAULT now(), created_at timestamptz DEFAULT now(),
      archived_at timestamptz, lost_reason text
    );
    CREATE TABLE public.account_stage_history (
      id uuid DEFAULT gen_random_uuid(), account_id uuid, from_stage text, to_stage text,
      from_stage_id uuid, to_stage_id uuid, changed_by uuid, changed_at timestamptz
    );
    CREATE TABLE public.stage_auto_advances (account_id uuid, to_stage_id uuid, fired_at timestamptz);
    CREATE TABLE public.touchpoints (
      id uuid DEFAULT gen_random_uuid(), account_id uuid, created_by uuid,
      type public.touchpoint_type, direction public.comm_direction DEFAULT 'not_applicable',
      occurred_at timestamptz, meeting_held boolean
    );
    CREATE TABLE public.contact_attempts (
      id uuid DEFAULT gen_random_uuid(), lead_id uuid, account_id uuid, author_id uuid,
      channel public.contact_channel, occurred_at timestamptz
    );
    CREATE TABLE public.incidents (
      id uuid DEFAULT gen_random_uuid(), location_id uuid, reported_at timestamptz,
      accepted_by uuid, accepted_at timestamptz, arrived_at timestamptz, outcome text
    );
    CREATE TABLE public.jobs (
      id uuid DEFAULT gen_random_uuid(), account_id uuid, status text, created_at timestamptz,
      billed_amount numeric, collected_amount numeric, approved_amount numeric,
      insurance_carrier text, insurance_carrier_account_id uuid, insurance_kind text
    );
    CREATE TABLE public.tags (id uuid PRIMARY KEY, name text);
    CREATE TABLE public.account_tags (account_id uuid, tag_id uuid);
    CREATE TABLE public.goals (
      id uuid DEFAULT gen_random_uuid(), subject_user_id uuid, metric public.goal_metric,
      target_value numeric, is_active boolean DEFAULT true, starts_on date, ends_on date
    );

    -- Verbatim from 20260912103000: the house-account predicate.
    CREATE FUNCTION public.account_is_house_account(_account_id uuid)
    RETURNS boolean LANGUAGE sql STABLE SET search_path = public AS $$
      SELECT EXISTS (
        SELECT 1 FROM public.account_tags atg
          JOIN public.tags t ON t.id = atg.tag_id
         WHERE atg.account_id = _account_id AND lower(t.name) = 'house account'
      );
    $$;

    -- The gate, stubbed open. What is under test is the counting.
    CREATE FUNCTION public.list_business_reps()
    RETURNS TABLE(user_id uuid, full_name text, email text, roles public.app_role[])
    LANGUAGE sql STABLE AS $$
      SELECT p.user_id, p.full_name, p.email,
             ARRAY(SELECT r.role FROM public.user_roles r WHERE r.user_id = p.user_id)
        FROM public.profiles p
    $$;
    CREATE FUNCTION public.can_view_location(_u uuid, _l uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
    CREATE FUNCTION public.is_privileged(_u uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
    CREATE FUNCTION public.has_role(_u uuid, _r public.app_role) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
    CREATE FUNCTION public.has_permission(_u uuid, _p text) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;

    -- The functions the migration replaces must exist to be dropped, in
    -- their live signatures.
    CREATE FUNCTION public.leaderboard_standings(_from timestamptz, _to timestamptz, _location_ids uuid[] DEFAULT NULL)
    RETURNS TABLE(user_id uuid) LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
    CREATE FUNCTION public.sales_director_reps(_from date, _to date)
    RETURNS TABLE(user_id uuid) LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;

    INSERT INTO public.profiles VALUES
      ('${REP}', 'Test Sales Rep CA', 'rep@example.com', true),
      ('${OTHER}', 'Other Rep', 'other@example.com', true);
    INSERT INTO public.user_roles VALUES ('${REP}', 'sales_person'), ('${OTHER}', 'sales_person');
    INSERT INTO public.location_members VALUES ('${REP}', '${OFFICE}'), ('${OTHER}', '${OFFICE}');

    INSERT INTO public.pipeline_stages (id, pipeline_id, key, name, sort_order, is_won) VALUES
      ('${ST_READY}', '${PIPE}', 'ready', 'Ready', 10, false),
      ('${ST_OUTREACH}', '${PIPE}', 'active_outreach', 'Active Outreach', 20, false),
      ('${ST_CONV}', '${PIPE}', 'conversation_established', 'Conversation Established', 30, false),
      ('${ST_WON}', '${PIPE}', 'active_client', 'Active Client', 40, true),
      ('${HEALTHY}', '${PIPE}', 'healthy', 'Healthy', 10, false);

    INSERT INTO public.tags VALUES ('${TAG_HOUSE}', 'House Account');
  `);

  // Accounts. Only C, V and X are clients; C's green light is 10 Sep.
  await db.exec(`
    INSERT INTO public.accounts (id, name, location_id, assigned_rep, stage, stage_id, status, health_stage_id, green_light_date, created_at) VALUES
      ('${P}', 'Prospect',        '${OFFICE}', '${REP}',   'active_outreach', '${ST_OUTREACH}', 'prospect', NULL,          NULL,         '2026-08-01'),
      ('${C}', 'Client',          '${OFFICE}', '${OTHER}', 'active_client',   '${ST_WON}',      'active',   '${HEALTHY}',  '2026-09-10', '2026-07-01'),
      ('${H}', 'House',           '${OFFICE}', '${REP}',   'active_outreach', '${ST_OUTREACH}', 'prospect', NULL,          NULL,         '2026-08-01'),
      ('${V}', 'Converted cold',  '${OFFICE}', '${REP}',   'active_client',   '${ST_WON}',      'active',   '${HEALTHY}',  '2026-09-12', '2026-08-01'),
      ('${W}', 'Warm walk-in',    '${OFFICE}', '${REP}',   'active_client',   '${ST_WON}',      'active',   '${HEALTHY}',  '2026-09-14', '2026-09-01'),
      ('${X}', 'Converted in Aug','${OFFICE}', '${REP}',   'active_client',   '${ST_WON}',      'active',   '${HEALTHY}',  '2026-08-30', '2026-07-01'),
      ('${Q}', 'Old prospect',    '${OFFICE}', '${REP}',   'active_outreach', '${ST_OUTREACH}', 'prospect', NULL,          NULL,         '2026-07-01');
    INSERT INTO public.account_tags VALUES ('${H}', '${TAG_HOUSE}');

    INSERT INTO public.account_stage_history (account_id, from_stage, to_stage, from_stage_id, to_stage_id, changed_by, changed_at) VALUES
      ('${P}', 'ready', 'active_outreach', '${ST_READY}', '${ST_OUTREACH}', '${REP}',     '2026-08-20'),
      ('${C}', 'ready', 'active_outreach', '${ST_READY}', '${ST_OUTREACH}', '${OTHER}',   '2026-08-01'),
      ('${C}', 'active_outreach', 'active_client', '${ST_OUTREACH}', '${ST_WON}', '${OTHER}', '2026-09-10'),
      ('${V}', 'ready', 'active_outreach', '${ST_READY}', '${ST_OUTREACH}', '${REP}',     '2026-08-15'),
      ('${V}', 'conversation_established', 'active_client', '${ST_CONV}', '${ST_WON}', '${MANAGER}', '2026-09-12'),
      ('${W}', 'ready', 'conversation_established', '${ST_READY}', '${ST_CONV}', '${REP}', '2026-09-01'),
      ('${W}', 'conversation_established', 'active_client', '${ST_CONV}', '${ST_WON}', '${REP}', '2026-09-14'),
      ('${X}', 'ready', 'active_outreach', '${ST_READY}', '${ST_OUTREACH}', '${REP}',     '2026-08-01'),
      ('${X}', 'active_outreach', 'active_client', '${ST_OUTREACH}', '${ST_WON}', '${REP}', '2026-08-30'),
      ('${Q}', 'ready', 'active_outreach', '${ST_READY}', '${ST_OUTREACH}', '${REP}',     '2026-08-10');
  `);

  // Touches. The window under test is September 2026.
  await db.exec(`
    INSERT INTO public.touchpoints (account_id, created_by, type, direction, occurred_at) VALUES
      -- P, a prospect: a cold call, a cold email, an inbound reply, a text.
      ('${P}', '${REP}', 'call',  'outbound', '2026-09-02 10:00Z'),
      ('${P}', '${REP}', 'email', 'outbound', '2026-09-03 10:00Z'),
      ('${P}', '${REP}', 'email', 'inbound',  '2026-09-04 10:00Z'),
      ('${P}', '${REP}', 'text',  'outbound', '2026-09-05 10:00Z'),
      -- A writer that never set direction (assistant dictation) still logged a call.
      ('${P}', '${REP}', 'call',  'not_applicable', '2026-09-20 10:00Z'),
      -- C: a call BEFORE the 10 Sep green light, then client contact after it.
      ('${C}', '${REP}', 'call',  'outbound', '2026-09-05 10:00Z'),
      ('${C}', '${REP}', 'call',  'outbound', '2026-09-15 10:00Z'),
      ('${C}', '${REP}', 'email', 'outbound', '2026-09-16 10:00Z'),
      ('${C}', '${REP}', 'gift',  'outbound', '2026-09-18 10:00Z'),
      ('${C}', '${REP}', 'email', 'inbound',  '2026-09-19 10:00Z'),
      -- H, the house account: a call and an email that count for nobody.
      ('${H}', '${REP}', 'call',  'outbound', '2026-09-06 10:00Z'),
      ('${H}', '${REP}', 'email', 'outbound', '2026-09-06 11:00Z'),
      -- Q: worked in August, called again in September.
      ('${Q}', '${REP}', 'call',  'outbound', '2026-08-10 10:00Z'),
      ('${Q}', '${REP}', 'call',  'outbound', '2026-09-08 10:00Z'),
      -- The colleague's own cold call on P.
      ('${P}', '${OTHER}', 'call', 'outbound', '2026-09-09 10:00Z'),
      -- Outside the window entirely.
      ('${P}', '${REP}', 'call',  'outbound', '2026-10-02 10:00Z');

    INSERT INTO public.contact_attempts (lead_id, account_id, author_id, channel, occurred_at) VALUES
      -- The same P call, logged a second time as a contact attempt.
      (NULL, '${P}', '${REP}', 'call', '2026-09-02 10:00Z'),
      -- A text to the client.
      (NULL, '${C}', '${REP}', 'sms',  '2026-09-17 10:00Z'),
      -- A fire-lead attempt with no account.
      (gen_random_uuid(), NULL, '${REP}', 'call', '2026-09-03 10:00Z');

    INSERT INTO public.incidents (location_id, reported_at, accepted_by, accepted_at, arrived_at) VALUES
      ('${OFFICE}', '2026-09-03 08:00Z', '${REP}',   '2026-09-03 08:05Z', NULL),
      ('${OFFICE}', '2026-08-20 08:00Z', '${REP}',   '2026-08-20 08:05Z', '2026-08-20 08:40Z'),
      ('${OFFICE}', '2026-09-04 08:00Z', '${OTHER}', '2026-09-04 08:05Z', '2026-09-04 08:30Z'),
      ('${OFFICE}', '2026-09-05 08:00Z', NULL,       NULL,                NULL);
  `);

  /* ---- Apply: enum first (own transaction), then the functions --------- */
  await db.exec(enumMigration);
  await db.exec(migration);

  await db.exec(`
    INSERT INTO public.goals (subject_user_id, metric, target_value, starts_on, ends_on) VALUES
      ('${REP}', 'cold_calls', 100, '2026-09-01', '2026-09-30'),
      ('${REP}', 'fires_chased', 10, '2026-09-01', '2026-09-30');
  `);

  /* ---- The client rule ------------------------------------------------ */
  const isClient = async (id) =>
    (await db.query(`SELECT public.account_is_active_client('${id}') AS v`)).rows[0].v;
  check((await isClient(P)) === false, "a prospect in Active Outreach is not a client");
  check((await isClient(C)) === true, "an activated account with a health stage is a client");
  check((await isClient(H)) === false, "a house account in the pipeline is not a client either");
  const since = (
    await db.query(
      `SELECT to_char(public.account_client_since('${C}') AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d`,
    )
  ).rows[0].d;
  eq(since, "2026-09-10", "client-since is the stated green-light date");
  check(
    (await db.query(`SELECT public.account_client_since('${P}') IS NULL AS v`)).rows[0].v === true,
    "a prospect has no client-since",
  );

  /* ---- The six actuals ------------------------------------------------ */
  const actuals = async (from, to) => {
    const rows = (
      await db.query(
        `SELECT * FROM public.goal_activity_actuals('${from}', '${to}', ARRAY['${REP}','${OTHER}']::uuid[]) ORDER BY user_id`,
      )
    ).rows;
    return Object.fromEntries(rows.map((r) => [r.user_id, r]));
  };
  const sep = await actuals("2026-09-01", "2026-10-01");
  const rep = sep[REP];
  const other = sep[OTHER];

  // Cold calls: P (touchpoint) + P (the same call as a contact attempt) + C
  // before the green light + Q + the direction-less P call = 5. Not: the
  // house account, the inbound rows, the no-account fire lead, October.
  eq(rep.cold_calls, 5, "cold calls to prospects, both tables summed");
  eq(rep.cold_emails, 1, "one cold email — the inbound reply and the house email do not count");
  // Client reach-out: C after the green light — call, email, sms attempt,
  // gift = 4. The 5 Sep call to C was to a prospect and is not here.
  eq(
    rep.active_client_reach_outs,
    4,
    "every outbound touch of any type to a client, after it became one",
  );
  // New deals: first touch on P (2 Sep) and on C (5 Sep, then a prospect) fall
  // in September. Q was first touched in August. H is the company's.
  eq(rep.new_deals_worked, 2, "new deals are prospects first touched in the window");
  // Cold leads converted: V (Active Outreach in August, won 12 Sep by the
  // manager, owned by REP). Not W (never in Active Outreach), not X (August),
  // not C (owned by OTHER).
  eq(rep.cold_leads_converted, 1, "a cold lead converted is credited to the assigned rep");
  eq(other.cold_leads_converted, 1, "C converts for its own rep, not for whoever touched it");
  eq(rep.fires_chased, 1, "fires chased is incidents accepted in the window");
  eq(other.fires_chased, 1, "each acceptance credits its acceptor");
  eq(other.cold_calls, 1, "the colleague's call on P is theirs alone");
  eq(other.new_deals_worked, 1, "and P is a new deal for them too");
  eq(other.active_client_reach_outs, 0, "the colleague never touched a client");

  // Windows: August has Q's first touch and X's conversion, nothing on C.
  const aug = await actuals("2026-08-01", "2026-09-01");
  eq(aug[REP].new_deals_worked, 1, "Q was a new deal in August");
  eq(aug[REP].cold_leads_converted, 1, "X converted in August");
  eq(aug[REP].cold_calls, 1, "one August call, on Q");
  eq(aug[REP].fires_chased, 1, "one August acceptance");
  eq(aug[REP].active_client_reach_outs, 0, "no client contact in August");

  // A rep nobody asked about is not in the answer; an unknown one gets zeros.
  const nobody = (
    await db.query(
      `SELECT count(*)::int AS n FROM public.goal_activity_actuals('2026-09-01', '2026-10-01', ARRAY['${MANAGER}']::uuid[])`,
    )
  ).rows[0].n;
  eq(nobody, 1, "a listed user with no activity still gets a row of zeros");

  /* ---- The two readers -------------------------------------------------- */
  const lb = (
    await db.query(
      `SELECT * FROM public.leaderboard_standings('2026-09-01', '2026-10-01', NULL) WHERE user_id = '${REP}'`,
    )
  ).rows[0];
  eq(lb.cold_calls, 5, "leaderboard_standings carries cold_calls");
  eq(lb.active_client_reach_outs, 4, "and active_client_reach_outs");
  eq(
    lb.fires_chased,
    lb.incidents_accepted,
    "fires_chased is incidents_accepted under Mark's name",
  );
  // calls_made is every call the rep logged (house, client, fire lead too),
  // so it is the larger number — the two are different questions.
  eq(lb.calls_made, 8, "calls_made still counts every call, as before");

  const sd = (
    await db.query(
      `SELECT * FROM public.sales_director_reps('2026-09-01', '2026-09-30') WHERE user_id = '${REP}'`,
    )
  ).rows[0];
  eq(sd.cold_calls, 5, "sales_director_reps carries the same cold_calls");
  eq(Number(sd.cold_calls_target), 100, "and reads the cold-calls target off goals by metric name");
  eq(Number(sd.fires_chased_target), 10, "and the fires target");
  check(sd.cold_emails_target === null, "a metric with no goal has a null target, never zero");

  // The rule function is not an endpoint of its own.
  check(
    (
      await db.query(
        `SELECT has_function_privilege('authenticated', 'public.goal_activity_actuals(timestamptz, timestamptz, uuid[])', 'EXECUTE') AS v`,
      )
    ).rows[0].v === false,
    "goal_activity_actuals is not callable by authenticated directly",
  );

  // Applying twice is applying once.
  await db.exec(migration);
  const again = (await actuals("2026-09-01", "2026-10-01"))[REP];
  eq(again.cold_calls, 5, "re-applying the migration changes nothing");

  console.log(`goal-activity-actuals.pglite: ${assertions} assertions passed`);
} finally {
  await db.close();
}
