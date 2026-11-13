// Run with: node supabase/tests/room-field-capture.pglite.mjs <existing PGlite dist/index.js>
// In-memory fixtures only. No connection string, network access or live writes.
//
// Field capture on the Rooms tab (migration 20261006140000): doors, windows
// and cabinet runs per room, flooring and +/- SF on job_rooms. Mark: "yes
// build field capture into the rooms tab." The migrations under test are READ
// FROM THE FILES, never retyped here: job_rooms as 20260810184457 created it
// (the file up to its "-- 2." section), its unit column (20260907120500),
// then this one.
//
// What it proves:
//   1. the new tables carry job_rooms' own policies, clause for clause — the
//      same USING and WITH CHECK, for the same roles, on every verb;
//   2. which means office scoping: the job's office managers write, its
//      members read and cannot write, another office's manager neither sees
//      nor touches a row, on every verb;
//   3. a door or cabinet run cannot claim a room on a different job from the
//      job its RLS is evaluated on (the composite foreign key);
//   4. a room's doors and cabinets go with it when it is removed;
//   5. the kinds and sizes the app does not know are refused;
//   6. job_rooms gains flooring (NULL) and extra_sf (0, never NULL), and an
//      existing room reads as "not recorded";
//   7. portal customers are refused by the restrictive policy even if a
//      permissive grant were ever added by mistake; anon has no privilege;
//   8. the file runs twice without error.
//
// can_view_job / can_manage_job are stand-ins with the production signature
// and the production meaning for this purpose: members of the job's office
// see it, its managers manage it. auth.uid() reads a session setting, the way
// the other fixtures here do it.
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
const refuses = async (promise, pattern, what) => {
  await assert.rejects(promise, pattern, what);
  assertions++;
};

const manager = "11111111-1111-4111-8111-111111111111"; // manages office N
const viewer = "22222222-2222-4222-8222-222222222222"; // member of N, cannot manage
const stranger = "33333333-3333-4333-8333-333333333333"; // manages office S only
const officeN = "66666666-6666-4666-8666-666666666666";
const officeS = "77777777-7777-4777-8777-777777777777";
const jobN = "88888888-8888-4888-8888-888888888888";
const jobN2 = "99999999-9999-4999-8999-999999999999"; // a second job, same office
const kitchen = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherRoom = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // on jobN2
const door = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const cab = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const MIGRATION = "20261006140000_room_field_capture.sql";

try {
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS;
    CREATE ROLE portal_customer;
    CREATE SCHEMA auth;
    GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role, portal_customer;

    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    INSERT INTO auth.users VALUES ('${manager}'), ('${viewer}'), ('${stranger}');

    CREATE FUNCTION public.update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN NEW.updated_at := now() + interval '1 second'; RETURN NEW; END $$;

    CREATE TABLE public.jobs (id uuid PRIMARY KEY, location_id uuid NOT NULL);
    CREATE TABLE public.location_members (user_id uuid, location_id uuid, can_manage boolean);
    INSERT INTO public.jobs VALUES ('${jobN}', '${officeN}'), ('${jobN2}', '${officeN}');
    INSERT INTO public.location_members VALUES
      ('${manager}', '${officeN}', true),
      ('${viewer}', '${officeN}', false),
      ('${stranger}', '${officeS}', true);

    CREATE FUNCTION public.can_view_job(_user_id uuid, _job_id uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT EXISTS (SELECT 1 FROM public.jobs j JOIN public.location_members m
                      ON m.location_id = j.location_id
                      WHERE j.id = _job_id AND m.user_id = _user_id)
    $$;
    CREATE FUNCTION public.can_manage_job(_user_id uuid, _job_id uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT EXISTS (SELECT 1 FROM public.jobs j JOIN public.location_members m
                      ON m.location_id = j.location_id
                      WHERE j.id = _job_id AND m.user_id = _user_id AND m.can_manage)
    $$;
    GRANT EXECUTE ON FUNCTION public.can_view_job(uuid, uuid), public.can_manage_job(uuid, uuid)
      TO authenticated, portal_customer;
  `);

  // job_rooms exactly as production created it: section 1 of its migration.
  const original = migration("20260810184457_d6ad375b-ae50-45b4-aef5-59332d2de86a.sql");
  const jobRooms = original.slice(0, original.indexOf("-- 2. Room links"));
  assert.ok(jobRooms.includes("CREATE TABLE public.job_rooms"), "sliced the job_rooms section");
  await db.exec(jobRooms);
  await db.exec(migration("20260907120500_job_room_unit.sql"));

  // A room recorded before field capture existed.
  await db.exec(`
    INSERT INTO public.job_rooms (id, job_id, name, length_ft, width_ft)
      VALUES ('${kitchen}', '${jobN}', 'Kitchen', 12.5, 10),
             ('${otherRoom}', '${jobN2}', 'Bedroom', 10, 10);
  `);

  await db.exec(migration(MIGRATION));
  /* 8: re-runnable */
  await db.exec(migration(MIGRATION));
  check(true, "the migration runs twice without error");

  const as = async (user, sql, params = [], role = "authenticated") => {
    await db.exec(
      `SET ROLE ${role}; SELECT set_config('request.jwt.claim.sub', '${user}', false);`,
    );
    try {
      return await db.query(sql, params);
    } finally {
      await db.exec(`RESET ROLE;`);
    }
  };

  /* 6: job_rooms columns */
  const k = (
    await db.query(`SELECT flooring, extra_sf FROM public.job_rooms WHERE id = $1`, [kitchen])
  ).rows[0];
  check(
    k.flooring === null && Number(k.extra_sf) === 0,
    "an existing room reads as no flooring, 0 SF adjustment",
  );
  const extraNotNull = (
    await db.query(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_name = 'job_rooms' AND column_name = 'extra_sf'`,
    )
  ).rows[0];
  check(extraNotNull.is_nullable === "NO", "extra_sf is never NULL");

  /* 1: policies mirror job_rooms clause for clause */
  const policies = async (table) =>
    Object.fromEntries(
      (
        await db.query(
          `SELECT cmd, roles::text AS roles, permissive, qual, with_check FROM pg_policies
            WHERE tablename = $1 AND policyname <> 'portal_customer_denied'`,
          [table],
        )
      ).rows.map((r) => [r.cmd, `${r.roles}|${r.permissive}|${r.qual}|${r.with_check}`]),
    );
  const rooms = await policies("job_rooms");
  check(
    Object.keys(rooms).sort().join() === "DELETE,INSERT,SELECT,UPDATE",
    "job_rooms has a policy per verb",
  );
  for (const table of ["job_room_openings", "job_room_cabinets"]) {
    const mine = await policies(table);
    for (const cmd of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
      check(
        mine[cmd] === rooms[cmd],
        `${table} ${cmd} is job_rooms' ${cmd}: ${mine[cmd]} vs ${rooms[cmd]}`,
      );
    }
    check(Object.keys(mine).length === 4, `${table} has no policy job_rooms does not`);
  }

  /* 2: office scoping, every verb */
  const addDoor = (user, id = door, room = kitchen, job = jobN) =>
    as(
      user,
      `INSERT INTO public.job_room_openings (id, job_id, room_id, kind, width_in, height_in, qty, created_by)
       VALUES ($1, $2, $3, 'interior_door', 30, 80, 1, $4)
       ON CONFLICT (id) DO UPDATE SET width_in = EXCLUDED.width_in`,
      [id, job, room, user],
    );
  const addCab = (user, id = cab) =>
    as(
      user,
      `INSERT INTO public.job_room_cabinets (id, job_id, room_id, kind, length_ft, created_by)
       VALUES ($1, $2, $3, 'base', 8.5, $4)`,
      [id, jobN, kitchen, user],
    );

  await addDoor(manager);
  await addDoor(manager); // the queue's replay: an upsert on the client id
  await addCab(manager);
  const doors = (await db.query(`SELECT count(*)::int AS n FROM public.job_room_openings`)).rows[0]
    .n;
  check(doors === 1, "the office manager adds a door, and a replay lands the same door");

  const seen = async (user, table) =>
    (await as(user, `SELECT id FROM public.${table}`)).rows.length;
  for (const table of ["job_room_openings", "job_room_cabinets"]) {
    check((await seen(manager, table)) === 1, `the office manager sees ${table}`);
    check((await seen(viewer, table)) === 1, `a member of the office sees ${table}`);
    check((await seen(stranger, table)) === 0, `another office's manager sees no ${table}`);
  }

  await refuses(
    addDoor(viewer, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"),
    /row-level security/i,
    "a member who cannot manage the job cannot add a door",
  );
  await refuses(
    addDoor(stranger, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"),
    /row-level security/i,
    "another office's manager cannot add a door",
  );
  await refuses(
    addCab(stranger, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"),
    /row-level security/i,
    "another office's manager cannot add a cabinet run",
  );

  for (const user of [viewer, stranger]) {
    const upd = await as(
      user,
      `UPDATE public.job_room_openings SET width_in = 99 WHERE id = $1 RETURNING id`,
      [door],
    );
    check(upd.rows.length === 0, `${user === viewer ? "a viewer" : "a stranger"} changes no door`);
    const del = await as(user, `DELETE FROM public.job_room_cabinets WHERE id = $1 RETURNING id`, [
      cab,
    ]);
    check(
      del.rows.length === 0,
      `${user === viewer ? "a viewer" : "a stranger"} removes no cabinet run`,
    );
  }
  const width = (
    await db.query(`SELECT width_in FROM public.job_room_openings WHERE id = $1`, [door])
  ).rows[0];
  check(Number(width.width_in) === 30, "the door is as the manager left it");

  const before = (
    await db.query(`SELECT updated_at FROM public.job_room_openings WHERE id = $1`, [door])
  ).rows[0];
  const upd = await as(
    manager,
    `UPDATE public.job_room_openings SET width_in = 32 WHERE id = $1 RETURNING id`,
    [door],
  );
  check(upd.rows.length === 1, "the office manager corrects the width, and reads it back");
  const after = (
    await db.query(`SELECT updated_at FROM public.job_room_openings WHERE id = $1`, [door])
  ).rows[0];
  check(new Date(after.updated_at) > new Date(before.updated_at), "updated_at moves on an edit");

  // The room columns are job_rooms' own policy, which is unchanged.
  const measured = await as(
    manager,
    `UPDATE public.job_rooms SET flooring = 'Carpet', extra_sf = -12 WHERE id = $1 RETURNING id`,
    [kitchen],
  );
  check(measured.rows.length === 1, "the manager records flooring and +/- SF on the room");
  const notMeasured = await as(
    viewer,
    `UPDATE public.job_rooms SET flooring = 'Tile' WHERE id = $1 RETURNING id`,
    [kitchen],
  );
  check(notMeasured.rows.length === 0, "a viewer cannot");

  /* 3: a door cannot claim a room on another job */
  await refuses(
    addDoor(manager, "ffffffff-ffff-4fff-8fff-ffffffffffff", otherRoom, jobN),
    /foreign key/i,
    "a door on jobN pointing at a room on jobN2 is refused",
  );

  /* 5: kinds and sizes */
  await refuses(
    db.query(
      `INSERT INTO public.job_room_openings (job_id, room_id, kind) VALUES ($1, $2, 'garage')`,
      [jobN, kitchen],
    ),
    /check constraint/i,
    "an opening kind the app does not know is refused",
  );
  await refuses(
    db.query(
      `INSERT INTO public.job_room_openings (job_id, room_id, kind, qty) VALUES ($1, $2, 'window', 0)`,
      [jobN, kitchen],
    ),
    /check constraint/i,
    "zero of something is refused",
  );
  await refuses(
    db.query(
      `INSERT INTO public.job_room_openings (job_id, room_id, kind, width_in) VALUES ($1, $2, 'window', 0)`,
      [jobN, kitchen],
    ),
    /check constraint/i,
    "a zero width is refused",
  );
  await refuses(
    db.query(
      `INSERT INTO public.job_room_cabinets (job_id, room_id, kind) VALUES ($1, $2, 'island')`,
      [jobN, kitchen],
    ),
    /check constraint/i,
    "a cabinet kind the app does not know is refused",
  );

  /* 7: portal customers and anon */
  for (const table of ["job_room_openings", "job_room_cabinets"]) {
    const deny = (
      await db.query(
        `SELECT permissive, roles::text AS roles, qual, with_check FROM pg_policies
          WHERE tablename = $1 AND policyname = 'portal_customer_denied'`,
        [table],
      )
    ).rows;
    check(
      deny.length === 1 &&
        deny[0].permissive === "RESTRICTIVE" &&
        deny[0].roles === "{portal_customer}" &&
        deny[0].qual === "false" &&
        deny[0].with_check === "false",
      `${table} carries the restrictive portal_customer_denied policy`,
    );
    // Simulate the mistake the restrictive policy exists for: a grant and a
    // permissive policy that would let customers read everything.
    await db.exec(`GRANT SELECT ON public.${table} TO portal_customer;
                   CREATE POLICY oops ON public.${table} FOR SELECT TO portal_customer USING (true);`);
    const leaked = (await as(manager, `SELECT id FROM public.${table}`, [], "portal_customer")).rows
      .length;
    check(
      leaked === 0,
      `a portal customer reads nothing from ${table}, even past a mistaken grant`,
    );
    await db.exec(
      `DROP POLICY oops ON public.${table}; REVOKE SELECT ON public.${table} FROM portal_customer;`,
    );

    const anon = (
      await db.query(`SELECT has_table_privilege('anon', 'public.${table}', 'SELECT') AS s,
                             has_table_privilege('anon', 'public.${table}', 'INSERT') AS i`)
    ).rows[0];
    check(anon.s === false && anon.i === false, `anon has no privilege on ${table}`);
  }
  await refuses(
    as(null, `SELECT id FROM public.job_room_openings`, [], "anon"),
    /permission denied/i,
    "anon is refused outright",
  );

  /* 4: cascade with the room */
  await as(manager, `DELETE FROM public.job_rooms WHERE id = $1`, [kitchen]);
  const left = (
    await db.query(`SELECT (SELECT count(*) FROM public.job_room_openings)::int AS o,
                           (SELECT count(*) FROM public.job_room_cabinets)::int AS c`)
  ).rows[0];
  check(left.o === 0 && left.c === 0, "removing a room removes its doors and cabinet runs");

  console.log(`room-field-capture.pglite: ${assertions} assertions passed`);
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await db.close();
}
