// Run with: node supabase/tests/fleet-overhead.pglite.mjs <existing PGlite dist/index.js>
// In-memory fixtures only. No connection string, network access or live writes.
//
// Migrations 20261109140000 + 20261109150000 (READ FROM THE FILES): a
// vehicle's insurance, finance and maintenance reach the overhead engine as
// three read-only components, per hour by the Year unit, logged as dated
// values with a note, and an unchanged total writes nothing.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
const read = (f) => readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8");

await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE SCHEMA auth; CREATE SCHEMA goldstar_private;
  CREATE TABLE auth.users (id uuid PRIMARY KEY);
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
  CREATE FUNCTION goldstar_private.profile_is_active(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
  CREATE FUNCTION public.can_view_vehicle(uuid, uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
  CREATE FUNCTION public.can_manage_vehicle(uuid, uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
  CREATE FUNCTION public.tg_touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

  CREATE TABLE public.vehicles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), label text);
  CREATE TABLE public.vehicle_maintenance_records (
    id serial PRIMARY KEY, vehicle_id uuid REFERENCES public.vehicles(id) ON DELETE CASCADE,
    performed_on date NOT NULL, cost numeric
  );
  CREATE TABLE public.overhead_units (key text PRIMARY KEY, hours numeric NOT NULL);
  INSERT INTO public.overhead_units VALUES ('hour', 1), ('year', 2080);
  CREATE TABLE public.overhead_components (
    key text PRIMARY KEY, name text, note text, system boolean DEFAULT false,
    sort_order int, unit_key text DEFAULT 'hour', archived_at timestamptz
  );
  INSERT INTO public.overhead_components (key, name, sort_order) VALUES
    ('wage', 'Wage', 10), ('c_vehicles', 'Vehicles', 60);
  CREATE TABLE public.money_values (
    id serial PRIMARY KEY, book text, item_key text, measure text, office_id uuid,
    effective_from date, value numeric, note text
  );
  CREATE TABLE public.audit (item_key text, measure text, value numeric, effective_from date, note text);
  CREATE FUNCTION public.tg_audit() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN INSERT INTO public.audit VALUES (NEW.item_key, NEW.measure, NEW.value, NEW.effective_from, NEW.note); RETURN NEW; END $$;
  CREATE TRIGGER money_values_audit AFTER INSERT ON public.money_values FOR EACH ROW EXECUTE FUNCTION public.tg_audit();
  CREATE FUNCTION public.resolve_money_value(_book text, _item text, _measure text, _office uuid, _on date)
  RETURNS TABLE (value numeric, source text, effective_from date) LANGUAGE sql AS $$
    SELECT v.value, 'default', v.effective_from FROM public.money_values v
     WHERE v.book = _book AND v.item_key = _item AND v.measure = _measure
       AND v.office_id IS NULL AND v.effective_from <= _on
     ORDER BY v.effective_from DESC LIMIT 1 $$;
  CREATE TABLE public.refills (d date);
  CREATE FUNCTION public.overhead_refill_from(_from date) RETURNS integer LANGUAGE sql AS $$
    INSERT INTO public.refills VALUES (_from); SELECT 1 $$;
  INSERT INTO public.vehicles (label) VALUES ('Van 1'), ('Van 2'), ('Truck');
`);
await db.exec(read("20261109140000_vehicle_costs.sql"));
await db.exec(read("20261109150000_fleet_overhead.sql"));

const q = async (sql, p) => (await db.query(sql, p)).rows;
const at = async (k, m = "cost_hr") =>
  (
    await q(
      `SELECT value::float AS v FROM money_values WHERE item_key = $1 AND measure = $2 ORDER BY id DESC LIMIT 1`,
      [k, m],
    )
  )[0]?.v;

// The components exist, by the Year unit; the empty Vehicles one is archived.
const comps = await q(
  `SELECT key, unit_key, archived_at FROM overhead_components ORDER BY sort_order`,
);
assert.deepEqual(
  comps.filter((c) => c.key.startsWith("fleet_")).map((c) => `${c.key}:${c.unit_key}`),
  ["fleet_finance:year", "fleet_insurance:year", "fleet_maintenance:year"],
);
assert.ok(comps.find((c) => c.key === "c_vehicles").archived_at);
// Synced once at migration time: all zero.
assert.equal(await at("fleet_insurance"), 0);

const [v1, v2, v3] = (await q(`SELECT id FROM vehicles ORDER BY label`)).map((r) => r.id);
// Truck: insured $2,080 a year, owned. Van 1: $100 a month insurance, financed $500 a month.
// Van 2: leased $2,080 a year.
await db.exec(`
  INSERT INTO vehicle_costs (vehicle_id, insurance_amount, insurance_period, ownership, finance_amount, finance_period) VALUES
    ('${v3}', 2080, 'yearly', 'owned', 999, 'monthly'),
    ('${v1}', 100, 'monthly', 'financed', 500, 'monthly'),
    ('${v2}', NULL, 'yearly', 'leased', 2080, 'yearly');
`);
assert.equal(await at("fleet_insurance", "amount_year"), 2080 + 1200);
assert.equal(await at("fleet_insurance"), Math.round((3280 / 2080) * 100) / 100);
// The owned truck's finance figure is not counted.
assert.equal(await at("fleet_finance", "amount_year"), 6000 + 2080);
assert.equal(await at("fleet_finance"), Math.round((8080 / 2080) * 100) / 100);

// Logged with a note and today's date.
const log = await q(
  `SELECT note, effective_from = current_date AS today FROM audit WHERE item_key = 'fleet_finance' ORDER BY note DESC LIMIT 1`,
);
assert.match(
  log[0].note,
  /^From Fleet: vehicle finance and leases \$8,080\.00 a year across 2 vehicles$/,
);
assert.equal(log[0].today, true);

// Maintenance: the last 12 months only.
await db.exec(`
  INSERT INTO vehicle_maintenance_records (vehicle_id, performed_on, cost) VALUES
    ('${v1}', current_date - 10, 1040), ('${v2}', current_date - 400, 5000);
`);
assert.equal(await at("fleet_maintenance", "amount_year"), 1040);
assert.equal(await at("fleet_maintenance"), 0.5);

// A change that leaves the totals alone writes nothing new.
const before = (await q(`SELECT count(*)::int AS n FROM money_values`))[0].n;
await db.exec(`UPDATE vehicle_costs SET updated_by = NULL`);
assert.equal((await q(`SELECT count(*)::int AS n FROM money_values`))[0].n, before);

// Same-day edits replace today's row rather than stacking.
await db.exec(`UPDATE vehicle_costs SET insurance_amount = 3000 WHERE vehicle_id = '${v3}'`);
assert.equal(await at("fleet_insurance", "amount_year"), 4200);
assert.equal(
  (
    await q(
      `SELECT count(*)::int AS n FROM money_values WHERE item_key = 'fleet_insurance' AND measure = 'cost_hr' AND effective_from = current_date`,
    )
  )[0].n,
  1,
);

// Read only: nobody types a value for a fleet component.
await assert.rejects(
  db.exec(
    `INSERT INTO money_values (book, item_key, measure, effective_from, value) VALUES ('overhead', 'fleet_insurance', 'cost_hr', current_date, 9)`,
  ),
  /come from Fleet/,
);
// The auto-fill ran.
assert.ok((await q(`SELECT count(*)::int AS n FROM refills`))[0].n > 0);

await db.exec(read("20261109150000_fleet_overhead.sql")); // re-runnable
console.log("fleet-overhead: ok");
