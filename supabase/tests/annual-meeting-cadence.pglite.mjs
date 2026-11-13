// Run with: node supabase/tests/annual-meeting-cadence.pglite.mjs <PGlite dist/index.js>
// In-memory fixtures only. No connection string, network access or live writes.
//
// REGRESSION TEST for the database half of "a cancelled meeting must not
// satisfy the annual visit" (migration 20260914140000).
//
// `account_fire_rollup.last_in_person_at` was
//
//   max(tp.occurred_at) FILTER (WHERE tp.type = 'meeting_in_person')
//
// with no check of `counts_toward_cadence`. That column is set on write by
// `tg_touchpoint_cadence`, and for a meeting it is
// COALESCE(meeting_held, capture_source <> 'calendar') — so a calendar meeting
// the client CANCELLED carries false. Feeding it to the annual clock meant a
// meeting that did not happen bought another 365 days of silence.
//
// The TypeScript half is covered by src/lib/cadence-sweep.test.ts. Both halves
// ship in the same commit on purpose: fixing one alone would re-create the
// board-vs-view disagreement that phase A existed to end, which is exactly why
// phase 1 reported this rather than half-fixing it.
//
// The real trigger is loaded from its own migration so the true/false values
// under test are the ones production writes, not values typed here. The view
// body is loaded from the migration too.
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

const account = "11111111-1111-4111-8111-111111111111";

/** Pull one function body out of a migration so nothing is retyped. */
function functionFrom(file, signature) {
  const sql = read(file);
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${signature}`);
  assert.notEqual(start, -1, `${signature} not found in ${file}`);
  const end = sql.indexOf("$$;", start);
  assert.notEqual(end, -1, `end of ${signature} not found in ${file}`);
  return sql.slice(start, end + 3);
}

const CADENCE_TRIGGER = functionFrom(
  "20260806171901_6742642f-ed06-448f-8d1c-ee267525e6ae.sql",
  "public.tg_touchpoint_cadence()",
);

try {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

    CREATE TYPE public.capture_source AS ENUM
      ('dialer','mailbox','calendar','sms','voice_note','manual','gift_engine');
    CREATE TYPE public.comm_direction AS ENUM ('outbound','inbound','not_applicable');
    CREATE TYPE public.touchpoint_type AS ENUM
      ('call','email','text','meeting_in_person','meeting_virtual','linkedin','mail','gift','seasonal_send','other');
    CREATE TYPE public.lead_status AS ENUM ('open','closed');

    CREATE TABLE public.accounts (
      id uuid PRIMARY KEY, name text, status text, stage text, stage_id uuid,
      pipeline_id uuid, priority text, estimated_annual_value numeric,
      account_type text, location_id uuid, assigned_rep uuid, notes text,
      updated_at timestamptz DEFAULT now(), approval_state text, approval_due_on date
    );
    INSERT INTO public.accounts (id, name) VALUES ('${account}', 'Brooklyn Realty 3');

    CREATE TABLE public.fire_leads (
      account_id uuid, status public.lead_status, rescind_date date,
      incident_date date, units_vacated bigint, owner_mailing_address text
    );
    CREATE TABLE public.contacts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid,
      full_name text, email text, phone text, is_primary boolean DEFAULT false,
      created_at timestamptz DEFAULT now()
    );

    CREATE TABLE public.touchpoints (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id uuid NOT NULL,
      type public.touchpoint_type NOT NULL,
      occurred_at timestamptz NOT NULL,
      capture_source public.capture_source NOT NULL DEFAULT 'manual',
      direction public.comm_direction NOT NULL DEFAULT 'not_applicable',
      is_self_reported boolean NOT NULL DEFAULT true,
      duration_seconds integer,
      replied_at timestamptz,
      meeting_held boolean,
      counts_toward_cadence boolean NOT NULL DEFAULT false
    );
  `);

  // The real trigger, so counts_toward_cadence is derived exactly as it is live.
  await db.exec(CADENCE_TRIGGER);
  await db.exec(`
    DROP TRIGGER IF EXISTS trg_touchpoint_cadence ON public.touchpoints;
    CREATE TRIGGER trg_touchpoint_cadence BEFORE INSERT OR UPDATE ON public.touchpoints
      FOR EACH ROW EXECUTE FUNCTION public.tg_touchpoint_cadence();
  `);

  const meeting = async (when, held, source = "calendar") =>
    db.query(
      `INSERT INTO public.touchpoints (account_id, type, occurred_at, capture_source, meeting_held)
       VALUES ('${account}', 'meeting_in_person', now() - interval '${when}', '${source}', ${held})`,
    );

  /* ---- the trigger's own behaviour, so the premise is not assumed ----- */
  await meeting("400 days", "true");
  await meeting("10 days", "false");
  const flags = (
    await db.query(
      `SELECT meeting_held, counts_toward_cadence FROM public.touchpoints ORDER BY occurred_at`,
    )
  ).rows;
  check(flags[0].counts_toward_cadence === true, "a meeting that was held counts toward cadence");
  check(
    flags[1].counts_toward_cadence === false,
    "a calendar meeting marked NOT held does not — this is the row that caused the bug",
  );

  /* ---- PHASE 1: the view before the fix ------------------------------ */
  await db.exec(`
    CREATE VIEW public.account_fire_rollup AS
    SELECT a.id AS account_id, a.name, t.last_touch_at, t.last_in_person_at,
           COALESCE(t.touch_count, 0::bigint) AS touch_count
      FROM public.accounts a
      LEFT JOIN LATERAL ( SELECT max(tp.occurred_at) AS last_touch_at,
             max(tp.occurred_at) FILTER (WHERE tp.type = 'meeting_in_person'::public.touchpoint_type) AS last_in_person_at,
             count(*) AS touch_count
            FROM public.touchpoints tp
           WHERE tp.account_id = a.id) t ON true;
  `);

  const lastInPerson = async () =>
    (
      await db.query(
        `SELECT last_in_person_at FROM public.account_fire_rollup WHERE account_id = '${account}'`,
      )
    ).rows[0].last_in_person_at;
  const daysSinceMeeting = async () =>
    Number(
      (
        await db.query(
          `SELECT EXTRACT(day FROM now() - last_in_person_at)::int AS d
             FROM public.account_fire_rollup WHERE account_id = '${account}'`,
        )
      ).rows[0].d,
    );

  check(
    (await daysSinceMeeting()) === 10,
    "before the fix the cancelled meeting is the last in-person visit",
  );
  check(
    (await daysSinceMeeting()) < 365,
    "so the annual clock reads as satisfied — the bug, stated as the clock sees it",
  );

  /* ---- PHASE 2: apply the migration ---------------------------------- */
  // The view body in the migration references columns this fixture does not
  // carry (fire_leads rollups, contacts), so the fixture above provides them.
  await db.exec(read("20260914140000_annual_meeting_counts_toward_cadence.sql"));

  check(
    (await daysSinceMeeting()) === 400,
    "after the fix the last REAL visit is the one 400 days ago",
  );
  check(
    (await daysSinceMeeting()) >= 365,
    "so the annual visit is correctly overdue — the cancellation no longer buys a year",
  );

  /* ---- a held meeting still satisfies it ----------------------------- */
  await meeting("5 days", "true");
  check((await daysSinceMeeting()) === 5, "a meeting that DID happen still resets the clock");

  /* ---- a manual meeting with no meeting_held flag still counts ------- */
  // COALESCE(meeting_held, capture_source <> 'calendar') — a manually logged
  // visit with nothing ticked counts, and must keep counting.
  await db.exec(`DELETE FROM public.touchpoints WHERE occurred_at > now() - interval '300 days'`);
  await db.query(
    `INSERT INTO public.touchpoints (account_id, type, occurred_at, capture_source)
     VALUES ('${account}', 'meeting_in_person', now() - interval '3 days', 'manual')`,
  );
  check((await daysSinceMeeting()) === 3, "a manually logged visit still satisfies the annual");

  /* ---- security_invoker survived the DROP/CREATE ---------------------- */
  check(
    (
      await db.query(
        `SELECT reloptions::text AS o FROM pg_class WHERE oid = 'public.account_fire_rollup'::regclass`,
      )
    ).rows[0].o.includes("security_invoker=true"),
    "the view is still security_invoker — a DROP/CREATE must not lose it",
  );

  /* ---- last_touch_at deliberately unchanged --------------------------- */
  await db.query(
    `INSERT INTO public.touchpoints (account_id, type, occurred_at, direction)
     VALUES ('${account}', 'email', now() - interval '1 day', 'outbound')`,
  );
  check(
    Number(
      (
        await db.query(
          `SELECT EXTRACT(day FROM now() - last_touch_at)::int AS d
             FROM public.account_fire_rollup WHERE account_id = '${account}'`,
        )
      ).rows[0].d,
    ) === 1,
    "last_touch_at still answers 'did anyone contact them at all' — narrowing it is not this fix",
  );
  check(
    (await lastInPerson()) !== null,
    "and the unanswered email did not become an in-person visit",
  );

  /* ---- re-runnable ---------------------------------------------------- */
  await db.exec(read("20260914140000_annual_meeting_counts_toward_cadence.sql"));
  check((await daysSinceMeeting()) === 3, "a replay changes nothing");

  console.log(`annual-meeting-cadence.pglite: ${assertions} assertions passed`);
} finally {
  await db.close();
}
