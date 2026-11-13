// Run with: node supabase/tests/scorecard-action-counts.pglite.mjs <PGlite dist/index.js>
// In-memory fixtures only. No connection string, network access or live writes.
//
// REGRESSION TEST for `scorecard_action_counts` (migration 20260916140000),
// the SQL allowlist behind the scorecard admin screen's action catalogue.
//
// What it proves, against the real migration file:
//   1. the client only ever passes keys — an unknown key (even one that looks
//      like SQL) returns nothing and raises nothing;
//   2. audience is judged at the moment of the touch: a call to an account
//      before it became a client is cold, a call after is a client reach-out;
//   3. house accounts never count toward a rep, on any key;
//   4. currency is NULL, not 0, for a viewer who may not see money;
//   5. the caller sees only people in locations `can_view_location` allows.
//
// The whole migration is executed as-is. The access helpers it calls
// (is_privileged, has_role, can_view_location, list_business_reps, auth.uid)
// are stubbed over small tables here; account_is_house_account is loaded from
// its own migration so the house-account rule under test is the real one.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
const read = (name) => readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8");

let assertions = 0;
const check = (value, what) => {
  assert.equal(value, true, what);
  assertions++;
};
const eq = (actual, expected, what) => {
  assert.equal(actual, expected, `${what} (got ${actual}, wanted ${expected})`);
  assertions++;
};

/** Pull one function body out of a migration so nothing is retyped. */
function functionFrom(file, signature) {
  const sql = read(file);
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${signature}`);
  assert.notEqual(start, -1, `${signature} not found in ${file}`);
  const end = sql.indexOf("$$;", start);
  assert.notEqual(end, -1, `end of ${signature} not found in ${file}`);
  return sql.slice(start, end + 3);
}

const HOUSE_ACCOUNT_FN = functionFrom(
  "20260912103000_house_accounts_do_not_count_toward_a_rep.sql",
  "public.account_is_house_account(_account_id uuid)",
);

const REP_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REP_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MANAGER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OWNER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const LOC_1 = "11111111-1111-4111-8111-111111111111";
const LOC_2 = "22222222-2222-4222-8222-222222222222";
const PROSPECT = "01010101-0101-4101-8101-010101010101";
const CLIENT = "02020202-0202-4202-8202-020202020202";
const HOUSE = "03030303-0303-4303-8303-030303030303";
const CONVERTED = "04040404-0404-4404-8404-040404040404";
const HOUSE_TAG = "05050505-0505-4505-8505-050505050505";

try {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT NULLIF(current_setting('test.uid', true), '')::uuid
    $$;

    CREATE TYPE public.app_role AS ENUM
      ('admin','office','field','regional','owner','location_manager','sales_manager','sales_rep',
       'field_chaser','crew','dev','sales_person','cold_caller','outside_sales_rep','sales_head');
    CREATE TYPE public.comm_direction AS ENUM ('outbound','inbound','not_applicable');
    CREATE TYPE public.touchpoint_type AS ENUM
      ('call','email','meeting_in_person','meeting_virtual','gift','seasonal_send','other','text','linkedin','mail');
    CREATE TYPE public.contact_channel AS ENUM ('call','sms','email','door','other');
    CREATE TYPE public.account_status AS ENUM ('prospect','active','onboarding','inactive');
    CREATE TYPE public.task_status AS ENUM ('open','in_progress','done','cancelled');

    /* ---- access stubs, over small tables --------------------------------- */
    CREATE TABLE public.user_roles (user_id uuid, role public.app_role);
    CREATE TABLE public.location_members (user_id uuid, location_id uuid);
    CREATE TABLE public.profiles (user_id uuid PRIMARY KEY, full_name text, email text);

    CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean
      LANGUAGE sql STABLE AS $$
      SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;
    CREATE FUNCTION public.is_privileged(_user_id uuid) RETURNS boolean
      LANGUAGE sql STABLE AS $$
      SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role IN ('owner','admin','dev')) $$;
    CREATE FUNCTION public.can_view_location(_user_id uuid, _location_id uuid) RETURNS boolean
      LANGUAGE sql STABLE AS $$
      SELECT public.is_privileged(_user_id)
          OR EXISTS (SELECT 1 FROM public.location_members WHERE user_id = _user_id AND location_id = _location_id) $$;
    CREATE FUNCTION public.list_business_reps()
      RETURNS TABLE(user_id uuid, full_name text, email text, roles public.app_role[])
      LANGUAGE sql STABLE AS $$
      SELECT p.user_id, p.full_name, p.email,
             COALESCE((SELECT array_agg(ur.role) FROM public.user_roles ur WHERE ur.user_id = p.user_id), ARRAY[]::public.app_role[])
        FROM public.profiles p $$;

    /* ---- the tables the allowlist reads ---------------------------------- */
    CREATE TABLE public.tags (id uuid PRIMARY KEY, name text);
    CREATE TABLE public.account_tags (account_id uuid, tag_id uuid);
    CREATE TABLE public.accounts (
      id uuid PRIMARY KEY, name text, assigned_rep uuid, created_by uuid,
      created_at timestamptz DEFAULT now(), client_since date, stage text, status public.account_status,
      health_stage_id uuid, health_changed_at timestamptz, stage_changed_at timestamptz DEFAULT now()
    );
    CREATE TABLE public.touchpoints (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, created_by uuid,
      type public.touchpoint_type NOT NULL, direction public.comm_direction NOT NULL DEFAULT 'outbound',
      occurred_at timestamptz NOT NULL, replied_at timestamptz, meeting_held boolean, lat double precision
    );
    CREATE TABLE public.contact_attempts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), lead_id uuid, account_id uuid, author_id uuid,
      channel public.contact_channel NOT NULL, occurred_at timestamptz NOT NULL
    );
    CREATE TABLE public.account_stage_history (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, changed_by uuid,
      changed_at timestamptz NOT NULL DEFAULT now(), from_stage text, to_stage text NOT NULL
    );
    CREATE TABLE public.incidents (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid, accepted_by uuid,
      accepted_at timestamptz, arrived_at timestamptz
    );
    CREATE TABLE public.incident_attempts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), incident_id uuid, chaser_id uuid, attended_at timestamptz
    );
    CREATE TABLE public.jobs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid);
    CREATE TABLE public.invoices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid, job_id uuid, created_by uuid, sent_at timestamptz
    );
    CREATE TABLE public.invoice_payments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), invoice_id uuid, amount numeric, received_at timestamptz
    );
    CREATE TABLE public.tasks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), assignee uuid, account_id uuid,
      status public.task_status, completed_at timestamptz, due_date date
    );
    CREATE TABLE public.documents (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_by uuid, account_id uuid, storage_path text,
      created_at timestamptz DEFAULT now(), sent_at timestamptz, signed_at timestamptz
    );
    CREATE TABLE public.calendar_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_by uuid, account_id uuid,
      is_cancelled boolean DEFAULT false, starts_at timestamptz
    );
    CREATE TABLE public.account_notes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid, created_by uuid, created_at timestamptz DEFAULT now());
    CREATE TABLE public.job_notes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), author_id uuid, created_at timestamptz DEFAULT now());
    CREATE TABLE public.lead_notes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), author_id uuid, created_at timestamptz DEFAULT now());

    /* ---- the weights tables the policy change touches --------------------- */
    CREATE TABLE public.scorecard_weights (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid, role_group text, component text,
      weight numeric, target numeric, direction text, enabled boolean DEFAULT true
    );
    ALTER TABLE public.scorecard_weights ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "Owners and admins manage scorecard weights" ON public.scorecard_weights FOR ALL TO authenticated
      USING (public.is_privileged(auth.uid())) WITH CHECK (public.is_privileged(auth.uid()));
    CREATE TABLE public.scorecard_settings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid, min_activity_events integer
    );
    ALTER TABLE public.scorecard_settings ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "Owners and admins manage scorecard settings" ON public.scorecard_settings FOR ALL TO authenticated
      USING (public.is_privileged(auth.uid())) WITH CHECK (public.is_privileged(auth.uid()));

    /* ---- a stand-in for leaderboard_standings, for the delegating branch --- */
    CREATE FUNCTION public.leaderboard_standings(_from timestamptz, _to timestamptz, _location_ids uuid[] DEFAULT NULL)
      RETURNS TABLE(user_id uuid, touchpoints integer, calls_made integer, activity_events integer, meetings_held integer,
                    accounts_advanced integer, stage_advances integer, cadence_health numeric, new_accounts integer,
                    accounts_owned integer, jobs_won integer, jobs_signed_total integer, jobs_signed_insurance integer,
                    jobs_signed_cash integer, billed_value numeric, collected_value numeric, incidents_dispatched integer,
                    incidents_accepted integer, contracts_signed integer, chase_acceptance numeric, median_tta_minutes numeric)
      LANGUAGE sql STABLE AS $$
      SELECT p.user_id,
             (SELECT count(*) FROM public.touchpoints t WHERE t.created_by = p.user_id AND t.occurred_at >= _from AND t.occurred_at < _to)::int,
             0, 0, 0, 0, 0, NULL::numeric, 0, 0, 0, 0, 0, 0, NULL::numeric, NULL::numeric, 0, 0, 0, NULL::numeric, NULL::numeric
        FROM public.profiles p $$;
  `);

  await db.exec(HOUSE_ACCOUNT_FN);
  await db.exec(read("20260916140000_scorecard_action_catalogue.sql"));

  /* ---- people and offices --------------------------------------------- */
  await db.exec(`
    INSERT INTO public.profiles VALUES
      ('${REP_A}', 'Rep A', 'a@x'), ('${REP_B}', 'Rep B', 'b@x');
    INSERT INTO public.user_roles VALUES
      ('${REP_A}', 'sales_person'), ('${REP_B}', 'sales_person'),
      ('${MANAGER}', 'location_manager'), ('${OWNER}', 'owner');
    INSERT INTO public.location_members VALUES
      ('${REP_A}', '${LOC_1}'), ('${REP_B}', '${LOC_2}'), ('${MANAGER}', '${LOC_1}');

    INSERT INTO public.tags VALUES ('${HOUSE_TAG}', 'House Account');
    INSERT INTO public.accounts (id, name, assigned_rep, created_by, created_at, client_since, stage, status) VALUES
      ('${PROSPECT}',  'Prospect',   '${REP_A}', '${REP_A}', now() - interval '3 days', NULL, 'active_outreach', 'prospect'),
      ('${CLIENT}',    'Old client', '${REP_A}', '${REP_A}', now() - interval '400 days', (now() - interval '100 days')::date, 'active_client', 'active'),
      ('${HOUSE}',     'HQ house',   '${REP_A}', '${REP_A}', now() - interval '3 days', NULL, 'active_client', 'active'),
      ('${CONVERTED}', 'Converted',  '${REP_A}', '${REP_A}', now() - interval '40 days', NULL, 'active_client', 'active');
    INSERT INTO public.account_tags VALUES ('${HOUSE}', '${HOUSE_TAG}');

    -- CONVERTED: worked cold from day -20, signed on day -5, both by Rep A.
    INSERT INTO public.account_stage_history (account_id, changed_by, changed_at, from_stage, to_stage) VALUES
      ('${CONVERTED}', '${REP_A}', now() - interval '20 days', 'ready', 'active_outreach'),
      ('${CONVERTED}', '${REP_A}', now() - interval '5 days', 'conversation_established', 'active_client'),
      -- the house account was activated too; it must not count
      ('${HOUSE}',     '${REP_A}', now() - interval '4 days', 'active_outreach', 'active_client'),
      -- Rep A picked a lead out of the pool
      ('${PROSPECT}',  '${REP_A}', now() - interval '6 days', 'leads', 'ready');
  `);

  /* ---- Rep A's outreach ----------------------------------------------- */
  const touch = (account, type, daysAgo, opts = {}) =>
    db.query(
      `INSERT INTO public.touchpoints (account_id, created_by, type, occurred_at, direction, meeting_held, lat)
       VALUES ('${account}', '${REP_A}', '${type}', now() - interval '${daysAgo} days', $1, $2, $3)`,
      [opts.direction ?? "outbound", opts.held ?? null, opts.lat ?? null],
    );
  await touch(PROSPECT, "call", 3); // cold call
  await touch(PROSPECT, "email", 3); // cold email
  await touch(CLIENT, "call", 2); // active-client call
  await touch(HOUSE, "call", 2); // house account: never counts
  await touch(CONVERTED, "call", 10); // before it signed: cold
  await touch(CONVERTED, "call", 2); // after it signed: client
  await touch(PROSPECT, "call", 1, { direction: "inbound" }); // inbound: not a reach-out
  await touch(PROSPECT, "meeting_in_person", 2, { held: false }); // cancelled: not a meeting
  await touch(PROSPECT, "meeting_in_person", 4, { lat: 40.7 }); // a visit that happened
  await touch(PROSPECT, "call", 60); // outside the window
  await db.query(
    `UPDATE public.touchpoints SET replied_at = now() - interval '1 day'
      WHERE account_id = '${PROSPECT}' AND type = 'email'`,
  );
  // Fire-lead attempts: one call with no account (chase work), one door knock.
  await db.query(
    `INSERT INTO public.contact_attempts (lead_id, account_id, author_id, channel, occurred_at) VALUES
       (gen_random_uuid(), NULL, '${REP_A}', 'call', now() - interval '2 days'),
       (gen_random_uuid(), NULL, '${REP_A}', 'door', now() - interval '2 days'),
       (gen_random_uuid(), '${HOUSE}', '${REP_A}', 'door', now() - interval '2 days')`,
  );
  // Rep B, in the other office, is busy too.
  await db.query(
    `INSERT INTO public.touchpoints (account_id, created_by, type, occurred_at)
     VALUES ('${PROSPECT}', '${REP_B}', 'call', now() - interval '2 days')`,
  );
  // Money: two payments on the old client's invoice, one on the house account's.
  await db.exec(
    `INSERT INTO public.invoices (id, account_id, created_by, sent_at) VALUES
       ('06060606-0606-4606-8606-060606060606', '${CLIENT}', '${REP_A}', now() - interval '3 days'),
       ('07070707-0707-4707-8707-070707070707', '${HOUSE}',  '${REP_A}', now() - interval '3 days');
     INSERT INTO public.invoice_payments (invoice_id, amount, received_at) VALUES
       ('06060606-0606-4606-8606-060606060606', 1000, now() - interval '2 days'),
       ('06060606-0606-4606-8606-060606060606', 250,  now() - interval '1 day'),
       ('07070707-0707-4707-8707-070707070707', 9999, now() - interval '1 day')`,
  );
  await db.query(
    `INSERT INTO public.tasks (assignee, status, completed_at, due_date) VALUES
       ('${REP_A}', 'done', now() - interval '2 days', (now() - interval '1 day')::date),
       ('${REP_A}', 'done', now() - interval '2 days', (now() - interval '3 days')::date),
       ('${REP_A}', 'open', NULL, NULL)`,
  );

  const counts = async (uid, keys) => {
    await db.query(`SELECT set_config('test.uid', '${uid}', false)`);
    const r = await db.query(
      `SELECT user_id, key, value FROM public.scorecard_action_counts(
         now() - interval '30 days', now() + interval '1 day', $1::text[], NULL)`,
      [keys],
    );
    const out = {};
    for (const row of r.rows)
      (out[row.user_id] ??= {})[row.key] = row.value == null ? null : Number(row.value);
    return out;
  };

  /* ---- 1. keys only; unknown keys are ignored, not raised -------------- */
  let r = await counts(MANAGER, [
    "cold_calls",
    "drop table accounts",
    "'; select 1; --",
    "no_such_key",
  ]);
  eq(Object.keys(r[REP_A]).join(","), "cold_calls", "only the recognised key comes back");
  check(!(REP_B in r), "a manager of office 1 does not see the rep in office 2");

  /* ---- 2. audience at the moment of the touch -------------------------- */
  r = await counts(MANAGER, [
    "cold_calls",
    "active_client_calls",
    "cold_emails",
    "active_client_reach_outs",
    "prospect_reach_outs",
    "inbound_contacts",
    "replies_received",
  ]);
  const a = r[REP_A];
  eq(a.cold_calls, 2, "cold calls: the prospect, and the converted account before it signed");
  eq(
    a.active_client_calls,
    2,
    "client calls: the old client, and the converted account after it signed",
  );
  eq(a.cold_emails, 1, "one cold email");
  eq(a.active_client_reach_outs, 2, "client reach-outs of any type: the two client calls");
  eq(
    a.prospect_reach_outs,
    4,
    "prospect reach-outs: cold call, cold email, pre-signing call, the visit",
  );
  eq(a.inbound_contacts, 1, "the inbound call is counted as inbound, not as outreach");
  eq(a.replies_received, 1, "the email got a reply");

  /* ---- 3. house accounts never count ----------------------------------- */
  r = await counts(MANAGER, [
    "moved_to_active_client",
    "cold_leads_converted",
    "moved_to_active_outreach",
    "leads_claimed",
    "door_knocks",
    "lead_contact_attempts",
    "invoices_sent",
    "payments_received",
  ]);
  eq(r[REP_A].moved_to_active_client, 1, "activating the house account is not credited");
  eq(r[REP_A].cold_leads_converted, 1, "the converted account passed through Active Outreach");
  eq(r[REP_A].moved_to_active_outreach, 1, "one move into Active Outreach");
  eq(r[REP_A].leads_claimed, 1, "one lead picked out of the pool");
  eq(
    r[REP_A].door_knocks,
    1,
    "the door knock on a lead counts; the one on the house account does not",
  );
  eq(r[REP_A].lead_contact_attempts, 2, "attempts with no account count as chase work");
  eq(r[REP_A].invoices_sent, 1, "the house account's invoice is not the rep's");
  eq(
    r[REP_A].payments_received,
    2,
    "two payments on the client's invoice; the house payment is not counted",
  );

  /* ---- 4. meetings, visits, tasks -------------------------------------- */
  r = await counts(MANAGER, [
    "meetings_in_person",
    "visits_logged",
    "tasks_completed",
    "tasks_completed_on_time",
    "new_deals_worked",
  ]);
  eq(r[REP_A].meetings_in_person, 1, "a cancelled calendar meeting is not a meeting");
  eq(r[REP_A].visits_logged, 1, "one touchpoint with a location");
  eq(r[REP_A].tasks_completed, 2, "two tasks done");
  eq(r[REP_A].tasks_completed_on_time, 1, "one of them before its due date");
  eq(
    r[REP_A].new_deals_worked,
    1,
    "the converted account: first touched at day 10, still a prospect then; the prospect was first touched at day 60",
  );

  /* ---- 5. money is NULL unless the caller may see it ------------------- */
  r = await counts(MANAGER, ["payments_collected"]);
  eq(r[REP_A].payments_collected, 1250, "a location manager sees money");
  await db.query(`DELETE FROM public.user_roles WHERE user_id = '${MANAGER}'`);
  await db.query(`INSERT INTO public.user_roles VALUES ('${MANAGER}', 'sales_person')`);
  r = await counts(MANAGER, ["payments_collected", "cold_calls"]);
  check(r[REP_A].payments_collected === null, "a peer gets NULL for money, not zero");
  eq(r[REP_A].cold_calls, 2, "...but still gets counts");

  /* ---- 6. scope: the owner sees both offices; nobody sees without a uid - */
  r = await counts(OWNER, ["cold_calls", "touchpoints"]);
  check(REP_A in r && REP_B in r, "an owner sees reps in every office");
  eq(r[REP_B].cold_calls, 1, "Rep B's cold call is counted for Rep B");
  eq(r[REP_A].touchpoints, 9, "a standings-backed key is delegated to leaderboard_standings");
  await db.query(`SELECT set_config('test.uid', '', false)`);
  const anon = await db.query(
    `SELECT count(*)::int AS n FROM public.scorecard_action_counts(now() - interval '30 days', now(), ARRAY['cold_calls'], NULL)`,
  );
  eq(anon.rows[0].n, 0, "no session, no rows");

  /* ---- 7. the policy now admits the Sales Head -------------------------- */
  const pol = await db.query(
    `SELECT polname FROM pg_policy WHERE polrelid = 'public.scorecard_weights'::regclass`,
  );
  check(
    pol.rows.some((p) => p.polname.includes("Sales Head")),
    "the scorecard_weights write policy names the Sales Head",
  );

  console.log(`scorecard-action-counts.pglite: ${assertions} assertions passed`);
} finally {
  await db.close();
}
