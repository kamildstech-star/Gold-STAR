// Run with: node supabase/tests/cost-columns-withheld.pglite.mjs <existing PGlite dist/index.js>
// In-memory fixtures only. No connection string, network access or live writes.
//
// TM8 (migration 20261027150000): supply_items.unit_cost,
// equipment.daily_rate_cents and equipment.purchase_cost_cents are withheld
// from the authenticated role. The migration is READ FROM THE FILE; the
// tables carry the live column set, grants and row policies, and the helpers
// it calls (has_permission, can_view_location, can_manage_location,
// is_privileged) are stubbed with the live signatures and meaning.
//
// What it proves:
//   1. A seller cannot select any cost column (nor select *), directly or
//      through an embed-style join.
//   2. A seller still reads every public column it read before.
//   3. A seller gets nothing from supply_item_costs() / equipment_costs().
//   4. A job.view_costs holder gets the costs through both functions — and
//      only for units it can see.
//   5. add_equipment_from_scan no longer hands back a purchase cost.
//   6. Writes of cost are unchanged; the migration is re-runnable; anon
//      cannot execute the new functions.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
const FILE = "20261027150000_cost_columns_withheld.sql";
const migration = readFileSync(new URL("../migrations/" + FILE, import.meta.url), "utf8");

let assertions = 0;
const check = (value, what) => {
  assert.equal(value, true, what);
  assertions++;
};

const owner = "11111111-1111-4111-8111-111111111111";
const office = "22222222-2222-4222-8222-222222222222";
const seller = "33333333-3333-4333-8333-333333333333";
const locA = "aaaaaaaa-0000-4000-8000-00000000000a";
const locB = "bbbbbbbb-0000-4000-8000-00000000000b";
const item = "cccccccc-0000-4000-8000-00000000000c";
const unitA = "dddddddd-0000-4000-8000-00000000000a";
const unitB = "dddddddd-0000-4000-8000-00000000000b";

try {
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;

    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

    CREATE TABLE public.user_roles (user_id uuid, role text);
    CREATE TABLE public.role_permissions (role text, permission_key text);
    -- Which office each person can see / manage.
    CREATE TABLE public.location_members (user_id uuid, location_id uuid, manage boolean);

    CREATE FUNCTION public.has_permission(_user_id uuid, _key text, _location_id uuid DEFAULT NULL)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT EXISTS (
        SELECT 1 FROM public.user_roles ur JOIN public.role_permissions rp ON rp.role = ur.role
         WHERE ur.user_id = _user_id AND rp.permission_key = _key);
    $$;
    CREATE FUNCTION public.can_view_location(_user_id uuid, _location_id uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT EXISTS (SELECT 1 FROM public.location_members
                      WHERE user_id = _user_id AND location_id = _location_id);
    $$;
    CREATE FUNCTION public.can_manage_location(_user_id uuid, _location_id uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT EXISTS (SELECT 1 FROM public.location_members
                      WHERE user_id = _user_id AND location_id = _location_id AND manage);
    $$;
    CREATE FUNCTION public.is_privileged(_user_id uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id
                      AND role = ANY (ARRAY['owner','admin','dev']));
    $$;

    -- supply_items: the live column set, grant and policies.
    CREATE TABLE public.supply_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      unit text NOT NULL DEFAULT 'each',
      category text,
      is_active boolean NOT NULL DEFAULT true,
      sort_order integer NOT NULL DEFAULT 100,
      created_by uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      unit_cost numeric(12,2),
      sku text,
      default_supplier text,
      size text,
      default_vendor_id uuid
    );
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.supply_items TO anon, authenticated;
    GRANT ALL ON public.supply_items TO service_role;
    ALTER TABLE public.supply_items ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "supply_items_read" ON public.supply_items FOR SELECT TO authenticated
      USING (true);
    CREATE POLICY "supply_items_manage" ON public.supply_items FOR ALL TO authenticated
      USING (public.is_privileged(auth.uid()))
      WITH CHECK (public.is_privileged(auth.uid()));

    -- equipment: the live column set, grant and policies.
    CREATE TYPE public.equipment_status AS ENUM ('available','on_job','in_transit','lost','retired');
    CREATE TABLE public.equipment (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      asset_tag text NOT NULL UNIQUE,
      equipment_type text NOT NULL,
      make text,
      model text,
      serial_number text,
      purchase_date date,
      purchase_cost_cents integer,
      location_id uuid NOT NULL,
      status public.equipment_status NOT NULL DEFAULT 'available',
      external_tracker_id text UNIQUE,
      notes text,
      created_by uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      is_demo boolean NOT NULL DEFAULT false,
      equipment_type_detail text,
      daily_rate_cents integer,
      tracker_provider text,
      last_lat double precision,
      last_lon double precision,
      last_seen_at timestamptz,
      tracker_battery_pct integer,
      tracker_heartbeat_status text,
      tracker_location_status text,
      tracker_location_name text,
      tracker_address text,
      tracker_synced_at timestamptz,
      created_via text,
      created_job_id uuid
    );
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.equipment TO anon, authenticated;
    GRANT ALL ON public.equipment TO service_role;
    ALTER TABLE public.equipment ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "equipment_select" ON public.equipment FOR SELECT TO authenticated
      USING (created_by = auth.uid() OR public.can_view_location(auth.uid(), location_id));
    CREATE POLICY "equipment_insert" ON public.equipment FOR INSERT TO authenticated
      WITH CHECK (public.can_manage_location(auth.uid(), location_id));
    CREATE POLICY "equipment_update" ON public.equipment FOR UPDATE TO authenticated
      USING (public.can_manage_location(auth.uid(), location_id));

    INSERT INTO public.user_roles VALUES
      ('${owner}', 'owner'), ('${office}', 'office'), ('${seller}', 'sales_person');
    INSERT INTO public.role_permissions VALUES
      ('owner', 'job.view_costs'), ('office', 'job.view_costs'), ('sales_person', 'ai.assistant');
    INSERT INTO public.location_members VALUES
      ('${owner}', '${locA}', true), ('${owner}', '${locB}', true),
      ('${office}', '${locA}', true),
      ('${seller}', '${locA}', false);

    INSERT INTO public.supply_items (id, name, unit, category, unit_cost, sku)
      VALUES ('${item}', 'Nitrile Gloves', 'box', 'PPE', 12.50, 'GLV-1');
    INSERT INTO public.equipment
      (id, asset_tag, equipment_type, location_id, purchase_cost_cents, daily_rate_cents, make)
      VALUES
      ('${unitA}', 'GSR-DU00001-NJ', 'dehumidifier', '${locA}', 250000, 2000, 'Dri-Eaz'),
      ('${unitB}', 'GSR-AM00001-NY', 'air_mover', '${locB}', 40000, 500, 'B-Air');
  `);

  /* ---- 6: the migration, verbatim, twice ------------------------------ */
  await db.exec(migration);
  await db.exec(migration);
  check(true, "the migration applies twice without error");

  const as = async (uid, sql) => {
    await db.exec(
      `SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', '${uid}', false)`,
    );
    try {
      return (await db.query(sql)).rows;
    } finally {
      await db.exec("RESET ROLE; SELECT set_config('request.jwt.claim.sub', '', false)");
    }
  };
  const denied = async (uid, sql, what) => {
    await assert.rejects(as(uid, sql), /permission denied/, what);
    assertions++;
  };

  /* ---- 1: a seller cannot select a cost column ------------------------ */
  await denied(
    seller,
    `SELECT unit_cost FROM public.supply_items`,
    "seller: supply_items.unit_cost",
  );
  await denied(seller, `SELECT * FROM public.supply_items`, "seller: supply_items select *");
  await denied(seller, `SELECT daily_rate_cents FROM public.equipment`, "seller: daily_rate_cents");
  await denied(
    seller,
    `SELECT purchase_cost_cents FROM public.equipment`,
    "seller: purchase_cost_cents",
  );
  await denied(seller, `SELECT * FROM public.equipment`, "seller: equipment select *");
  await denied(
    seller,
    `SELECT id FROM public.equipment WHERE purchase_cost_cents > 0`,
    "seller: cannot filter on a cost column either",
  );
  // Withheld from everyone through the table, cost holders included.
  await denied(owner, `SELECT unit_cost FROM public.supply_items`, "owner: not through the table");
  await denied(
    office,
    `SELECT purchase_cost_cents FROM public.equipment`,
    "office: not through the table",
  );

  /* ---- 2: a seller still reads the public columns --------------------- */
  const sItems = await as(
    seller,
    `SELECT id, name, unit, category, is_active, sort_order, created_by, created_at, updated_at,
            sku, default_supplier, size, default_vendor_id FROM public.supply_items`,
  );
  check(sItems.length === 1 && sItems[0].name === "Nitrile Gloves", "seller reads the catalogue");
  const sUnits = await as(
    seller,
    `SELECT id, asset_tag, equipment_type, make, model, serial_number, purchase_date, location_id,
            status, external_tracker_id, notes, created_by, created_at, updated_at, is_demo,
            equipment_type_detail, tracker_provider, last_lat, last_lon, last_seen_at,
            tracker_battery_pct, tracker_heartbeat_status, tracker_location_status,
            tracker_location_name, tracker_address, tracker_synced_at, created_via, created_job_id
       FROM public.equipment`,
  );
  check(
    sUnits.length === 1 && sUnits[0].asset_tag === "GSR-DU00001-NJ",
    "seller reads the units of its office, every public column",
  );

  /* ---- 3: a seller gets nothing from the functions -------------------- */
  check(
    (await as(seller, `SELECT * FROM public.supply_item_costs()`)).length === 0,
    "seller: supply_item_costs() is empty",
  );
  check(
    (await as(seller, `SELECT * FROM public.equipment_costs()`)).length === 0,
    "seller: equipment_costs() is empty",
  );
  check(
    (await as(seller, `SELECT * FROM public.equipment_costs(ARRAY['${unitA}']::uuid[])`)).length ===
      0,
    "seller: equipment_costs(ids) is empty even for a unit it can see",
  );

  /* ---- 4: a job.view_costs holder gets the costs ---------------------- */
  const oItems = await as(office, `SELECT * FROM public.supply_item_costs()`);
  check(
    oItems.length === 1 && oItems[0].id === item && Number(oItems[0].unit_cost) === 12.5,
    "office: supply_item_costs() gives the unit cost",
  );
  const oUnits = await as(office, `SELECT * FROM public.equipment_costs()`);
  check(
    oUnits.length === 1 &&
      oUnits[0].id === unitA &&
      Number(oUnits[0].daily_rate_cents) === 2000 &&
      Number(oUnits[0].purchase_cost_cents) === 250000,
    "office: equipment_costs() gives both costs for its own office's unit",
  );
  check(
    (await as(office, `SELECT * FROM public.equipment_costs(ARRAY['${unitB}']::uuid[])`)).length ===
      0,
    "office: no cost for a unit in an office it cannot see",
  );
  const wUnits = await as(
    owner,
    `SELECT id FROM public.equipment_costs() ORDER BY daily_rate_cents`,
  );
  check(
    wUnits.length === 2 && wUnits[0].id === unitB,
    "owner: equipment_costs() covers every office it can see",
  );
  const picked = await as(
    owner,
    `SELECT id FROM public.equipment_costs(ARRAY['${unitA}']::uuid[])`,
  );
  check(picked.length === 1 && picked[0].id === unitA, "owner: _ids narrows the answer");

  /* ---- 5: a scan no longer hands back a purchase cost ----------------- */
  const scan = await as(
    seller,
    `SELECT * FROM public.add_equipment_from_scan('GSR-AM00001-NY', 'air_mover', '${locA}')`,
  );
  check(
    scan.length === 1 && scan[0].outcome === "existing" && scan[0].purchase_cost_cents === null,
    "a scan of another office's unit returns no purchase cost",
  );
  const created = await as(
    office,
    `SELECT * FROM public.add_equipment_from_scan('GSR-HE00007-NJ', 'heater', '${locA}')`,
  );
  check(
    created.length === 1 &&
      created[0].outcome === "created" &&
      created[0].purchase_cost_cents === null,
    "a scan that adds a unit returns no purchase cost",
  );

  /* ---- 6: writes unchanged; anon shut out ----------------------------- */
  await as(owner, `UPDATE public.supply_items SET unit_cost = 13.75 WHERE id = '${item}'`);
  await as(office, `UPDATE public.equipment SET daily_rate_cents = 2500 WHERE id = '${unitA}'`);
  const afterItem = await as(owner, `SELECT unit_cost FROM public.supply_item_costs()`);
  check(Number(afterItem[0].unit_cost) === 13.75, "a cost holder still writes unit_cost");
  const afterUnit = await as(
    office,
    `SELECT daily_rate_cents FROM public.equipment_costs(ARRAY['${unitA}']::uuid[])`,
  );
  check(
    Number(afterUnit[0].daily_rate_cents) === 2500,
    "a cost holder still writes daily_rate_cents",
  );
  await as(owner, `INSERT INTO public.supply_items (name, unit_cost) VALUES ('Tape', 4.00)`);
  check(
    (await as(owner, `SELECT id FROM public.supply_item_costs()`)).length === 2,
    "an insert carrying a cost still works without reading it back",
  );

  for (const fn of ["supply_item_costs()", "equipment_costs(uuid[])"]) {
    const acl = (
      await db.query(
        `SELECT has_function_privilege('anon', 'public.${fn}', 'EXECUTE') AS anon_x,
                has_function_privilege('authenticated', 'public.${fn}', 'EXECUTE') AS auth_x`,
      )
    ).rows[0];
    check(
      acl.anon_x === false && acl.auth_x === true,
      `${fn}: anon cannot execute, authenticated can`,
    );
  }
  const anonCol = (
    await db.query(
      `SELECT has_column_privilege('anon', 'public.equipment', 'asset_tag', 'SELECT') AS x,
              has_column_privilege('authenticated', 'public.equipment', 'purchase_cost_cents', 'SELECT') AS y,
              has_column_privilege('authenticated', 'public.supply_items', 'unit_cost', 'SELECT') AS z`,
    )
  ).rows[0];
  check(
    anonCol.x === false && anonCol.y === false && anonCol.z === false,
    "anon reads nothing; authenticated holds no cost column",
  );

  /* ---- 0: the guard stops a migration that misses a column ------------ */
  await db.exec(`ALTER TABLE public.equipment ADD COLUMN surprise text`);
  await assert.rejects(
    db.exec(migration),
    /equipment has columns this migration does not list: surprise/,
  );
  assertions++;

  console.log(`cost-columns-withheld.pglite: ${assertions} assertions passed`);
} finally {
  await db.close();
}
