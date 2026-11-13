// Run with: node supabase/tests/running-cost-commission.pglite.mjs <PGlite dist/index.js>
// In-memory fixtures only. No connection string, network access or live writes.
//
// Running cost counts commission (migration 20261007224300). Mark, 7 Oct:
// "... or a flat fee, and running cost needs to add that into its
// calculation as well". The migrations under test are READ FROM THEIR FILES,
// in version order, on top of the running-cost definitions they replace.
//
// What it proves:
//   1. job_running_cost keeps its argument list, SECURITY DEFINER,
//      search_path and grants exactly as before; every column it had keeps
//      its name, type and position; three commission columns are appended.
//   2. total_cost = the old total + the referrer's commission + the
//      salesmen's (a void payout is not counted); margin and margin_pct
//      follow; the three new columns say which is which.
//   3. Adding a charge moves the referrer's commission (a percentage of the
//      calculated revenue) — and only once, inside total_cost.
//   4. The finance gate still answers a rep with no row.
//   5. running_cost_overview reports the new total for the job.
//   6. job_referrer_commission gives every shared case's `expected`
//      (supabase/tests/fixtures/referrer-commission-cases.json — the same
//      cases src/lib/job-commission.parity.test.ts runs through TypeScript),
//      and no client role can execute it.
//
// The stub schema is the running-cost fixture's own (read from
// running-cost-all-sources.pglite.mjs, never retyped), plus the columns and
// tables the commission migrations touch.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
const read = (name) => readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8");
const CASES = JSON.parse(
  readFileSync(new URL("./fixtures/referrer-commission-cases.json", import.meta.url), "utf8"),
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

function functionFrom(file, signature) {
  const sql = read(file);
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${signature}`);
  assert.notEqual(start, -1, `${signature} not found in ${file}`);
  const end = sql.indexOf("$$;", start);
  return sql.slice(start, end + 3);
}

/** The running-cost fixture's stub schema, verbatim. */
function stubSchema() {
  const src = readFileSync(
    new URL("./running-cost-all-sources.pglite.mjs", import.meta.url),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const open = src.indexOf("try {\n  await db.exec(`");
  assert.notEqual(open, -1, "stub schema block not found");
  const from = src.indexOf("`", open) + 1;
  const to = src.indexOf("\n  `);", from);
  return src.slice(from, to);
}

const OWNER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const REP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LOC = "11111111-1111-4111-8111-111111111111";
const JOB = "01010101-0101-4101-8101-010101010101";
const ACME = "a0a0a0a0-0000-4000-8000-000000000001";
const OTHER_CO = "a0a0a0a0-0000-4000-8000-000000000002";
const JANE = "c0c0c0c0-0000-4000-8000-000000000001";
const IDS = { A: ACME, B: OTHER_CO, P: JANE };

const fnMeta = async () =>
  (
    await db.query(`
      SELECT pg_get_function_identity_arguments(p.oid) AS args, p.prosecdef, p.proconfig,
             p.provolatile,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_x,
             has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_x,
             has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc_x,
             (SELECT array_agg(a.n || ':' || format_type(a.t, NULL) ORDER BY a.i)
                FROM unnest(p.proargnames, p.proallargtypes, p.proargmodes)
                     WITH ORDINALITY AS a(n, t, m, i) WHERE a.m = 't') AS outs
      FROM pg_proc p WHERE p.proname = 'job_running_cost'`)
  ).rows[0];

try {
  await db.exec(stubSchema());
  await db.exec(`
    CREATE ROLE portal_customer;
    CREATE SCHEMA goldstar_private;
    GRANT USAGE ON SCHEMA goldstar_private TO anon, authenticated, service_role;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    CREATE TABLE public.profiles (user_id uuid PRIMARY KEY, is_active boolean NOT NULL DEFAULT true);
    CREATE FUNCTION goldstar_private.profile_is_active(_u uuid) RETURNS boolean
      LANGUAGE sql STABLE AS $$ SELECT true $$;
    CREATE FUNCTION public.is_privileged(_u uuid) RETURNS boolean LANGUAGE sql STABLE AS
      $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _u AND role IN ('owner','admin','dev')) $$;
    CREATE FUNCTION public.has_permission(_u uuid, _k text, _l uuid) RETURNS boolean
      LANGUAGE sql STABLE AS $$ SELECT false $$;
    CREATE TABLE public.accounts (id uuid PRIMARY KEY, name text);
    CREATE TABLE public.contacts (id uuid PRIMARY KEY, full_name text);
    CREATE TABLE public.app_settings (key text PRIMARY KEY, value jsonb);
    CREATE TABLE public.commission_payouts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid, user_id uuid,
      kind text NOT NULL, status text NOT NULL, amount numeric NOT NULL
    );
    ALTER TABLE public.jobs
      ADD COLUMN created_at timestamptz NOT NULL DEFAULT '2026-10-01 12:00-04',
      ADD COLUMN referred_by_account_id uuid,
      ADD COLUMN referred_by_contact_id uuid,
      ADD COLUMN referred_by_name text,
      ADD COLUMN commission_source text,
      ADD COLUMN commission_rate_pct numeric(5,2);
  `);

  // The pricing helpers and the two running-cost definitions this replaces.
  await db.exec(
    functionFrom(
      "20260804185343_1b92ce7e-f686-4a26-97e4-0d63d2c4b221.sql",
      "public.rate_for(_user_id uuid, _on date)",
    ),
  );
  await db.exec(
    functionFrom("20260902200000_labour_rates_crew_class.sql", "public.crew_rate_for("),
  );
  await db.exec(
    functionFrom(
      "20260902200500_field_ticket_crew_hours.sql",
      "public.field_ticket_crew_minutes(_start text, _end text)",
    ),
  );
  await db.exec(read("20260918100000_running_cost_all_sources.sql"));
  await db.exec(read("20260927120000_equipment_days_local_calendar.sql"));
  const before = await fnMeta();

  // The commission migrations, in version order.
  await db.exec(read("20261007224100_referral_commission_rules.sql"));
  await db.exec(read("20261007224200_job_commission_flat_override.sql"));
  await db.exec(read("20261007224300_running_cost_commission.sql"));
  const after = await fnMeta();

  /* ---- 1. same function, three columns longer -------------------------- */
  eq(after.args, before.args, "the argument list is unchanged");
  eq(after.prosecdef, before.prosecdef, "still SECURITY DEFINER");
  eq(
    JSON.stringify(after.proconfig),
    JSON.stringify(before.proconfig),
    "search_path pinned as before",
  );
  eq(after.provolatile, before.provolatile, "still STABLE");
  eq(after.auth_x, true, "authenticated can still execute it");
  eq(after.anon_x, false, "anon still cannot");
  eq(after.svc_x, true, "service_role still can");
  eq(after.auth_x === before.auth_x && after.anon_x === before.anon_x, true, "grants as before");
  check(
    JSON.stringify(after.outs.slice(0, before.outs.length)) === JSON.stringify(before.outs),
    "every old column keeps its name, type and position",
  );
  eq(
    after.outs.slice(before.outs.length).join(","),
    "referrer_commission_cost:numeric,salesman_commission_cost:numeric,commission_cost:numeric",
    "three commission columns appended",
  );

  /* ---- 2 & 3. commission in the total, once ---------------------------- */
  await db.exec(`
    INSERT INTO public.user_roles VALUES ('${OWNER}', 'owner'), ('${REP}', 'sales_person');
    INSERT INTO auth.users VALUES ('${OWNER}'), ('${REP}');
    INSERT INTO public.accounts VALUES ('${ACME}', 'Acme'), ('${OTHER_CO}', 'Other');
    INSERT INTO public.contacts VALUES ('${JANE}', 'Jane');
    INSERT INTO public.app_settings VALUES ('commission_rates', '${JSON.stringify({ sources: CASES.sources })}');
    INSERT INTO public.jobs (id, job_number, address, location_id, status, referred_by_account_id)
      VALUES ('${JOB}', 'J-1', '1 Main', '${LOC}', 'in_progress', '${ACME}');
    INSERT INTO public.referral_commission_rules (account_id, kind, value) VALUES ('${ACME}', 'percent', 8);
    INSERT INTO public.expenses (job_id, amount) VALUES ('${JOB}', 1000);
    INSERT INTO public.invoices (job_id, status, billed_amount) VALUES ('${JOB}', 'sent', 10000);
    INSERT INTO public.commission_payouts (job_id, user_id, kind, status, amount) VALUES
      ('${JOB}', '${REP}', 'commission', 'pending', 600),
      ('${JOB}', '${REP}', 'commission', 'void', 999),
      ('${JOB}', '${REP}', 'salary', 'paid', 5000);
  `);
  const rc = async (uid) => {
    await db.query(`SELECT set_config('test.uid', '${uid}', false)`);
    return (await db.query(`SELECT * FROM public.job_running_cost('${JOB}')`)).rows[0];
  };
  let r = await rc(OWNER);
  eq(Number(r.referrer_commission_cost), 800, "referrer: Acme's 8% of the $10,000 invoiced");
  eq(
    Number(r.salesman_commission_cost),
    600,
    "salesmen: the pending payout; void and salary are not commission",
  );
  eq(Number(r.commission_cost), 1400, "commission_cost is the two together");
  eq(Number(r.expenses_cost), 1000, "the other costs are untouched");
  eq(Number(r.total_cost), 2400, "total_cost = $1,000 of expenses + $1,400 of commission");
  eq(Number(r.margin), 7600, "margin is revenue less that total");
  eq(Number(r.margin_pct), 76, "margin_pct follows");

  await db.exec(
    `INSERT INTO public.invoices (job_id, status, billed_amount) VALUES ('${JOB}', 'sent', 2500)`,
  );
  r = await rc(OWNER);
  eq(Number(r.revenue), 12500, "a new charge raises the revenue");
  eq(Number(r.referrer_commission_cost), 1000, "and the referrer's commission with it");
  eq(Number(r.total_cost), 2600, "counted once in the total");

  await db.exec(`UPDATE public.jobs SET commission_flat_amount = 300 WHERE id = '${JOB}'`);
  r = await rc(OWNER);
  eq(Number(r.referrer_commission_cost), 300, "a flat override on the job replaces the deal");
  await db.exec(`UPDATE public.jobs SET commission_flat_amount = NULL WHERE id = '${JOB}'`);

  /* ---- 4. the finance gate --------------------------------------------- */
  eq(await rc(REP), undefined, "a rep still gets no row");

  /* ---- 5. the overview ------------------------------------------------- */
  await db.query(`SELECT set_config('test.uid', '${OWNER}', false)`);
  const ov = (await db.query(`SELECT * FROM public.running_cost_overview(NULL, 8)`)).rows.find(
    (x) => x.job_id === JOB,
  );
  eq(Number(ov.total_cost), 2600, "the overview's job total includes commission");

  /* ---- 6. the shared cases, through SQL --------------------------------- */
  for (const [i, c] of CASES.cases.entries()) {
    const id = `0f0f0f0f-0000-4000-8000-${String(i).padStart(12, "0")}`;
    const on = c.job.on ?? "2026-10-01";
    const v = (x) => (x == null ? "NULL" : `'${x}'`);
    await db.exec(`
      DELETE FROM public.referral_commission_rules;
      INSERT INTO public.jobs (id, job_number, location_id, created_at, referred_by_account_id,
        referred_by_contact_id, commission_source, commission_rate_pct, commission_flat_amount)
      VALUES ('${id}', 'C-${i}', '${LOC}', '${on} 12:00-04', ${v(IDS[c.job.acc])}, ${v(IDS[c.job.con])},
        ${v(c.job.src)}, ${c.job.pct ?? "NULL"}, ${c.job.flat ?? "NULL"});
    `);
    for (const rule of c.rules) {
      await db.exec(`INSERT INTO public.referral_commission_rules
        (account_id, contact_id, kind, value, effective_from, effective_to)
        VALUES (${v(IDS[rule.acc])}, ${v(IDS[rule.con])}, '${rule.kind}', ${rule.value},
                ${v(rule.from)}, ${v(rule.to)})`);
    }
    const got = (
      await db.query(
        `SELECT origin, kind, amount FROM public.job_referrer_commission('${id}', ${c.revenue})`,
      )
    ).rows[0];
    if (c.expected == null) {
      eq(got, undefined, `SQL: ${c.name}`);
    } else {
      eq(
        JSON.stringify({ origin: got?.origin, kind: got?.kind, amount: Number(got?.amount) }),
        JSON.stringify(c.expected),
        `SQL: ${c.name}`,
      );
    }
  }

  const inner = (
    await db.query(`SELECT p.prosecdef, p.proconfig,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_x,
        has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_x
      FROM pg_proc p WHERE p.proname = 'job_referrer_commission'`)
  ).rows[0];
  eq(inner.prosecdef, false, "job_referrer_commission is SECURITY INVOKER");
  check(
    (inner.proconfig ?? []).some((x) => x.startsWith("search_path=")),
    "it pins search_path",
  );
  check(inner.auth_x === false && inner.anon_x === false, "no client role can call it directly");

  console.log(`running-cost-commission.pglite: ${assertions} assertions passed`);
} finally {
  await db.close();
}
