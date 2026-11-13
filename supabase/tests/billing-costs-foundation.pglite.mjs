// Run with: node supabase/tests/billing-costs-foundation.pglite.mjs <existing PGlite dist/index.js>
// In-memory fixtures only. No connection string, network access or live writes.
//
// Billing & Costs, prompt 1 (migration 20261029120000, READ FROM THE FILE),
// applied on top of the real T&M rate code migrations it builds on.
//
// What it proves:
//   1. the catalog seed is the old book exactly: per category, per Active
//      flag, names unchanged; Equipment and General Charges are not seeded;
//      a second run changes nothing; a mismatch aborts the migration;
//   2. units come from the line's own words, else are carried AND flagged;
//      per-gallon / square-foot lines get no unit and a flag;
//   3. catalog_save: admins only, one transaction, a duplicate name (case and
//      spacing ignored) is refused naming the other item, codes are pinned,
//      nothing can be deleted;
//   4. the two books stay in step both ways (catalog ↔ tm_rate_codes), and
//      the old page keeps working exactly as before;
//   5. every change lands in money_audit_log with who and the note, and the
//      log cannot be updated, deleted or truncated — by anyone;
//   6. "used on N jobs" counts T&M sheets;
//   7. resolve_money_value: office override, else default, by date; an
//      office row with no value hands back to the default; values are never
//      edited.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const read = (f) => readFileSync(new URL("../migrations/" + f, import.meta.url), "utf8");
const TM_CODES = read("20261007230000_tm_rate_codes.sql");
const TM_RATES = read("20261026140000_tm_rate_code_rates.sql");
const TM_COSTS = read("20261027160000_tm_rate_catalog_costs.sql");
const FOUNDATION = read("20261029120000_billing_costs_foundation.sql");

let assertions = 0;
const check = (value, what) => {
  assert.equal(value, true, what);
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
const job1 = "cccccccc-0000-4000-8000-00000000000c";
const job2 = "dddddddd-0000-4000-8000-00000000000d";

const SETUP = `
  CREATE ROLE anon;
  CREATE ROLE authenticated;
  CREATE ROLE service_role BYPASSRLS;
  CREATE SCHEMA auth;
  CREATE SCHEMA goldstar_private;
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

  CREATE TABLE public.locations (id uuid PRIMARY KEY, name text);
  CREATE TABLE public.jobs (id uuid PRIMARY KEY, location_id uuid);
  CREATE TABLE public.job_tm_forms (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid, kind text, payload jsonb);

  INSERT INTO public.profiles VALUES ('${admin}', true), ('${crew}', true);
  INSERT INTO public.user_roles VALUES ('${admin}', 'admin'), ('${crew}', 'crew');
  INSERT INTO public.locations VALUES ('${ny}', 'Brooklyn'), ('${nj}', 'Lakewood');
  INSERT INTO public.jobs VALUES ('${job1}', '${ny}'), ('${job2}', '${nj}');
`;

const db = new PGlite();
try {
  await db.exec(SETUP);
  await db.exec(TM_CODES);
  await db.exec(TM_RATES);
  await db.exec(TM_COSTS);
  // An admin switched a code off before the rebuild: the catalog keeps that.
  await db.exec(`UPDATE public.tm_rate_codes SET active = false WHERE code IN ('TL', '402')`);

  const as = async (uid, sql) => {
    await db.exec(`SET ROLE authenticated; SET request.jwt.claim.sub = '${uid ?? ""}'`);
    try {
      return await db.query(sql);
    } finally {
      await db.exec("RESET ROLE; SELECT set_config('request.jwt.claim.sub','',false)");
    }
  };
  const one = async (sql) => (await db.query(sql)).rows[0];
  const item = (code) => one(`SELECT * FROM public.catalog_items WHERE code = '${code}'`);
  const tm = (code) => one(`SELECT * FROM public.tm_rate_codes WHERE code = '${code}'`);
  const save = (uid, changes, note = null) =>
    as(
      uid,
      `SELECT public.catalog_save('${JSON.stringify(changes).replace(/'/g, "''")}'::jsonb, ${
        note == null ? "NULL" : `'${note}'`
      }) AS n`,
    );

  /* ---- 1: the seed is the old book -------------------------------------- */
  await db.exec(FOUNDATION);
  await db.exec(FOUNDATION);
  check(true, "the migration applies twice without error");

  const byCat = Object.fromEntries(
    (
      await db.query(
        `SELECT category, count(*)::int AS n, count(*) FILTER (WHERE active)::int AS on
           FROM public.catalog_items GROUP BY category`,
      )
    ).rows.map((r) => [r.category, r]),
  );
  const expected = { labor: [28, 27], consumable: [57, 57], ppe: [13, 13], vehicle: [7, 6] };
  for (const [cat, [n, on]] of Object.entries(expected)) {
    check(byCat[cat]?.n === n, `${cat}: ${n} items, as in the old book`);
    check(byCat[cat]?.on === on, `${cat}: ${on} active, as in the old book`);
  }
  check(
    (await one(`SELECT count(*)::int AS n FROM public.catalog_items`)).n === 105,
    "105 items in all; no equipment, no general charges",
  );
  check(
    (
      await one(`SELECT count(*)::int AS n FROM public.catalog_items c
                   JOIN public.tm_rate_codes t USING (code)
                  WHERE c.name <> t.label OR c.sort_order <> t.sort_order OR c.category <> t.section`)
    ).n === 0,
    "every name, order and section is the old book's",
  );
  check((await item("TL")).active === false, "an inactive code stays inactive");
  check((await item("EO")).name === "Equipment Operator", "EO (added by TM1) is carried");
  check(
    (
      await one(`SELECT count(*)::int AS n FROM public.money_audit_log
                 WHERE book = 'catalog' AND field = 'created'`)
    ).n === 105,
    "the seed is recorded once per item, not twice on the re-run",
  );

  /* ---- 2: units --------------------------------------------------------- */
  const unit = async (code) => {
    const r = await item(code);
    return [r.unit, r.unit_review !== null];
  };
  const units = {
    CCF: ["hr", false],
    103: ["roll", false],
    116: ["roll", false],
    122: ["box", false],
    142: ["box", false],
    205: ["box", false],
    207: ["pair", false],
    209: ["pair", false],
    203: ["day", false],
    130: ["piece", false],
    110: ["piece", false],
    126: [null, true],
    127: [null, true],
    152: [null, true],
    100: ["piece", true],
    112: ["piece", true],
    401: ["day", true],
  };
  for (const [code, want] of Object.entries(units)) {
    assert.deepEqual(await unit(code), want, `unit of ${code}`);
    assertions++;
  }
  check(
    /gallon/.test((await item("126")).unit_review),
    "the per-gallon flag says what the words said",
  );

  /* ---- 3: catalog_save -------------------------------------------------- */
  await refuses(
    save(crew, [{ op: "update", code: "CCF", name: "Crew Boss" }]),
    /Only an administrator/,
    "crew cannot save",
  );
  await refuses(
    as(admin, `DELETE FROM public.catalog_items WHERE code = 'CCF'`),
    /permission denied/,
    "nobody deletes an item",
  );
  await refuses(
    as(admin, `UPDATE public.catalog_items SET code = 'CCX' WHERE code = 'CCF'`),
    /permission denied/,
    "the code is not writable",
  );

  check(
    (
      await save(
        admin,
        [
          {
            op: "create",
            code: "157",
            name: "Corner guard",
            category: "consumable",
            unit: "piece",
          },
        ],
        "New line from the field",
      )
    ).rows[0].n === 1,
    "an admin adds an item",
  );
  const added = await tm("157");
  check(
    added?.section === "consumable" && added.active && added.unit === "each",
    "it reaches the T&M pickers at once",
  );
  check(added.rate === null, "with no price — the bill names an unpriced code");

  const dup = await save(admin, [
    { op: "create", code: "158", name: "  corner   GUARD ", category: "ppe", unit: "piece" },
  ]).catch((e) => e);
  check(
    /already exists/.test(dup.message) && /catalog_duplicate_name:157/.test(dup.detail ?? ""),
    "a duplicate name is refused, naming the other item",
  );
  await refuses(
    save(admin, [{ op: "update", code: "GL", name: "skilled labor" }]),
    /already exists/,
    "a rename onto another item's name is refused",
  );
  await refuses(
    save(admin, [
      { op: "create", code: "300", name: "Something new", category: "consumable", unit: "piece" },
    ]),
    /another section/,
    "a code the old book uses elsewhere is refused",
  );
  await refuses(
    save(admin, [{ op: "update", code: "CCF", unit: "roll" }]),
    /unit_fits_category/,
    "a unit that does not fit the category is refused",
  );
  // All-or-nothing: the good rename in the same save is rolled back.
  await refuses(
    save(admin, [
      { op: "update", code: "SL", name: "Skilled Trades" },
      { op: "update", code: "GL", name: "Crew Chief" },
    ]),
    /already exists/,
    "one bad change refuses the whole save",
  );
  check((await item("SL")).name === "Skilled Labor", "…and nothing from it lands");

  await save(
    admin,
    [
      { op: "update", code: "100", unit: "piece" },
      { op: "update", code: "126", unit: "piece" },
      { op: "update", code: "CCF", name: "Crew Chief (Foreman)" },
      { op: "update", code: "PNT", archived: true },
    ],
    "Unit review",
  );
  check((await item("100")).unit_review === null, "setting a unit confirms it");
  check((await item("126")).unit === "piece", "a flagged blank unit is set");
  check((await tm("CCF")).label === "Crew Chief (Foreman)", "a rename reaches the T&M book");
  check((await tm("CCF")).unit === "hr", "the T&M unit is untouched");
  check(
    (await item("PNT")).archived_at !== null && (await item("PNT")).archived_by === admin,
    "archived, by whom",
  );
  check((await tm("PNT")).active === false, "an archived item leaves the T&M pickers");
  check((await item("PNT")).active === true, "archiving keeps the item's own Active flag");
  await save(admin, [{ op: "update", code: "PNT", archived: false }]);
  check((await item("PNT")).archived_at === null && (await tm("PNT")).active, "restored");

  /* ---- 4: the old page keeps working ------------------------------------ */
  await as(admin, `UPDATE public.tm_rate_codes SET label = 'skilled labor' WHERE code = 'DI'`);
  check(
    (await tm("DI")).label === "skilled labor",
    "the old page can still relabel as it always could",
  );
  check((await item("DI")).name === "skilled labor", "…and the catalog follows");
  await as(
    admin,
    `INSERT INTO public.tm_rate_codes (code, label, section, sort_order) VALUES ('FT', 'Floor Technician', 'labor', 300)`,
  );
  const ft = await item("FT");
  // The old page adds a code with no unit; the catalog flags it, never guesses.
  check(
    ft?.name === "Floor Technician" && ft.unit === null && ft.unit_review !== null,
    "a code added on the old page lands in the catalog, unit flagged",
  );
  await as(
    admin,
    `INSERT INTO public.tm_rate_codes (code, label, section, sort_order) VALUES ('347', 'Thermal camera', 'equipment', 999)`,
  );
  check((await item("347")) === undefined, "an equipment code does not");
  await save(admin, [{ op: "update", code: "SPM", archived: true }]);
  await as(admin, `UPDATE public.tm_rate_codes SET active = true WHERE code = 'SPM'`);
  check(
    (await item("SPM")).archived_at === null,
    "switching an archived code on there restores it",
  );
  await as(admin, `UPDATE public.tm_rate_codes SET active = false WHERE code = 'SCL'`);
  check((await item("SCL")).active === false, "switching a code off there switches it off here");

  /* ---- 5: the audit log ------------------------------------------------- */
  const audit = (
    await db.query(
      `SELECT * FROM public.money_audit_log WHERE entity_key = 'CCF' AND field = 'name'`,
    )
  ).rows[0];
  check(
    audit.changed_by === admin && audit.note === "Unit review",
    "who and the note are recorded",
  );
  check(
    audit.old_value === "Crew Chief" && audit.new_value === "Crew Chief (Foreman)",
    "old → new",
  );
  check(
    (
      await one(
        `SELECT note FROM public.money_audit_log WHERE entity_key = 'DI' AND field = 'name'`,
      )
    ).note === "Changed on the T&M rate codes page",
    "a change from the old page says so",
  );
  await as(admin, `UPDATE public.tm_rate_codes SET rate = 71 WHERE code = 'GL'`);
  check(
    (
      await one(
        `SELECT count(*)::int AS n FROM public.money_audit_log WHERE book = 'tm_rates' AND entity_key = 'GL' AND field = 'rate'`,
      )
    ).n === 1,
    "a T&M rate change is recorded",
  );
  check(
    (await as(crew, `SELECT * FROM public.money_audit_log`)).rows.length === 0,
    "crew reads nothing",
  );
  check(
    (await as(admin, `SELECT * FROM public.money_audit_log`)).rows.length > 0,
    "an admin reads it",
  );
  await refuses(
    as(
      admin,
      `INSERT INTO public.money_audit_log (book, entity, entity_key, field) VALUES ('catalog','x','x','x')`,
    ),
    /permission denied/,
    "no direct insert",
  );
  await refuses(
    as(admin, `UPDATE public.money_audit_log SET note = 'x'`),
    /permission denied/,
    "no client update",
  );
  await refuses(
    db.query(`UPDATE public.money_audit_log SET note = 'x'`),
    /append-only/,
    "not even the owner updates",
  );
  await refuses(db.query(`DELETE FROM public.money_audit_log`), /append-only/, "or deletes");
  await refuses(db.query(`TRUNCATE public.money_audit_log`), /append-only/, "or truncates");
  await refuses(
    as(admin, `SELECT public.money_audit_write('catalog','x','x','x',NULL,NULL)`),
    /permission denied/,
    "the writer is not callable by clients",
  );

  /* ---- 6: used on N jobs ------------------------------------------------ */
  await db.exec(`
    INSERT INTO public.job_tm_forms (job_id, kind, payload) VALUES
      ('${job1}', 'supply_list', '{"lines":[{"code":"122","qty":2},{"code":"103","qty":1}]}'),
      ('${job1}', 'supply_list', '{"lines":[{"code":"122","qty":1}]}'),
      ('${job2}', 'supply_list', '{"lines":[{"code":"122","qty":4}]}'),
      ('${job2}', 'sign_in', '{"rows":[{"rateCode":"GL"},{"rateCode":"CCF"}]}');
  `);
  const usage = Object.fromEntries(
    (
      await as(
        admin,
        `SELECT code, jobs::int FROM public.catalog_item_usage(ARRAY['122','103','GL','SPM'])`,
      )
    ).rows.map((r) => [r.code, r.jobs]),
  );
  assert.deepEqual(usage, { 122: 2, 103: 1, GL: 1, SPM: 0 });
  assertions++;
  check(
    (await as(crew, `SELECT * FROM public.catalog_item_usage(ARRAY['122'])`)).rows.length === 0,
    "usage is for administrators",
  );

  /* ---- 7: office-aware values ------------------------------------------- */
  await db.exec(`
    INSERT INTO public.money_values (book, item_key, measure, office_id, effective_from, value) VALUES
      ('tm_rates', 'GL', 'bill_rate', NULL, '2026-01-01', 70),
      ('tm_rates', 'GL', 'bill_rate', NULL, '2026-11-01', 72),
      ('tm_rates', 'GL', 'bill_rate', '${nj}', '2026-06-01', 65),
      ('tm_rates', 'GL', 'bill_rate', '${nj}', '2026-12-01', NULL);
  `);
  const resolve = async (office, on) => {
    const r = await one(
      `SELECT value, source FROM public.resolve_money_value('tm_rates','GL','bill_rate', ${office ? `'${office}'` : "NULL"}, '${on}')`,
    );
    return r ? [Number(r.value), r.source] : null;
  };
  assert.deepEqual(await resolve(ny, "2026-10-15"), [70, "default"]);
  assertions++;
  assert.deepEqual(await resolve(ny, "2026-11-15"), [72, "default"]);
  assertions++;
  assert.deepEqual(await resolve(nj, "2026-05-31"), [70, "default"]);
  assertions++;
  assert.deepEqual(await resolve(nj, "2026-11-15"), [65, "office"]);
  assertions++;
  assert.deepEqual(await resolve(nj, "2026-12-01"), [72, "default"]);
  assertions++;
  assert.deepEqual(await resolve(null, "2026-03-01"), [70, "default"]);
  assertions++;
  check((await resolve(ny, "2025-12-31")) === null, "nothing before the first value");
  await refuses(
    db.query(`UPDATE public.money_values SET value = 1`),
    /never edited/,
    "values are never edited",
  );
  await refuses(
    db.query(
      `INSERT INTO public.money_values (book, item_key, measure, effective_from) VALUES ('tm_rates','GL','bill_rate','2027-01-01')`,
    ),
    /default_has_value/,
    "a default always has a value",
  );
  await refuses(
    as(
      admin,
      `INSERT INTO public.money_values (book, item_key, measure, effective_from, value) VALUES ('tm_rates','GL','bill_rate','2027-01-01', 1)`,
    ),
    /permission denied/,
    "no client writes yet",
  );
  check(
    (
      await one(
        `SELECT count(*)::int AS n FROM public.money_audit_log WHERE entity = 'money_value'`,
      )
    ).n === 4,
    "each value is recorded",
  );
} finally {
  await db.close();
}

/* ---- 1b: a seed that misses a row aborts the migration ------------------ */
const db2 = new PGlite();
try {
  await db2.exec(SETUP);
  await db2.exec(TM_CODES);
  await db2.exec(TM_RATES);
  await db2.exec(TM_COSTS);
  // A catalog row squatting on a labor code under another category: the
  // seed skips it (ON CONFLICT), the counts disagree, and the check refuses.
  const pre = FOUNDATION.split(
    "-- ------------------------------------------------- seed + count check",
  )[0];
  await db2.exec(pre);
  await db2.exec(`
    SELECT set_config('gsr.catalog_mirror', 'on', false);
    ALTER TABLE public.catalog_items DISABLE TRIGGER catalog_items_to_tm;
    INSERT INTO public.catalog_items (code, name, category, unit) VALUES ('GL', 'Squatter', 'vehicle', 'day');
    ALTER TABLE public.catalog_items ENABLE TRIGGER catalog_items_to_tm;
    SELECT set_config('gsr.catalog_mirror', '', false);
  `);
  await refuses(db2.exec(FOUNDATION), /count mismatch/, "a missed row aborts the migration");
} finally {
  await db2.close();
}

console.log(`billing-costs-foundation.pglite: ${assertions} assertions passed`);
