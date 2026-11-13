// Run with: node supabase/tests/supply-vendor-prices.pglite.mjs <existing PGlite dist/index.js>
// In-memory fixtures only. No connection string, network access or live writes.
//
// What each vendor charges for a supply item. David, 22 Sep: "one guy charges
// $9, the other guy charges $10, then we should be able to put it in for each
// vendor." Mark, 13 Oct: "if he wants to put his price for a vendor on an item
// he wants to have a way to input that."
//
// The Prices button on the catalog is only reachable by catalog admins, but a
// screen is not a boundary. This proves who can read and write the prices
// where it is enforced, against the REAL migration read from disk:
//
//   20260925131000  supply_item_vendor_prices and its two policies
//
// What it proves:
//   1. RLS is on and anon holds no grant on the table;
//   2. crew see no prices and cannot write one — purchasing money stays with
//      the people who approve and pay for orders (Mark's standing rule: cost
//      columns stay hidden from non-privileged staff);
//   3. approvers (office, location_manager, sales_manager, regional) and
//      finance can read prices — the order detail shows them the expected
//      cost — but cannot change them;
//   4. a catalog admin (admin/owner/dev) can add, change (the app's upsert on
//      item_id,vendor_id) and clear a price;
//   5. one price per item and vendor, never negative, and it goes with the
//      vendor or item it belongs to.
//
// supply_items and supply_vendors are stubs with the columns the migration
// references. is_privileged, can_view_finance and has_any_role_text are
// stubbed over a roles table with production's role lists; auth.uid() reads
// a session setting, the way the other fixtures here do it.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
const migration = (name) => readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8");

let assertions = 0;
const check = (value, what) => {
  assert.equal(value, true, what);
  assertions++;
};
const eq = (actual, expected, what) => {
  assert.equal(actual, expected, `${what} (got ${actual}, wanted ${expected})`);
  assertions++;
};
const refused = async (promise, pattern, what) => {
  await assert.rejects(promise, pattern, what);
  assertions++;
};

const crew = "11111111-1111-4111-8111-111111111111";
const officeUser = "22222222-2222-4222-8222-222222222222";
const locationManager = "23232323-2323-4232-8232-232323232323";
const finance = "44444444-4444-4444-8444-444444444444";
const admin = "55555555-5555-4555-8555-555555555555";
const gloves = "aaaaaaaa-0000-4000-8000-000000000001";
const tape = "aaaaaaaa-0000-4000-8000-000000000002";
const jonDon = "bbbbbbbb-0000-4000-8000-000000000001";
const homeDepot = "bbbbbbbb-0000-4000-8000-000000000002";

try {
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;

    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);

    CREATE TABLE public.supply_items (id uuid PRIMARY KEY, name text NOT NULL);
    CREATE TABLE public.supply_vendors (id uuid PRIMARY KEY, name text NOT NULL);

    -- Production's helpers over a roles table: is_privileged is
    -- admin/owner/dev; can_view_finance is owner/admin/sales_head/dev.
    CREATE TABLE public.user_roles (user_id uuid, role text);
    CREATE FUNCTION public.is_privileged(_user_id uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
        SELECT EXISTS (SELECT 1 FROM public.user_roles
                       WHERE user_id = _user_id AND role IN ('admin','owner','dev'));
      $$;
    CREATE FUNCTION public.can_view_finance(_user_id uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
        SELECT EXISTS (SELECT 1 FROM public.user_roles
                       WHERE user_id = _user_id AND role IN ('owner','admin','sales_head','dev'));
      $$;
    CREATE FUNCTION public.has_any_role_text(_user_id uuid, _roles text[]) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
        SELECT EXISTS (SELECT 1 FROM public.user_roles
                       WHERE user_id = _user_id AND role = ANY(_roles));
      $$;

    INSERT INTO auth.users VALUES
      ('${crew}'), ('${officeUser}'), ('${locationManager}'), ('${finance}'), ('${admin}');
    INSERT INTO public.user_roles VALUES
      ('${crew}', 'technician'),
      ('${officeUser}', 'office'),
      ('${locationManager}', 'location_manager'),
      ('${finance}', 'sales_head'),
      ('${admin}', 'admin');
    INSERT INTO public.supply_items VALUES ('${gloves}', 'Nitrile gloves'), ('${tape}', 'Tape');
    INSERT INTO public.supply_vendors VALUES ('${jonDon}', 'Jon-Don'), ('${homeDepot}', 'Home Depot');
  `);

  await db.exec(migration("20260925131000_supply_vendor_prices.sql"));

  /** Run one statement as a signed-in user; never leaves the role set. */
  const as = async (uid, sql) => {
    await db.exec(`SET ROLE authenticated; SET request.jwt.claim.sub = '${uid}'`);
    try {
      return await db.query(sql);
    } finally {
      await db.exec("RESET ROLE; SELECT set_config('request.jwt.claim.sub','',false)");
    }
  };
  const one = async (sql) => (await db.query(sql)).rows[0];
  const priceOf = async (item, vendor) =>
    (
      await one(
        `SELECT unit_price::text AS p FROM public.supply_item_vendor_prices
         WHERE item_id = '${item}' AND vendor_id = '${vendor}'`,
      )
    )?.p ?? null;
  const count = async () =>
    (await one("SELECT count(*)::int AS n FROM public.supply_item_vendor_prices")).n;
  /** The app's write: setVendorPrice upserts on (item_id, vendor_id). */
  const upsert = (uid, item, vendor, price) =>
    as(
      uid,
      `INSERT INTO public.supply_item_vendor_prices (item_id, vendor_id, unit_price, updated_by)
       VALUES ('${item}', '${vendor}', ${price}, '${uid}')
       ON CONFLICT (item_id, vendor_id)
       DO UPDATE SET unit_price = EXCLUDED.unit_price, updated_by = EXCLUDED.updated_by,
                     updated_at = now()`,
    );

  /* ---- 1: RLS on, nothing for anon -------------------------------------- */
  check(
    (
      await one(
        "SELECT relrowsecurity AS on FROM pg_class WHERE oid = 'public.supply_item_vendor_prices'::regclass",
      )
    ).on,
    "row level security is enabled",
  );
  for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
    eq(
      (
        await one(
          `SELECT has_table_privilege('anon', 'public.supply_item_vendor_prices', '${priv}') AS ok`,
        )
      ).ok,
      false,
      `anon has no ${priv}`,
    );
  }

  /* ---- 4: a catalog admin sets, changes and clears prices -------------- */
  await upsert(admin, gloves, jonDon, 9);
  await upsert(admin, gloves, homeDepot, 10);
  await upsert(admin, tape, homeDepot, 4.5);
  eq(await priceOf(gloves, jonDon), "9.00", "admin adds Jon-Don's glove price");
  await upsert(admin, gloves, jonDon, 8.75);
  eq(await priceOf(gloves, jonDon), "8.75", "admin changes it through the same upsert");
  eq(await count(), 3, "one row per item and vendor after the change");
  eq(
    (await one(`SELECT updated_by::text AS u FROM public.supply_item_vendor_prices LIMIT 1`)).u,
    admin,
    "the row records who set it",
  );

  /* ---- 2: crew see nothing and write nothing --------------------------- */
  eq(
    (await as(crew, "SELECT * FROM public.supply_item_vendor_prices")).rows.length,
    0,
    "crew read no prices",
  );
  await refused(upsert(crew, tape, jonDon, 1), /row-level security/, "crew cannot add a price");
  eq(
    (await as(crew, `UPDATE public.supply_item_vendor_prices SET unit_price = 0 RETURNING id`)).rows
      .length,
    0,
    "crew update matches no row",
  );
  eq(
    (await as(crew, `DELETE FROM public.supply_item_vendor_prices RETURNING id`)).rows.length,
    0,
    "crew delete matches no row",
  );

  /* ---- 3: approvers and finance read, but do not write ----------------- */
  for (const [uid, who] of [
    [officeUser, "office"],
    [locationManager, "location manager"],
    [finance, "finance"],
  ]) {
    eq(
      (await as(uid, "SELECT * FROM public.supply_item_vendor_prices")).rows.length,
      3,
      `${who} reads every price (the order's expected cost)`,
    );
    await refused(upsert(uid, tape, jonDon, 1), /row-level security/, `${who} cannot add a price`);
    eq(
      (await as(uid, `UPDATE public.supply_item_vendor_prices SET unit_price = 0 RETURNING id`))
        .rows.length,
      0,
      `${who} cannot change a price`,
    );
    eq(
      (await as(uid, `DELETE FROM public.supply_item_vendor_prices RETURNING id`)).rows.length,
      0,
      `${who} cannot clear a price`,
    );
  }
  eq(await priceOf(gloves, jonDon), "8.75", "nobody but the admin moved the price");
  eq(await count(), 3, "and nobody but the admin removed one");

  /* ---- 5: shape of the data -------------------------------------------- */
  await refused(upsert(admin, tape, jonDon, -1), /check constraint/, "a price cannot be negative");
  await refused(
    as(
      admin,
      `INSERT INTO public.supply_item_vendor_prices (item_id, vendor_id, unit_price)
       VALUES ('${gloves}', '${jonDon}', 7)`,
    ),
    /supply_item_vendor_prices_one/,
    "a second price for the same item and vendor is refused",
  );
  await upsert(admin, tape, jonDon, 3.999);
  eq(await priceOf(tape, jonDon), "4.00", "stored to the cent");

  // Clearing a box deletes the row (setVendorPrice with null).
  eq(
    (
      await as(
        admin,
        `DELETE FROM public.supply_item_vendor_prices
         WHERE item_id = '${tape}' AND vendor_id = '${jonDon}' RETURNING id`,
      )
    ).rows.length,
    1,
    "admin clears a price",
  );

  await db.exec(`DELETE FROM public.supply_vendors WHERE id = '${homeDepot}'`);
  eq(await count(), 1, "removing a vendor takes its prices with it");
  await db.exec(`DELETE FROM public.supply_items WHERE id = '${gloves}'`);
  eq(await count(), 0, "removing an item takes its prices with it");

  console.log(`supply-vendor-prices.pglite: ${assertions} assertions passed`);
} finally {
  await db.close();
}
