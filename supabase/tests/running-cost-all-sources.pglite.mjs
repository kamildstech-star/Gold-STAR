// Run with: node supabase/tests/running-cost-all-sources.pglite.mjs <PGlite dist/index.js>
// In-memory fixtures only. No connection string, network access or live writes.
//
// REGRESSION TEST for `job_running_cost` (migration 20260918100000), the
// figure behind the Running cost tile on the job's right rail. Mark:
//   "the right side should show a runnign cost adding up all costs added in
//    from alal sources of costs from the project"
//
// What it proves, against the real migration file, on ONE job that carries
// one of everything:
//   1. every source lands in its own column at the right figure;
//   2. total_cost is the sum of the counted columns and nothing else — the
//      calculator projection is returned but not summed;
//   3. field tickets: a ticket the app has already filed as a cost line
//      (PR #205's path) is taken as filed; a ticket with no line — the crew's
//      save, refused by RLS — is priced here from its crew, hours and
//      machines, honouring the office's overrides; a class with no crew rate
//      is reported as uncosted minutes rather than silently $0;
//   4. no double count: the time clock is superseded on a date a ticket
//      priced labour, counts on the other dates, and comes back if the
//      ticket's lines are dismissed;
//   5. a hand-typed cost line is a source, not an override: its equipment is
//      added to the drying log's, its subs land in subcontractor_cost, and
//      it is never mistaken for a ticket line;
//   6. the revenue ladder: invoice beats approved estimate beats agreed
//      price beats the newest sent estimate beats the newest PRICED draft —
//      two empty drafts never hide the $872 one;
//   7. the finance gate returns no row at all to a rep, and no row without a
//      session;
//   8. running_cost_overview reports the same total for the job.
//
// The helpers the function calls that carry business rules — rate_for,
// crew_rate_for, field_ticket_crew_minutes — are loaded from their own
// migrations so the pricing under test is the real pricing. Access helpers
// (can_view_finance, can_view_location, auth.uid) are stubbed over a small
// roles table.
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
const money = (v) => Number(v);

/** Pull one function body out of a migration so nothing is retyped. */
function functionFrom(file, signature) {
  const sql = read(file);
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${signature}`);
  assert.notEqual(start, -1, `${signature} not found in ${file}`);
  const end = sql.indexOf("$$;", start);
  assert.notEqual(end, -1, `end of ${signature} not found in ${file}`);
  return sql.slice(start, end + 3);
}

const OWNER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const REP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TECH = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TECH_NO_RATE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const LOC = "11111111-1111-4111-8111-111111111111";
const JOB = "01010101-0101-4101-8101-010101010101";
const OTHER_JOB = "02020202-0202-4202-8202-020202020202";
const DEHU = "03030303-0303-4303-8303-030303030303";
const FAN_UNPRICED = "04040404-0404-4404-8404-040404040404";
const TICKET_MON = "05050505-0505-4505-8505-050505050505"; // unposted: priced by the function
const TICKET_TUE = "06060606-0606-4606-8606-060606060606"; // posted: the app filed its line
const TICKET_WED = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a"; // unposted, times unusable
const SUPPLY_REQ = "07070707-0707-4707-8707-070707070707";
const ITEM = "08080808-0808-4808-8808-080808080808";
const DENIED_REQ = "09090909-0909-4909-8909-090909090909";
const AIR_MOVER_PRICED = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b";

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
    CREATE TYPE public.time_entry_status AS ENUM ('draft','submitted','approved','rejected');
    CREATE TYPE public.estimate_status AS ENUM ('draft','sent','approved','declined');
    CREATE TYPE public.invoice_status AS ENUM ('draft','sent','partial','paid','disputed','written_off');
    CREATE TYPE public.supply_request_status AS ENUM ('requested','approved','ordered','delivered','denied');
    CREATE TYPE public.job_status AS ENUM ('new','scheduled','in_progress','drying','invoiced','closed');
    CREATE TYPE public.equipment_type AS ENUM
      ('air_mover','dehumidifier','air_scrubber','hepa','heater','generator','moisture_meter','other');

    /* ---- access stubs ---------------------------------------------------- */
    CREATE TABLE public.user_roles (user_id uuid, role public.app_role);
    CREATE FUNCTION public.can_view_finance(_user_id uuid) RETURNS boolean
      LANGUAGE sql STABLE AS $$
      SELECT EXISTS (SELECT 1 FROM public.user_roles
                     WHERE user_id = _user_id AND role IN ('owner','admin','sales_head','dev')) $$;
    CREATE FUNCTION public.can_view_location(_user_id uuid, _location_id uuid) RETURNS boolean
      LANGUAGE sql STABLE AS $$ SELECT _user_id IS NOT NULL $$;

    /* ---- the tables the function reads ----------------------------------- */
    CREATE TABLE public.jobs (
      id uuid PRIMARY KEY, job_number text, address text, location_id uuid,
      status public.job_status NOT NULL DEFAULT 'in_progress', agreed_price numeric(12,2)
    );
    CREATE TABLE public.equipment (
      id uuid PRIMARY KEY, equipment_type public.equipment_type NOT NULL, daily_rate_cents integer
    );
    CREATE TABLE public.equipment_placements (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid NOT NULL, equipment_id uuid NOT NULL,
      placed_at timestamptz NOT NULL, retrieved_at timestamptz
    );
    CREATE TABLE public.labour_rates (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, role public.app_role, crew_class text,
      location_id uuid, hourly_rate numeric NOT NULL, effective_from date NOT NULL, effective_to date
    );
    CREATE TABLE public.pay_structures (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, hourly_rate numeric,
      effective_from date NOT NULL, effective_to date
    );
    CREATE TABLE public.time_entries (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid, user_id uuid NOT NULL,
      started_at timestamptz NOT NULL DEFAULT now(), work_date date, minutes integer,
      status public.time_entry_status NOT NULL DEFAULT 'submitted'
    );
    CREATE TABLE public.field_work_tickets (
      id uuid PRIMARY KEY, job_id uuid NOT NULL, location_id uuid NOT NULL, work_date date NOT NULL,
      job_start_time text, job_end_time text, gsr_crew_size integer, temp_crew_size integer,
      equip_dehumidifier integer, equip_air_mover integer, equip_scrubber integer, equip_injector integer,
      equip_ozone integer, equip_hydroxyl integer, equip_generator integer
    );
    CREATE TABLE public.field_ticket_crew_reviews (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ticket_id uuid NOT NULL, crew_class text NOT NULL,
      review_state text NOT NULL, headcount_override integer, minutes_each_override integer
    );
    CREATE TABLE public.supply_items (id uuid PRIMARY KEY, unit_cost numeric(12,2));
    CREATE TABLE public.supply_requests (
      id uuid PRIMARY KEY, job_id uuid, status public.supply_request_status NOT NULL DEFAULT 'requested'
    );
    CREATE TABLE public.supply_request_lines (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), request_id uuid NOT NULL, item_id uuid, quantity numeric NOT NULL
    );
    CREATE TABLE public.supply_stock_moves (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL, item_id uuid NOT NULL,
      qty numeric(12,2) NOT NULL, reason text NOT NULL DEFAULT 'manual_adjust', request_id uuid, job_id uuid
    );
    CREATE TABLE public.job_cost_lines (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid NOT NULL, work_component text NOT NULL,
      revenue numeric NOT NULL DEFAULT 0, direct_cost numeric NOT NULL DEFAULT 0,
      materials_cost numeric NOT NULL DEFAULT 0, subcontractor_cost numeric NOT NULL DEFAULT 0,
      equipment_cost numeric NOT NULL DEFAULT 0, equipment_days integer NOT NULL DEFAULT 0,
      field_work_ticket_id uuid
    );
    CREATE TABLE public.expenses (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid, user_id uuid, amount numeric NOT NULL,
      kind text, spent_on date NOT NULL DEFAULT current_date, recurrence text NOT NULL DEFAULT 'one_off'
    );
    CREATE TABLE public.expense_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid, amount numeric NOT NULL, status text NOT NULL
    );
    CREATE TABLE public.job_referral_costs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid NOT NULL, amount numeric NOT NULL
    );
    CREATE TABLE public.job_calculations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid, job_date date NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(), customer_price numeric NOT NULL, internal_cost numeric NOT NULL
    );
    CREATE TABLE public.estimates (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid NOT NULL, seq integer,
      status public.estimate_status NOT NULL DEFAULT 'draft', total numeric NOT NULL DEFAULT 0,
      sent_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE public.invoices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid, status public.invoice_status NOT NULL DEFAULT 'draft',
      billed_amount numeric NOT NULL DEFAULT 0, approved_amount numeric
    );
  `);

  // The real pricing helpers, from the migrations that define them.
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

  /* ---- people, rates, and the job ------------------------------------ */
  await db.exec(`
    INSERT INTO public.user_roles VALUES
      ('${OWNER}', 'owner'), ('${REP}', 'sales_person'), ('${TECH}', 'crew'), ('${TECH_NO_RATE}', 'crew');
    INSERT INTO public.jobs (id, job_number, address, location_id, status) VALUES
      ('${JOB}', 'J-1', '24 Lodz Drive', '${LOC}', 'in_progress'),
      ('${OTHER_JOB}', 'J-2', 'Elsewhere', '${LOC}', 'in_progress');

    -- TECH is $30/h by a personal labour rate; the crew role is $20/h; GSR crew
    -- at this office is $25/h; TEMP has no rate anywhere. TECH_NO_RATE holds
    -- the crew role so the role rate prices them.
    INSERT INTO public.labour_rates (user_id, role, crew_class, location_id, hourly_rate, effective_from) VALUES
      ('${TECH}', NULL, NULL, NULL, 30, '2026-01-01'),
      (NULL, 'crew', NULL, NULL, 20, '2026-01-01'),
      (NULL, NULL, 'gsr', '${LOC}', 25, '2026-01-01');
  `);

  /* ---- 1. one of every cost source on the job ------------------------ */
  await db.exec(`
    -- Drying log: a dehumidifier at $65/day, on site Mon 9/14 through Wed
    -- 9/16 (3 days = $195), and an air mover with no rate (0, but counted).
    -- A second, priced air mover exists in the catalogue at $25/day so the
    -- type has a rate for tickets.
    INSERT INTO public.equipment VALUES
      ('${DEHU}', 'dehumidifier', 6500), ('${FAN_UNPRICED}', 'air_mover', NULL),
      ('${AIR_MOVER_PRICED}', 'air_mover', 2500);
    INSERT INTO public.equipment_placements (job_id, equipment_id, placed_at, retrieved_at) VALUES
      ('${JOB}', '${DEHU}', '2026-09-14 09:00+00', '2026-09-16 17:00+00'),
      ('${JOB}', '${FAN_UNPRICED}', '2026-09-14 09:00+00', '2026-09-14 17:00+00');

    -- Field tickets.
    --   Monday: saved by the crew, so no cost line. 2 GSR + 1 TEMP for 4h,
    --   one dehumidifier and three air movers. Priced here: GSR 8 man-h ×
    --   $25 = $200; TEMP 4 man-h uncosted; machines 1 × $65 + 3 × $25 = $140.
    --   Tuesday: saved from the office, so the app filed its line: $400
    --   labour and $90 equipment, taken as filed.
    --   Wednesday: times do not parse; a crew of 3 with nothing to price.
    INSERT INTO public.field_work_tickets
      (id, job_id, location_id, work_date, job_start_time, job_end_time, gsr_crew_size, temp_crew_size,
       equip_dehumidifier, equip_air_mover) VALUES
      ('${TICKET_MON}', '${JOB}', '${LOC}', '2026-09-14', '08:00', '12:00', 2, 1, 1, 3),
      ('${TICKET_TUE}', '${JOB}', '${LOC}', '2026-09-15', '08:00', '16:00', 2, 0, 1, 0),
      ('${TICKET_WED}', '${JOB}', '${LOC}', '2026-09-16', NULL, NULL, 3, 0, 0, 0);
    INSERT INTO public.job_cost_lines
      (job_id, work_component, direct_cost, equipment_cost, equipment_days, field_work_ticket_id) VALUES
      ('${JOB}', 'Field work', 400, 90, 1, '${TICKET_TUE}');

    -- Time clock: TECH clocked 3h on Monday and 2h on Tuesday (both dates
    -- have ticket labour, so both are superseded) and 2h on Wednesday
    -- (counts: 2 × $30 = $60). TECH_NO_RATE clocked 1h on Wednesday at the
    -- crew role rate ($20). A rejected entry never counts.
    INSERT INTO public.time_entries (job_id, user_id, work_date, minutes, status) VALUES
      ('${JOB}', '${TECH}', '2026-09-14', 180, 'approved'),
      ('${JOB}', '${TECH}', '2026-09-15', 120, 'approved'),
      ('${JOB}', '${TECH}', '2026-09-16', 120, 'submitted'),
      ('${JOB}', '${TECH_NO_RATE}', '2026-09-16', 60, 'submitted'),
      ('${JOB}', '${TECH}', '2026-09-16', 600, 'rejected');

    -- Supplies: 4 gallons of antimicrobial at $12.50 = $50 on a request; a
    -- denied request for 100 more does not count; 2 more taken off the shelf
    -- for the job = $25 (a delivery INTO stock on this job's request is +qty
    -- and is not a use).
    INSERT INTO public.supply_items VALUES ('${ITEM}', 12.50);
    INSERT INTO public.supply_requests VALUES ('${SUPPLY_REQ}', '${JOB}', 'approved'),
                                              ('${DENIED_REQ}', '${JOB}', 'denied');
    INSERT INTO public.supply_request_lines (request_id, item_id, quantity) VALUES
      ('${SUPPLY_REQ}', '${ITEM}', 4), ('${DENIED_REQ}', '${ITEM}', 100);
    INSERT INTO public.supply_stock_moves (location_id, item_id, qty, reason, job_id) VALUES
      ('${LOC}', '${ITEM}', -2, 'used_on_job', '${JOB}'),
      ('${LOC}', '${ITEM}', 10, 'delivery', '${JOB}'),
      ('${LOC}', '${ITEM}', -7, 'used_on_job', '${OTHER_JOB}');

    -- A cost line somebody typed: $100 direct, $40 materials, $300 subs,
    -- $80 equipment (a rented pump). Labour is not a box on that form.
    INSERT INTO public.job_cost_lines (job_id, work_component, revenue, direct_cost, materials_cost, subcontractor_cost, equipment_cost)
      VALUES ('${JOB}', 'mitigation', 0, 100, 40, 300, 80);

    -- Expenses: a $75 card charge on the job; a $500 approved REQUEST that
    -- nobody has spent yet; a $999 charge on another job.
    INSERT INTO public.expenses (job_id, user_id, amount, kind) VALUES
      ('${JOB}', '${REP}', 75, 'company_card'), ('${OTHER_JOB}', '${REP}', 999, 'company_card');
    INSERT INTO public.expense_requests (job_id, amount, status) VALUES ('${JOB}', 500, 'approved');

    -- Referral: $150 paid to the source.
    INSERT INTO public.job_referral_costs (job_id, amount) VALUES ('${JOB}', 150);

    -- Calculator: two results, the newer projects $1,000 of internal cost.
    INSERT INTO public.job_calculations (job_id, job_date, customer_price, internal_cost) VALUES
      ('${JOB}', '2026-09-14', 8365, 5000), ('${JOB}', '2026-09-16', 1470, 1000);

    -- Estimates as on Mark's screen: ESTIMATE-1 $872, then two empty drafts.
    INSERT INTO public.estimates (job_id, seq, status, total) VALUES
      ('${JOB}', 1, 'draft', 872), ('${JOB}', 2, 'draft', 0), ('${JOB}', 3, 'draft', 0);
  `);

  const runningCost = async (uid) => {
    await db.query(`SELECT set_config('test.uid', '${uid}', false)`);
    const r = await db.query(`SELECT * FROM public.job_running_cost('${JOB}')`);
    return r.rows;
  };

  let rows = await runningCost(OWNER);
  eq(rows.length, 1, "an owner gets the job's row");
  let c = rows[0];

  /* ---- drying log ---------------------------------------------------- */
  eq(money(c.equipment_cost), 195, "equipment: 3 days × $65 for the priced unit");
  eq(c.equipment_units, 2, "both placements are units");
  eq(c.equipment_unpriced_units, 1, "the unpriced air mover is called out, not hidden");
  eq(c.equipment_days, 4, "3 dehu days + 1 fan day");

  /* ---- 3. field tickets ---------------------------------------------- */
  eq(c.field_tickets, 3, "three tickets on the job");
  eq(c.field_tickets_unposted, 2, "two of them have no cost line and are priced here");
  eq(
    money(c.field_ticket_labour_cost),
    400 + 200,
    "ticket labour: Tuesday as filed + Monday's 2 GSR × 4h × $25",
  );
  eq(
    money(c.field_ticket_equipment_cost),
    90 + 140,
    "ticket machines: Tuesday as filed + Monday's 1 × $65 + 3 × $25",
  );
  eq(money(c.field_ticket_cost), 490 + 340, "field tickets, all in");
  eq(
    Number(c.field_ticket_uncosted_minutes),
    240,
    "the TEMP crew's 4h have no rate and are reported, not $0",
  );

  /* ---- 4. the time clock, superseded where a ticket priced the day --- */
  eq(money(c.labour_cost), 80, "clock on Wednesday only: 2h × $30 + 1h × $20 (role rate)");
  eq(
    Number(c.labour_minutes),
    180,
    "Monday's and Tuesday's clock entries are superseded by their tickets",
  );
  eq(Number(c.labour_uncosted_minutes), 0, "every counted clock entry found a rate");

  /* ---- the rest ------------------------------------------------------ */
  eq(money(c.materials_cost), 50, "supplies: 4 × $12.50, the denied request ignored");
  eq(
    money(c.stock_used_cost),
    25,
    "stock used on the job: 2 × $12.50; the delivery and the other job's use are not",
  );
  eq(money(c.subcontractor_cost), 300, "subs from the typed cost line, in their own column");
  eq(
    money(c.manual_cost),
    220,
    "manual: direct 100 + materials 40 + equipment 80 — the ticket's line is not in it",
  );
  eq(
    money(c.expenses_cost),
    75,
    "expenses: the charge on this job; the request and the other job's charge are not",
  );
  eq(c.expenses_count, 1, "one expense row");
  eq(money(c.referral_cost), 150, "referral cost line");
  eq(money(c.calculator_cost), 1000, "the newest calculator result's internal cost");

  const counted = 195 + 80 + 830 + 50 + 25 + 300 + 75 + 150 + 220;
  eq(money(c.total_cost), counted, "total is the sum of the counted columns");
  check(money(c.total_cost) < counted + 1000, "the calculator projection is NOT in the total");

  /* ---- 6. the revenue ladder ----------------------------------------- */
  eq(money(c.revenue), 872, "with only drafts, the newest PRICED draft wins — not the $0 ones");
  eq(c.revenue_basis, "estimate_draft", "and the basis says it is a draft");
  eq(money(c.margin), 872 - counted, "margin against that revenue");

  await db.query(`UPDATE public.estimates SET status = 'sent', total = 900 WHERE seq = 2`);
  c = (await runningCost(OWNER))[0];
  eq(money(c.revenue), 900, "a sent estimate beats a draft");
  eq(c.revenue_basis, "estimate_sent", "basis: sent");

  await db.query(`UPDATE public.estimates SET status = 'sent', total = 950 WHERE seq = 3`);
  c = (await runningCost(OWNER))[0];
  eq(money(c.revenue), 950, "two sent estimates: the newest one, not the sum");

  await db.query(`UPDATE public.jobs SET agreed_price = 1200 WHERE id = '${JOB}'`);
  c = (await runningCost(OWNER))[0];
  eq(money(c.revenue), 1200, "the cash job's agreed price beats a sent estimate");
  eq(c.revenue_basis, "agreed_price", "basis: agreed price");

  await db.query(`UPDATE public.estimates SET status = 'approved' WHERE seq IN (1, 2)`);
  c = (await runningCost(OWNER))[0];
  eq(money(c.revenue), 872 + 900, "approved estimates are summed and beat the agreed price");
  eq(c.revenue_basis, "estimate", "basis: approved estimate");

  await db.query(
    `INSERT INTO public.invoices (job_id, status, billed_amount, approved_amount) VALUES
       ('${JOB}', 'draft', 5000, NULL), ('${JOB}', 'sent', 2000, 1800)`,
  );
  c = (await runningCost(OWNER))[0];
  eq(
    money(c.revenue),
    1800,
    "a non-draft invoice beats everything; approved amount over billed; drafts ignored",
  );
  eq(c.revenue_basis, "invoice", "basis: invoice");

  /* ---- 4b. dismissing Monday's lines hands the day back to the clock -- */
  await db.query(
    `INSERT INTO public.field_ticket_crew_reviews (ticket_id, crew_class, review_state) VALUES
       ('${TICKET_MON}', 'gsr', 'dismissed'), ('${TICKET_MON}', 'temp', 'dismissed')`,
  );
  c = (await runningCost(OWNER))[0];
  eq(
    money(c.field_ticket_labour_cost),
    400,
    "dismissed form lines are not money; Tuesday's filed line stands",
  );
  eq(money(c.labour_cost), 80 + 90, "…and Monday's 3h × $30 clock entry now counts");
  eq(
    Number(c.field_ticket_uncosted_minutes),
    0,
    "nothing uncosted once the TEMP line is dismissed",
  );

  // An office override on the crew size is honoured.
  await db.query(
    `UPDATE public.field_ticket_crew_reviews SET review_state = 'accepted', headcount_override = 3
      WHERE ticket_id = '${TICKET_MON}' AND crew_class = 'gsr'`,
  );
  c = (await runningCost(OWNER))[0];
  eq(
    money(c.field_ticket_labour_cost),
    400 + 300,
    "3 GSR × 4h × $25 with the office's headcount override",
  );
  eq(money(c.labour_cost), 80, "Monday's clock entry is superseded again");

  // Once the app files Monday's line, that line is the ticket's cost and the
  // function stops pricing the ticket itself.
  await db.query(
    `INSERT INTO public.job_cost_lines (job_id, work_component, direct_cost, equipment_cost, field_work_ticket_id)
     VALUES ('${JOB}', 'Field work', 250, 100, '${TICKET_MON}')`,
  );
  c = (await runningCost(OWNER))[0];
  eq(c.field_tickets_unposted, 1, "only Wednesday's ticket is still unposted");
  eq(
    money(c.field_ticket_cost),
    490 + 350,
    "the posted line replaces the function's own pricing of that ticket",
  );
  eq(money(c.labour_cost), 80, "Monday's clock stays superseded — the line carries labour");

  /* ---- 7. the finance gate ------------------------------------------- */
  rows = await runningCost(REP);
  eq(rows.length, 0, "a rep gets no row — not zeros, and not the revenue");
  rows = await runningCost("");
  eq(rows.length, 0, "no session, no row");

  /* ---- 8. the overview reports the same figure ------------------------ */
  c = (await runningCost(OWNER))[0];
  const ov = await db.query(`SELECT * FROM public.running_cost_overview(NULL, 8)`);
  const mine = ov.rows.find((r) => r.job_id === JOB);
  check(!!mine, "the job is in the overview");
  eq(money(mine.total_cost), money(c.total_cost), "overview total = per-job total");
  eq(money(mine.revenue), money(c.revenue), "overview revenue = per-job revenue");
  await db.query(`SELECT set_config('test.uid', '${REP}', false)`);
  const ovRep = await db.query(`SELECT * FROM public.running_cost_overview(NULL, 8)`);
  eq(ovRep.rows.length, 0, "the overview is gated the same way");

  console.log(`running-cost-all-sources.pglite: ${assertions} assertions passed`);
} finally {
  await db.close();
}
