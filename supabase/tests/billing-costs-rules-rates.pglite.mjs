// Run with: node supabase/tests/billing-costs-rules-rates.pglite.mjs <existing PGlite dist/index.js>
// In-memory fixtures only. No connection string, network access or live writes.
//
// Billing & Costs, prompt 2 (migration 20261030120000, READ FROM THE FILE),
// on top of the real T&M and prompt-1 migrations it builds on.
//
// What it proves:
//   1. every priced T&M code resolves, through the new store, to exactly its
//      old rate; equipment types take the active default catalog price;
//   2. office resolution: an office override wins at that office only, from
//      its date; "reset" hands the office back to the default; the bill's
//      resolver reads the job's office (billing_location_id, else
//      location_id) as of the job's creation date; a job's own sheet wins;
//      new jobs snapshot their office's rate; history cannot be removed;
//   3. tm_rates_save: admins only, today or later, a default always has a
//      rate, same-day edits replace (both audited), all-or-nothing;
//   4. charge rates are readable by staff, cost measures are not;
//   5. General rules: seeded from the old Settings (Small Tools from the
//      GEN- code when the rule was blank, both OT rules → legacy_both, tax
//      carried untouched), five standard charges; billing_rules_save edits
//      rules, adds and archives charges, refuses tax and duplicate names,
//      keeps standard charges' type, writes the margin beside 'finance' and
//      audits every field with the note;
//   6. catalog: per-gallon / square-foot lines take gal / sqft, the "How it
//      bills" note is carried and mirrored both ways;
//   7. equipment codes map onto module types only when unambiguous.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const read = (f) => readFileSync(new URL("../migrations/" + f, import.meta.url), "utf8");
const MIGRATIONS = [
  "20261007230000_tm_rate_codes.sql",
  "20261026140000_tm_rate_code_rates.sql",
  "20261027160000_tm_rate_catalog_costs.sql",
  "20261027161000_job_tm_rates.sql",
  "20261029120000_billing_costs_foundation.sql",
];
const P2 = read("20261030120000_billing_costs_rules_and_tm_rates.sql");

let assertions = 0;
const check = (value, what) => {
  assert.equal(value, true, what);
  assertions++;
};
const eq = (actual, expected, what) => {
  assert.deepEqual(actual, expected, what);
  assertions++;
};
const refuses = async (promise, pattern, what) => {
  await assert.rejects(promise, pattern, what);
  assertions++;
};

const admin = "11111111-1111-4111-8111-111111111111";
const crew = "22222222-2222-4222-8222-222222222222";
const ny = "aaaaaaaa-0000-4000-8000-00000000000a";
const nj = "bbbbbbbb-0000-4000-8000-00000000000b";
const oldJob = "cccccccc-0000-4000-8000-00000000000c";

const db = new PGlite();
try {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; CREATE SCHEMA goldstar_private;
    GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
    GRANT USAGE ON SCHEMA goldstar_private TO authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
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
      $$ SELECT EXISTS (SELECT 1 FROM public.user_roles
                         WHERE user_id = _user_id AND role IN ('owner', 'admin', 'dev')) $$;
    GRANT EXECUTE ON FUNCTION public.is_privileged(uuid) TO authenticated;
    CREATE FUNCTION public.can_view_finance(_user_id uuid)
      RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
    CREATE FUNCTION public.has_permission(_user_id uuid, _key text, _location_id uuid DEFAULT NULL)
      RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
    CREATE FUNCTION public.can_view_job(_user_id uuid, _job_id uuid)
      RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT _user_id IS NOT NULL $$;
    CREATE FUNCTION public.can_view_job_costs(_job_id uuid)
      RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT public.is_privileged(auth.uid()) $$;

    CREATE TABLE public.locations (id uuid PRIMARY KEY, name text);
    CREATE TABLE public.jobs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid,
      billing_location_id uuid, created_at timestamptz NOT NULL DEFAULT now());
    GRANT SELECT, INSERT ON public.jobs TO authenticated;
    CREATE TABLE public.job_tm_forms (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid, kind text, payload jsonb);
    CREATE TABLE public.estimate_catalog_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text, default_unit_price numeric,
      is_active boolean NOT NULL DEFAULT true);
    INSERT INTO public.estimate_catalog_items (code, default_unit_price, is_active) VALUES
      ('GSC-EQ-AIR-MOVER', 45, true), ('GSC-EQ-DEHUMIDIFIER', 150, false),
      ('gsc-eq-scrubber-xl', 200, true);
    CREATE TABLE public.app_settings (
      key text PRIMARY KEY, value jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid);
    INSERT INTO public.app_settings VALUES
      ('tm.bill_rules', '{"perDiemPerPersonDay": 50, "opPercent": 15, "standardStart": "08:00",
        "standardEnd": "17:00", "dailyOtAfterHours": 8, "taxPercent": 8.875,
        "taxableCategories": ["materials"], "holidays": ["2026-12-25"], "ohFeePercent": 2.5}', now(), NULL),
      ('finance', '{"margin_threshold_pct": 30, "other": "kept"}', now(), NULL);

    INSERT INTO public.profiles VALUES ('${admin}', true), ('${crew}', true);
    INSERT INTO public.user_roles VALUES ('${admin}', 'admin'), ('${crew}', 'crew');
    INSERT INTO public.locations VALUES ('${ny}', 'Brooklyn'), ('${nj}', 'Lakewood');
    -- A job made long before the rebuild, in NJ, with no frozen sheet.
    INSERT INTO public.jobs (id, location_id, created_at) VALUES ('${oldJob}', '${nj}', '2026-01-15');
  `);
  for (const m of MIGRATIONS) await db.exec(read(m));
  await db.exec(`UPDATE public.tm_rate_codes SET unit_note = 'Billed per roll' WHERE code = '103'`);
  await db.exec(`DELETE FROM public.job_tm_rates WHERE job_id = '${oldJob}'`);

  await db.exec(P2);
  await db.exec(P2);
  check(true, "the migration applies twice without error");

  const as = async (uid, sql) => {
    await db.exec(`SET ROLE authenticated; SET request.jwt.claim.sub = '${uid ?? ""}'`);
    try {
      return await db.query(sql);
    } finally {
      await db.exec("RESET ROLE; SELECT set_config('request.jwt.claim.sub','',false)");
    }
  };
  const one = async (sql) => (await db.query(sql)).rows[0];
  const n = async (sql) => (await one(sql)).n;
  const resolve = async (key, office, on) => {
    const r = await one(
      `SELECT value, source FROM public.resolve_money_value('tm_rates', '${key}', 'bill_rate', ${office ? `'${office}'` : "NULL"}, ${on ? `'${on}'` : "current_date"})`,
    );
    return r ? [Number(r.value), r.source] : null;
  };
  const save = (uid, changes, note = "") =>
    as(uid, `SELECT public.tm_rates_save('${JSON.stringify(changes)}'::jsonb, '${note}') AS n`);
  const today = (await one(`SELECT current_date::text AS d`)).d;
  const tomorrow = (await one(`SELECT (current_date + 1)::text AS d`)).d;

  /* ---- 1: the seed ------------------------------------------------------ */
  const priced = await n(
    `SELECT count(*)::int AS n FROM public.tm_rate_codes WHERE rate IS NOT NULL`,
  );
  check(priced > 20, "the old book has priced codes to carry");
  eq(
    await n(`SELECT count(*)::int AS n FROM public.tm_rate_codes t
              WHERE t.rate IS NOT NULL
                AND (SELECT value FROM public.resolve_money_value('tm_rates', t.code, 'bill_rate', '${nj}', '2001-06-01'))
                    IS DISTINCT FROM t.rate`),
    0,
    "every priced code resolves to its old rate, at any office, back to 2001",
  );
  eq(
    await n(`SELECT count(*)::int AS n FROM public.money_values WHERE item_key NOT LIKE 'EQ:%'`),
    priced,
    "one default row per priced code — and none added by the re-run",
  );
  eq(await resolve("EQ:air_mover", ny), [45, "default"], "air mover takes the catalog price");
  eq(await resolve("EQ:air_scrubber", ny), [200, "default"], "matched case-insensitively");
  eq(await resolve("EQ:dehumidifier", ny), null, "a retired catalog item seeds nothing");

  /* ---- 2/3: office-aware edits ------------------------------------------ */
  await refuses(
    save(crew, [{ op: "rate", item_key: "GL", office_id: nj, value: 65 }]),
    /Only an administrator/,
    "crew cannot save",
  );
  await refuses(
    save(admin, [{ op: "rate", item_key: "GL", office_id: null, value: null }]),
    /needs a rate/,
    "a default always has a rate",
  );
  await refuses(
    save(admin, [
      { op: "rate", item_key: "GL", office_id: nj, value: 65, effective_from: "2020-01-01" },
    ]),
    /today or later/,
    "no back-dating",
  );
  await refuses(
    save(admin, [{ op: "rate", item_key: "GL", office_id: nj, value: 65.555 }]),
    /dollars and cents/,
    "cents only",
  );
  await refuses(
    save(admin, [{ op: "rate", item_key: "NOPE", office_id: nj, value: 1 }]),
    /No T&M item/,
    "unknown item",
  );
  await refuses(
    save(admin, [
      { op: "rate", item_key: "SCL", office_id: nj, value: 90 },
      { op: "rate", item_key: "GL", office_id: null, value: null },
    ]),
    /needs a rate/,
    "one bad change refuses the whole save",
  );
  eq(await resolve("SCL", nj), [88, "default"], "…and nothing from it lands");

  await save(
    admin,
    [{ op: "rate", item_key: "GL", office_id: nj, value: 64, effective_from: today }],
    "first try",
  );
  await save(
    admin,
    [{ op: "rate", item_key: "GL", office_id: nj, value: 65, effective_from: today }],
    "NJ agreement",
  );
  eq(await resolve("GL", nj), [65, "office"], "NJ reads its override");
  eq(await resolve("GL", ny), [70, "default"], "NY keeps the default");
  eq(
    await n(
      `SELECT count(*)::int AS n FROM public.money_values WHERE item_key = 'GL' AND office_id = '${nj}'`,
    ),
    1,
    "a same-day edit replaces, it does not stack",
  );
  eq(
    (
      await db.query(`SELECT field, old_value, new_value, note FROM public.money_audit_log
                      WHERE entity = 'money_value' AND entity_key = 'GL' AND office_id = '${nj}' ORDER BY id`)
    ).rows.map((r) => [r.old_value?.value ?? null, r.new_value?.value ?? null, r.note]),
    [
      [null, 64, "first try"],
      [64, null, "NJ agreement"],
      [null, 65, "NJ agreement"],
    ],
    "the replaced value and the new one are both on record",
  );

  // New jobs freeze their office's rate; billing_location_id wins over location_id.
  const njJob = (
    await one(
      `INSERT INTO public.jobs (location_id, billing_location_id) VALUES ('${ny}', '${nj}') RETURNING id`,
    )
  ).id;
  const nyJob = (await one(`INSERT INTO public.jobs (location_id) VALUES ('${ny}') RETURNING id`))
    .id;
  const frozen = async (job) =>
    Number(
      (await one(`SELECT rate FROM public.job_tm_rates WHERE job_id = '${job}' AND code = 'GL'`))
        .rate,
    );
  eq(await frozen(njJob), 65, "a job billed from NJ freezes NJ's rate");
  eq(await frozen(nyJob), 70, "a NY job freezes the default");

  // A later default change reaches neither of them, nor the old job.
  await save(admin, [
    { op: "rate", item_key: "GL", office_id: null, value: 75, effective_from: tomorrow },
  ]);
  const billRate = async (job, key = "GL") => {
    const r = (
      await as(
        admin,
        `SELECT rate, source FROM public.tm_bill_rates('${job}') WHERE item_key = '${key}'`,
      )
    ).rows[0];
    return r ? [r.rate == null ? null : Number(r.rate), r.source] : null;
  };
  eq(await billRate(njJob), [65, "job"], "the NJ job bills its frozen rate");
  eq(
    await billRate(oldJob),
    [70, "default"],
    "an old job with no sheet reads the rate in force when it was made",
  );
  eq(await resolve("GL", ny, tomorrow), [75, "default"], "the new default takes effect tomorrow");
  eq(
    await billRate(oldJob, "EQ:air_mover"),
    [45, "default"],
    "equipment types resolve through the same function",
  );

  // Reset to default.
  await save(admin, [{ op: "rate", item_key: "SCL", office_id: nj, value: 92 }]);
  eq(await resolve("SCL", nj), [92, "office"], "an override");
  await save(admin, [
    { op: "rate", item_key: "SCL", office_id: nj, value: null, effective_from: tomorrow },
  ]);
  eq(
    await resolve("SCL", nj, tomorrow),
    [88, "default"],
    "reset hands the office back to the default",
  );
  eq(await resolve("SCL", nj), [92, "office"], "…from its date, not before");

  await refuses(
    db.query(`DELETE FROM public.money_values WHERE effective_from < current_date`),
    /history/,
    "history cannot be removed",
  );
  await refuses(
    as(
      admin,
      `INSERT INTO public.money_values (book, item_key, measure, effective_from, value) VALUES ('tm_rates','GL','bill_rate', current_date + 5, 1)`,
    ),
    /permission denied/,
    "only through the save",
  );

  await save(admin, [{ op: "small_tools", code: "GL", on: false }]);
  check(
    (await one(`SELECT small_tools FROM public.tm_rate_codes WHERE code = 'GL'`)).small_tools ===
      false,
    "Small Tools switch saves",
  );
  await refuses(
    save(admin, [{ op: "small_tools", code: "100", on: false }]),
    /No labor code/,
    "only on labor",
  );

  /* ---- 4: who reads what ------------------------------------------------ */
  await db.exec(
    `INSERT INTO public.money_values (book, item_key, measure, effective_from, value) VALUES ('cost', 'GL', 'cost_rate', '2001-01-01', 40)`,
  );
  const seen = (await as(crew, `SELECT measure FROM public.money_values`)).rows.map(
    (r) => r.measure,
  );
  check(
    seen.includes("bill_rate") && !seen.includes("cost_rate"),
    "staff read charge rates, never costs",
  );

  /* ---- 5: General rules ------------------------------------------------- */
  const rules = await one(`SELECT * FROM public.billing_general_rules`);
  eq(rules.overtime_mode, "legacy_both", "a Settings with both OT rules is carried as legacy_both");
  eq(
    [rules.standard_start, rules.standard_end, Number(rules.daily_ot_after_hours)],
    ["08:00", "17:00", 8],
    "window and threshold carried",
  );
  eq(Number(rules.legacy_tax_percent), 8.875, "tax carried untouched");
  eq(rules.legacy_taxable_categories, ["materials"], "taxable categories carried");
  eq(
    rules.holidays.map((d) => new Date(d).toISOString().slice(0, 10)),
    ["2026-12-25"],
    "holidays carried",
  );
  const charge = async (key) => one(`SELECT * FROM public.billing_charges WHERE key = '${key}'`);
  eq(
    Number((await charge("small_tools")).value),
    3,
    "Small Tools from the GEN- code when the rule was blank",
  );
  eq(Number((await charge("per_diem")).value), 50, "Per Diem from the rule over the GEN- code");
  eq(Number((await charge("op")).value), 15, "O&P carried");
  eq(Number((await charge("pass_through")).value), 20, "pass-through default");
  eq(Number((await charge("oh_fee")).value), 2.5, "OH fee carried");

  const rsave = (uid, r, c = [], note = "") =>
    as(
      uid,
      `SELECT public.billing_rules_save('${JSON.stringify(r)}'::jsonb, '${JSON.stringify(c)}'::jsonb, '${note}') AS n`,
    );
  await refuses(
    rsave(crew, { overtime_mode: "none" }),
    /Only an administrator/,
    "crew cannot change rules",
  );
  await refuses(
    rsave(admin, { legacy_tax_percent: 0 }),
    /cannot change legacy_tax_percent/,
    "tax is not editable here",
  );
  await refuses(
    rsave(admin, { overtime_mode: "daily", daily_ot_after_hours: null }),
    /daily_needs_hours/,
    "daily mode needs its hours",
  );
  await rsave(
    admin,
    {
      overtime_mode: "weekly",
      weekly_ot_after_hours: 40,
      holidays: ["2026-12-25", "2027-01-01"],
      minimum_margin_percent: 35,
    },
    [
      {
        op: "create",
        name: "Fuel Surcharge",
        kind: "flat_bill",
        value: 25,
        lands_on: "other_fees",
      },
      { op: "update", key: "small_tools", value: 3.5 },
    ],
    "Weekly OT from Nov",
  );
  eq(
    (await one(`SELECT overtime_mode FROM public.billing_general_rules`)).overtime_mode,
    "weekly",
    "mode saved",
  );
  eq(Number((await charge("small_tools")).value), 3.5, "a standard charge's value moves");
  const fuel = await one(`SELECT * FROM public.billing_charges WHERE name = 'Fuel Surcharge'`);
  check(
    fuel?.key === "c_fuel_surcharge" && Number(fuel.value) === 25 && !fuel.system,
    "a charge is added",
  );
  eq(
    (await one(`SELECT value FROM public.app_settings WHERE key = 'finance'`)).value,
    { margin_threshold_pct: 35, other: "kept" },
    "the margin is written beside the other finance settings",
  );
  await refuses(
    rsave(admin, {}, [
      { op: "create", name: "fuel surcharge", kind: "flat_bill", value: 1, lands_on: "other_fees" },
    ]),
    /already exists/,
    "duplicate charge names refused",
  );
  await refuses(
    rsave(admin, {}, [{ op: "update", key: "small_tools", archived: true }]),
    /cannot be archived/,
    "a standard charge is never archived",
  );
  await refuses(
    rsave(admin, {}, [{ op: "update", key: "op", kind: "flat_bill" }]),
    /keeps its type/,
    "…nor retyped",
  );
  await refuses(
    rsave(admin, {}, [
      { op: "create", name: "Bad", kind: "pct_subtotal", value: 5, lands_on: "materials" },
    ]),
    /subtotal_lands_below/,
    "a % of the subtotal lands under it",
  );
  await rsave(admin, {}, [{ op: "update", key: "c_fuel_surcharge", archived: true }]);
  check((await charge("c_fuel_surcharge")).archived_at !== null, "an added charge archives");
  const notes = (
    await db.query(`SELECT entity, field, note FROM public.money_audit_log
                                  WHERE book = 'general_rules' AND note = 'Weekly OT from Nov' ORDER BY id`)
  ).rows;
  const fields = notes.map((r) => `${r.entity}.${r.field}`);
  check(
    [
      "general_rules.overtime_mode",
      "general_rules.holidays",
      "billing_charge.created",
      "billing_charge.value",
      "general_rules.minimum_margin_percent",
    ].every((f) => fields.includes(f)),
    "every field change is on record with the note",
  );

  /* ---- 6: catalog ------------------------------------------------------- */
  const cat = (code) =>
    one(`SELECT unit, unit_review, note FROM public.catalog_items WHERE code = '${code}'`);
  eq(await cat("126"), { unit: "gal", unit_review: null, note: null }, "per-gallon line takes gal");
  eq((await cat("152")).unit, "sqft", "square-foot line takes sqft");
  eq((await cat("103")).note, "Billed per roll", "the old note is carried");
  await as(
    admin,
    `SELECT public.catalog_save('[{"op":"update","code":"103","note":"Per roll, 100 ft"}]'::jsonb, 'note')`,
  );
  eq(
    (await one(`SELECT unit_note FROM public.tm_rate_codes WHERE code = '103'`)).unit_note,
    "Per roll, 100 ft",
    "a catalog note reaches the old book",
  );
  await as(admin, `UPDATE public.tm_rate_codes SET unit_note = 'Per roll' WHERE code = '103'`);
  eq((await cat("103")).note, "Per roll", "…and the old page's reaches the catalog");

  /* ---- 7: equipment mapping -------------------------------------------- */
  const eqType = async (code) => {
    const r = await one(
      `SELECT equipment_type, equipment_type_review FROM public.tm_rate_codes WHERE code = '${code}'`,
    );
    return [r.equipment_type, r.equipment_type_review !== null];
  };
  eq(await eqType("302"), ["air_mover", false], "air mover code maps");
  eq(await eqType("313"), ["dehumidifier", false], "dehumidifier code maps");
  eq(await eqType("304"), ["air_scrubber", false], "2000 CFM scrubber maps");
  eq(await eqType("305"), [null, true], "a HEPA scrubber is asked about, not guessed");
  eq(await eqType("327"), [null, true], "a power cable is not a generator");
  eq(await eqType("326"), ["generator", false], "a generator maps");
} finally {
  await db.close();
}

console.log(`billing-costs-rules-rates.pglite: ${assertions} assertions passed`);
