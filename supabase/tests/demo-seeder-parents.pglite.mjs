// Run with: node supabase/tests/demo-seeder-parents.pglite.mjs <PGlite dist/index.js>
// In-memory fixtures only. No connection string, network access or live writes:
// the seed functions run against throwaway tables inside PGlite, never against
// the project's database.
//
// REGRESSION TEST for the demo seeder attaching demo records to REAL data
// (found during the 15 Oct purge work, fixed in 20261016130000).
//
// The seed functions are READ FROM THE MIGRATION FILES rather than retyped, so
// this cannot drift from what ships. "Before" rebuilds the live definitions
// the same way the database did — the original files plus the in-place edits
// applied since (20260811200822, 20260821171822, 20260813174824). Tables are
// stand-ins with the columns the seeders write; enums are text domains; the
// authorisation helpers are stubbed to "yes", because what is under test is
// where the rows land, not who may press Seed.
//
// What it proves:
//   1. BEFORE the fix, seeding the way the app did (jobs, then data) made no
//      demo jobs and put demo invoices and payments on real jobs — the bug;
//   2. AFTER it, seeding the way the app now does (data, jobs, pipelines,
//      visits) makes the demo jobs and puts every invoice, payment, note,
//      task and estimate on a DEMO job, and nothing on a real one;
//   3. every demo row that points at an account, contact, estimate, invoice
//      or gift-catalog item points at a demo one;
//   4. every person a demo row is credited to (created_by, assignee, author,
//      goal owner, accepted_by) is a demo profile — a real rep assigned to a
//      demo account gets nothing, and a sample rep that is missing or not
//      demo becomes nobody;
//   5. seeding twice adds nothing and never pays an invoice twice;
//   6. the in-place patches to seed_demo_pipelines and seed_demo_extras
//      applied, and the migration can be run again.
import { readFileSync, readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const { PGlite } = await import(pathToFileURL(process.argv[2]).href);

const MIGRATIONS = new URL("../migrations/", import.meta.url);
const file = (prefix) => {
  const name = readdirSync(MIGRATIONS).find((f) => f.startsWith(prefix));
  if (!name) throw new Error(`migration ${prefix} not found`);
  return readFileSync(new URL(name, MIGRATIONS), "utf8");
};
/** The first CREATE FUNCTION in a file, up to its closing delimiter. */
const fnFrom = (src, name, delim) => {
  const start = src.indexOf(`CREATE OR REPLACE FUNCTION public.${name}()`);
  if (start < 0) throw new Error(`${name} not found`);
  const end = src.indexOf(`${delim};`, start + 1);
  return src.slice(start, end + delim.length + 1);
};

let assertions = 0;
const eq = (actual, expected, what) => {
  assert.equal(actual, expected, `${what} (got ${actual}, wanted ${expected})`);
  assertions++;
};
const check = (value, what) => {
  assert.equal(value, true, what);
  assertions++;
};

const ADMIN = "aaaaaaaa-0000-4000-8000-000000000001"; // presses Seed
const REAL_REP = "aaaaaaaa-0000-4000-8000-000000000002"; // a real rep
const DEMO = (n) => `d0000001-0000-4000-8000-00000000000${n}`;
// Sample reps 1, 2, 3, 5 exist as demo profiles; 4 (Dallas) and 7 (Arden) do
// not — purged, or never created on this database.
const DEMO_REPS = [1, 2, 3, 5].map(DEMO);
const REAL_ACCOUNT = "bbbbbbbb-0000-4000-8000-000000000001";
const REAL_JOBS = [1, 2, 3].map((n) => `cccccccc-0000-4000-8000-00000000000${n}`);
const REAL_GIFT = "eeeeeeee-0000-4000-8000-000000000001";
// A demo account a real rep has been put on (Seed keeps an existing row).
const DEMO_ACCOUNT_1 = "ac000000-0000-4000-8000-000000000001";
const REAL_CONTACT_ON_DEMO = "ffffffff-0000-4000-8000-000000000001";

const PIPES = {
  "11111111-1111-4111-8111-111111111111": [
    "target",
    "researching",
    "attempting_contact",
    "meeting_booked",
    "meeting_held",
    "vendor_onboarding",
    "active",
    "nurture",
    "dormant",
    "lost",
  ],
  "22222222-2222-4222-8222-222222222222": [
    "leads",
    "new_lead_input",
    "ready",
    "active_outreach",
    "conversation_established",
    "meeting_booked",
    "meeting_held",
    "active_client",
    "goasted",
    "no_service_needed",
  ],
  "33333333-3333-4333-8333-333333333333": [
    "healthy",
    "needs_attention",
    "annual_meeting",
    "ghosted",
  ],
};
const OFFICES = ["NY", "NY-UP", "NJ", "MD", "NC", "GA", "IL", "IN", "MI", "TX", "CA"];

const DOMAINS = [
  "account_type",
  "account_status",
  "contact_decision_role",
  "gift_policy",
  "touchpoint_type",
  "capture_source",
  "comm_direction",
  "task_priority",
  "task_status",
  "goal_metric",
  "job_loss_type",
  "job_status",
  "estimate_status",
  "invoice_status",
  "incident_type",
  "incident_status",
  "incident_outcome",
  "gift_delivery_status",
];

const SCHEMA = `
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT '${ADMIN}'::uuid $$;
  ${DOMAINS.map((d) => `CREATE DOMAIN public.${d} AS text;`).join("\n")}
  CREATE FUNCTION public.has_role(uuid, text) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
  CREATE FUNCTION public.is_privileged(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
  CREATE FUNCTION public.contact_gift_policy(uuid) RETURNS text LANGUAGE sql AS $$ SELECT 'open' $$;

  CREATE TABLE public.profiles (user_id uuid PRIMARY KEY, full_name text, is_demo boolean NOT NULL DEFAULT false);
  CREATE TABLE public.app_settings (key text PRIMARY KEY, value jsonb);
  CREATE TABLE public.locations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text, name text, region text, locality text,
    address text, postal_code text, office_phone text, office_email text,
    lat float8, lon float8, active boolean DEFAULT true);
  CREATE TABLE public.pipeline_stages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), pipeline_id uuid, key text);
  CREATE TABLE public.accounts (
    id uuid PRIMARY KEY, name text, location_id uuid, assigned_rep uuid, created_by uuid,
    account_type account_type, status account_status, pipeline_id uuid, stage_id uuid, stage text,
    priority text, estimated_annual_value numeric, lost_reason text, no_service_reason_code text,
    approval_state text, approval_due_on date, goasted_at timestamptz, health_pipeline_id uuid,
    health_stage_id uuid, health_changed_at timestamptz, last_in_person_at timestamptz,
    annual_meeting_due_on date, what_they_do text[], is_reference boolean DEFAULT false,
    archived_at timestamptz, is_demo boolean NOT NULL DEFAULT false,
    created_at timestamptz DEFAULT now(), stage_changed_at timestamptz);
  CREATE TABLE public.account_locations (account_id uuid, location_id uuid, created_by uuid,
    is_demo boolean NOT NULL DEFAULT false, UNIQUE (account_id, location_id));
  CREATE TABLE public.account_stage_history (account_id uuid, is_demo boolean NOT NULL DEFAULT false);
  CREATE TABLE public.contacts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid, location_id uuid, full_name text,
    title text, decision_role contact_decision_role, email text, phone text, gift_policy gift_policy,
    gift_policy_notes text, is_primary boolean, is_decision_maker boolean, birthday_month int,
    birthday_day int, spouse_name text, hobbies text, preferred_contact_method text,
    best_time_to_reach text, created_by uuid, archived_at timestamptz,
    is_demo boolean NOT NULL DEFAULT false, created_at timestamptz DEFAULT now());
  CREATE TABLE public.touchpoints (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid, contact_id uuid,
    type touchpoint_type, occurred_at timestamptz, notes text, created_by uuid,
    capture_source capture_source, direction comm_direction, is_self_reported boolean,
    duration_seconds int, replied_at timestamptz, meeting_held boolean, lat float8, lon float8,
    place_label text, counts_toward_cadence boolean, is_demo boolean NOT NULL DEFAULT false);
  CREATE TABLE public.account_notes (id uuid PRIMARY KEY, account_id uuid, body text,
    is_pinned boolean, trigger_type text, created_by uuid, is_demo boolean NOT NULL DEFAULT false,
    created_at timestamptz);
  CREATE TABLE public.tasks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text, description text, assignee uuid,
    due_date date, due_time time, priority task_priority, status task_status, entity_type text,
    entity_id uuid, job_id uuid, account_id uuid, location_id uuid, source text, cadence_key text,
    completed_at timestamptz, created_by uuid, is_demo boolean NOT NULL DEFAULT false,
    created_at timestamptz DEFAULT now());
  CREATE TABLE public.goals (id uuid PRIMARY KEY, subject_user_id uuid, location_id uuid,
    metric goal_metric, target_value numeric, period_type text, starts_on date, ends_on date,
    is_active boolean, set_by uuid, is_demo boolean NOT NULL DEFAULT false);
  CREATE TABLE public.gift_catalog (id uuid PRIMARY KEY, name text, description text,
    unit_cost_cents int, active boolean, is_demo boolean NOT NULL DEFAULT false);
  CREATE TABLE public.gift_sends (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contact_id uuid,
    account_id uuid, catalog_item_id uuid, sent_at timestamptz, cost_cents int,
    delivery_status gift_delivery_status, tracking_ref text, notes text, created_by uuid,
    is_demo boolean NOT NULL DEFAULT false);
  CREATE TABLE public.jobs (
    id uuid PRIMARY KEY, job_number text, account_id uuid, location_id uuid, job_name text,
    job_type text, customer_kind text, customer_name text, address text, locality text,
    region text, postal_code text, loss_type job_loss_type, status job_status, loss_date date,
    call_date date, call_time time, first_response_at timestamptz, start_date date,
    completion_date date, insurance_carrier text, claim_number text, adjuster_name text,
    adjuster_email text, adjuster_phone text, policy_number text, deductible numeric,
    cash_payer_name text, agreed_price numeric, payment_terms text, estimated_amount numeric,
    billed_amount numeric, collected_amount numeric, initial_loss_description text,
    loss_description text, important_instructions text, created_by uuid,
    is_demo boolean NOT NULL DEFAULT false, created_at timestamptz DEFAULT now());
  CREATE TABLE public.job_status_history (job_id uuid, is_demo boolean NOT NULL DEFAULT false);
  CREATE TABLE public.job_notes (id uuid PRIMARY KEY, job_id uuid, author_id uuid, body text,
    is_demo boolean NOT NULL DEFAULT false, created_at timestamptz);
  CREATE TABLE public.estimates (
    id uuid PRIMARY KEY, job_id uuid, location_id uuid, status estimate_status, title text,
    call_date date, estimate_date date, job_number text, customer_name text, account_id uuid,
    address text, locality text, region text, postal_code text, office_name text,
    office_phone text, office_email text, office_address text, tax_rate numeric, notes text,
    created_by uuid, is_demo boolean NOT NULL DEFAULT false, created_at timestamptz,
    sent_at timestamptz, decided_at timestamptz);
  CREATE TABLE public.estimate_scopes (id uuid PRIMARY KEY, estimate_id uuid, name text,
    room_name text, position int);
  CREATE TABLE public.estimate_catalog_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code text, name text, description text, uom text, default_cost numeric,
    default_unit_price numeric, taxable boolean);
  CREATE TABLE public.estimate_lines (id uuid PRIMARY KEY, estimate_id uuid, scope_id uuid,
    catalog_item_id uuid, position int, code text, name text, description text, uom text,
    quantity numeric, unit_cost numeric, unit_price numeric, taxable boolean);
  CREATE TABLE public.invoices (
    id uuid PRIMARY KEY, invoice_number text UNIQUE, job_id uuid, account_id uuid, location_id uuid,
    carrier text, claim_number text, adjuster_name text, adjuster_email text, issue_date date,
    due_date date, billed_amount numeric, approved_amount numeric, collected_amount numeric,
    status invoice_status, sent_at timestamptz, notes text, created_by uuid,
    is_demo boolean NOT NULL DEFAULT false);
  CREATE TABLE public.invoice_payments (id uuid PRIMARY KEY, invoice_id uuid, amount numeric,
    received_at date, method text, reference text, is_demo boolean NOT NULL DEFAULT false);
  CREATE TABLE public.incidents (
    id uuid PRIMARY KEY, source text, external_ref text, reported_at timestamptz, raw_text text,
    address text, locality text, region text, incident_type incident_type, alarm_level text,
    call_sign text, status incident_status, location_id uuid, dispatched_at timestamptz,
    accepted_by uuid, accepted_at timestamptz, arrived_at timestamptz, outcome incident_outcome,
    outcome_notes text, outcome_at timestamptz, is_demo boolean NOT NULL DEFAULT false);
  CREATE TABLE public.incident_events (incident_id uuid, is_demo boolean NOT NULL DEFAULT false);
`;

const FIXTURES = `
  INSERT INTO public.profiles (user_id, full_name, is_demo) VALUES
    ('${ADMIN}', 'Real Admin', false),
    ('${REAL_REP}', 'Real Rep', false),
    ${DEMO_REPS.map((u, i) => `('${u}', 'Sample Rep ${i}', true)`).join(",\n    ")};
  INSERT INTO public.app_settings VALUES ('estimates', '{"tax_rate": 0.08}');
  INSERT INTO public.locations (code, name, region, locality, lat, lon) VALUES
    ${OFFICES.map((c, i) => `('${c}', '${c} office', 'R${i}', 'Town ${i}', ${40 + i * 0.1}, ${-74 + i * 0.1})`).join(",\n    ")};
  INSERT INTO public.pipeline_stages (pipeline_id, key) VALUES
    ${Object.entries(PIPES)
      .flatMap(([p, keys]) => keys.map((k) => `('${p}', '${k}')`))
      .join(",\n    ")};

  -- Real data that must never receive a demo row.
  INSERT INTO public.accounts (id, name, location_id, assigned_rep, is_demo)
    SELECT '${REAL_ACCOUNT}', 'Real Customer LLC', id, '${REAL_REP}', false FROM public.locations WHERE code = 'NY';
  INSERT INTO public.jobs (id, job_number, account_id, location_id, status, billed_amount, is_demo)
    SELECT j.id::uuid, j.num, '${REAL_ACCOUNT}', l.id, j.st, 10000, false
      FROM public.locations l,
           (VALUES ('${REAL_JOBS[0]}', 'GS-0001', 'complete'), ('${REAL_JOBS[1]}', 'GS-0002', 'paid'),
                   ('${REAL_JOBS[2]}', 'GS-0003', 'invoiced')) AS j(id, num, st)
     WHERE l.code = 'NY';
  -- The cheapest item in the catalog is a real one.
  INSERT INTO public.gift_catalog VALUES ('${REAL_GIFT}', 'Real gift', 'Real', 100, true, false);

  -- A demo account a real rep has been put on, carrying a real contact that
  -- sorts first: neither may be credited with or attached to demo rows.
  INSERT INTO public.accounts (id, name, location_id, assigned_rep, is_demo)
    SELECT '${DEMO_ACCOUNT_1}', 'Meridian Property Group', id, '${REAL_REP}', true FROM public.locations WHERE code = 'NY';
  INSERT INTO public.contacts (id, account_id, full_name, is_primary, is_demo)
    VALUES ('${REAL_CONTACT_ON_DEMO}', '${DEMO_ACCOUNT_1}', 'AAA Real Contact', true, false);
`;

/** The live definitions before the fix, rebuilt the way the database built them. */
function liveBefore() {
  let data = fnFrom(file("20260806202757_"), "seed_demo_data", "$fn$");
  data = data.replaceAll("loss_types", "what_they_do"); // 20260811200822
  const a = data.indexOf(
    "  ---------------------------------------------------------------- equipment\n",
  );
  const b = data.indexOf(
    "  ---------------------------------------------------------------- invoices\n",
  );
  data = data.slice(0, a) + data.slice(b); // 20260821171822
  let jobs = fnFrom(file("20260813173636_"), "seed_demo_jobs", "$fn$");
  jobs = jobs.replace(
    "CASE WHEN a.account_type = 'residential' THEN 'residential' ELSE 'commercial' END",
    "CASE WHEN a.account_type = 'residential' THEN 'person' ELSE 'company' END",
  ); // 20260813174824
  return { data, jobs };
}

async function freshDb() {
  const db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(FIXTURES);
  return db;
}

const one = async (db, sql) => Object.values((await db.query(sql)).rows[0] ?? {})[0];
const num = async (db, sql) => Number(await one(db, sql));

/* ------------------------------------------------------------------ */
/* 1. Before: the bug, reproduced                                       */
/* ------------------------------------------------------------------ */
{
  const db = await freshDb();
  const before = liveBefore();
  await db.exec(before.jobs);
  await db.exec(before.data);
  // The app's old order: jobs first, then data.
  await db.query("SELECT * FROM public.seed_demo_jobs()");
  await db.query("SELECT * FROM public.seed_demo_data()");

  // Only the one demo account that already existed got its job; the other
  // fourteen demo jobs need accounts seed_demo_data had not made yet.
  eq(
    await num(db, "SELECT count(*) FROM jobs WHERE is_demo"),
    1,
    "before: jobs-first made only the job whose demo account already existed",
  );
  eq(
    await num(
      db,
      `SELECT count(*) FROM invoices WHERE is_demo AND job_id IN ('${REAL_JOBS.join("','")}')`,
    ),
    3,
    "before: every completed REAL job got a demo invoice",
  );
  check(
    (await num(
      db,
      `SELECT count(*) FROM invoice_payments p JOIN invoices i ON i.id = p.invoice_id
                       WHERE p.is_demo AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = i.job_id AND j.is_demo)`,
    )) > 0,
    "before: and demo payments landed on real jobs' invoices",
  );
  check(
    (await num(
      db,
      `SELECT count(*) FROM touchpoints WHERE is_demo AND created_by = '${REAL_REP}'`,
    )) > 0,
    "before: a real rep on a demo account was credited with demo touchpoints",
  );
  check(
    (await num(
      db,
      `SELECT count(*) FROM touchpoints WHERE is_demo AND contact_id = '${REAL_CONTACT_ON_DEMO}'`,
    )) > 0,
    "before: demo touchpoints were logged against a real contact",
  );
  await db.close();
}

/* ------------------------------------------------------------------ */
/* 2. After: the migration, seeded the way the app now seeds            */
/* ------------------------------------------------------------------ */
const db = await freshDb();
// The functions the migration patches in place must exist first, as live.
await db.exec(fnFrom(file("20260814002136_"), "seed_demo_pipelines", "$$"));
await db.exec(fnFrom(file("20260806210339_"), "seed_demo_extras", "$fn$"));
const migration = file("20261016130000_");
await db.exec(migration);
// Re-runnable: applying it twice changes nothing and does not fail.
await db.exec(migration);

const def = async (name) =>
  one(
    db,
    `SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname = '${name}'`,
  );
const pipelinesDef = await def("seed_demo_pipelines");
check(
  pipelinesDef.includes("FROM public.gift_catalog WHERE is_demo"),
  "pipelines: gift sends use a demo catalog item",
);
eq(
  pipelinesDef.split("public.demo_user_or_null(a.assigned_rep)").length - 1,
  4,
  "pipelines: next activities, gifts and both contact sets are owned by a demo rep or nobody",
);
check(
  pipelinesDef.includes("reps := array_remove(ARRAY[public.demo_user_or_null(r_renata)"),
  "pipelines: the fallback rep list is demo profiles only",
);
const extrasDef = await def("seed_demo_extras");
check(
  extrasDef.includes("FROM gift_catalog WHERE is_demo"),
  "extras: gift campaigns use a demo catalog item",
);
check(
  extrasDef.includes("WHERE account_id = a.id AND is_demo"),
  "extras: leads copy a demo contact",
);
eq(
  extrasDef.split("public.demo_user_or_null(a.assigned_rep)").length - 1,
  3,
  "extras: emails, calendar events and calls belong to a demo rep or nobody",
);

// The app's order now (src/lib/demo-data.ts), then everything again.
for (let pass = 1; pass <= 2; pass++) {
  await db.query("SELECT * FROM public.seed_demo_data()");
  await db.query("SELECT * FROM public.seed_demo_jobs()");
  await db.query("SELECT * FROM public.seed_demo_pipelines()");
  await db.query("SELECT * FROM public.seed_demo_visits()");
}

eq(
  await num(db, "SELECT count(*) FROM jobs WHERE is_demo"),
  15,
  "after: the demo jobs exist on a fresh seed",
);
eq(
  await num(db, `SELECT count(*) FROM invoices WHERE job_id IN ('${REAL_JOBS.join("','")}')`),
  0,
  "after: no real job has an invoice from the seeder",
);
eq(
  await num(
    db,
    `SELECT count(*) FROM invoices i WHERE i.is_demo
                  AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = i.job_id AND j.is_demo)`,
  ),
  0,
  "after: every demo invoice is on a demo job",
);
check(
  (await num(db, "SELECT count(*) FROM invoices WHERE is_demo")) >= 4,
  "after: the demo jobs still get their invoices",
);
eq(
  await num(
    db,
    `SELECT count(*) FROM invoice_payments p JOIN invoices i ON i.id = p.invoice_id
                  WHERE p.is_demo AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = i.job_id AND j.is_demo)`,
  ),
  0,
  "after: every demo payment is on a demo job's invoice",
);
eq(
  await num(
    db,
    "SELECT count(*) FROM (SELECT invoice_id FROM invoice_payments GROUP BY 1 HAVING count(*) > 1) x",
  ),
  0,
  "after: no invoice is paid twice, even seeded twice",
);
eq(
  await num(db, `SELECT count(*) FROM jobs WHERE NOT is_demo AND billed_amount <> 10000`),
  0,
  "after: real jobs untouched",
);

for (const [table, col] of [
  ["tasks", "job_id"],
  ["job_notes", "job_id"],
  ["estimates", "job_id"],
  ["invoices", "job_id"],
]) {
  eq(
    await num(
      db,
      `SELECT count(*) FROM ${table} t WHERE t.is_demo AND t.${col} IS NOT NULL
                    AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = t.${col} AND j.is_demo)`,
    ),
    0,
    `after: every demo ${table} row's job is a demo job`,
  );
}
for (const table of [
  "contacts",
  "touchpoints",
  "account_notes",
  "tasks",
  "gift_sends",
  "invoices",
  "estimates",
  "jobs",
  "account_locations",
]) {
  eq(
    await num(
      db,
      `SELECT count(*) FROM ${table} t WHERE t.is_demo AND t.account_id IS NOT NULL
                    AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = t.account_id AND a.is_demo)`,
    ),
    0,
    `after: every demo ${table} row's account is a demo account`,
  );
}
eq(
  await num(
    db,
    `SELECT count(*) FROM touchpoints t WHERE t.is_demo AND t.contact_id IS NOT NULL
                  AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id = t.contact_id AND c.is_demo)`,
  ),
  0,
  "after: demo touchpoints are only with demo contacts",
);
eq(
  await num(
    db,
    `SELECT count(*) FROM gift_sends g WHERE g.is_demo
                  AND NOT EXISTS (SELECT 1 FROM gift_catalog c WHERE c.id = g.catalog_item_id AND c.is_demo)`,
  ),
  0,
  "after: demo gift sends use demo catalog items",
);
check(
  (await num(db, "SELECT count(*) FROM gift_sends WHERE is_demo")) > 0,
  "after: gift sends were still made",
);
eq(
  await num(
    db,
    `SELECT count(*) FROM estimate_scopes s
                  WHERE NOT EXISTS (SELECT 1 FROM estimates e WHERE e.id = s.estimate_id AND e.is_demo)`,
  ),
  0,
  "after: estimate scopes hang off demo estimates",
);

// People: every demo row is credited to a demo profile or to nobody.
const PEOPLE = [
  ["jobs", "created_by"],
  ["job_notes", "author_id"],
  ["tasks", "assignee"],
  ["tasks", "created_by"],
  ["estimates", "created_by"],
  ["invoices", "created_by"],
  ["contacts", "created_by"],
  ["touchpoints", "created_by"],
  ["account_notes", "created_by"],
  ["goals", "subject_user_id"],
  ["goals", "set_by"],
  ["gift_sends", "created_by"],
  ["incidents", "accepted_by"],
  ["account_locations", "created_by"],
];
for (const [table, col] of PEOPLE) {
  eq(
    await num(
      db,
      `SELECT count(*) FROM ${table} t WHERE t.is_demo AND t.${col} IS NOT NULL
                    AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.user_id = t.${col} AND p.is_demo)`,
    ),
    0,
    `after: ${table}.${col} is a demo profile or nobody`,
  );
}
eq(
  await num(db, `SELECT count(*) FROM touchpoints WHERE created_by = '${REAL_REP}'`),
  0,
  "after: the real rep on a demo account is credited with no demo visit or touchpoint",
);
eq(
  await num(db, "SELECT count(*) FROM goals WHERE subject_user_id IS NULL"),
  0,
  "after: no goal is made for a sample rep who is not there",
);
check(
  (await num(db, "SELECT count(*) FROM touchpoints WHERE is_demo AND lat IS NOT NULL")) > 0,
  "after: demo visits were still made for demo reps",
);

// Seeding twice added nothing.
const counts = async () =>
  (
    await db.query(`SELECT (SELECT count(*) FROM jobs) + (SELECT count(*) FROM invoices)
                        + (SELECT count(*) FROM invoice_payments) + (SELECT count(*) FROM job_notes) AS n`)
  ).rows[0].n;
const n1 = await counts();
await db.query("SELECT * FROM public.seed_demo_data()");
eq(await counts(), n1, "after: a third seed adds no jobs, invoices, payments or notes");

await db.close();
console.log(`demo-seeder-parents.pglite: ${assertions} assertions passed`);
