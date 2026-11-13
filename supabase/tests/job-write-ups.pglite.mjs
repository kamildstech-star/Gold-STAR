// Run with: node supabase/tests/job-write-ups.pglite.mjs <existing PGlite dist/index.js>
// In-memory fixtures only. No connection string, network access or live writes.
//
// FE11 (migration 20261028120000): job_write_up_items. The migration is READ
// FROM THE FILE; jobs, job_rooms and the job-access helpers (can_view_job,
// can_manage_job, update_updated_at_column) are stubbed with the live
// signatures and meaning.
//
// What it proves:
//   1. Someone on the job adds lines as themselves; never as someone else.
//   2. Someone not on the job reads and writes nothing.
//   3. A line is changed or removed by its writer or a job manager only.
//   4. Deleting a room keeps its lines (room cleared); deleting the job
//      removes them. The migration is re-runnable; anon reaches nothing.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
const FILE = "20261028120000_job_write_ups.sql";
const migration = readFileSync(new URL("../migrations/" + FILE, import.meta.url), "utf8");

let assertions = 0;
const check = (value, what) => {
  assert.equal(value, true, what);
  assertions++;
};

const crew = "11111111-1111-4111-8111-111111111111";
const crew2 = "22222222-2222-4222-8222-222222222222";
const manager = "33333333-3333-4333-8333-333333333333";
const stranger = "44444444-4444-4444-8444-444444444444";
const job = "aaaaaaaa-0000-4000-8000-00000000000a";
const room = "bbbbbbbb-0000-4000-8000-00000000000b";

async function as(user, sql, params = []) {
  await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claim.sub', '${user}', false);`);
  await db.exec("SET ROLE authenticated;");
  try {
    return await db.query(sql, params);
  } finally {
    await db.exec("RESET ROLE;");
  }
}
async function refused(user, sql, params = []) {
  try {
    const r = await as(user, sql, params);
    return r.affectedRows === 0;
  } catch {
    return true;
  }
}

try {
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    INSERT INTO auth.users VALUES ('${crew}'), ('${crew2}'), ('${manager}'), ('${stranger}');
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, anon;

    CREATE TABLE public.jobs (id uuid PRIMARY KEY);
    CREATE TABLE public.job_rooms (id uuid PRIMARY KEY,
      job_id uuid REFERENCES public.jobs(id) ON DELETE CASCADE);
    CREATE TABLE public.job_people (job_id uuid, user_id uuid, manage boolean);

    CREATE FUNCTION public.can_view_job(_user_id uuid, _job_id uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT EXISTS (SELECT 1 FROM public.job_people WHERE user_id = _user_id AND job_id = _job_id);
    $$;
    CREATE FUNCTION public.can_manage_job(_user_id uuid, _job_id uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT EXISTS (SELECT 1 FROM public.job_people
                      WHERE user_id = _user_id AND job_id = _job_id AND manage);
    $$;
    CREATE FUNCTION public.update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW.updated_at := now(); RETURN NEW; END; $$;
    GRANT EXECUTE ON FUNCTION public.can_view_job(uuid, uuid), public.can_manage_job(uuid, uuid)
      TO authenticated;

    INSERT INTO public.jobs VALUES ('${job}');
    INSERT INTO public.job_rooms VALUES ('${room}', '${job}');
    INSERT INTO public.job_people VALUES
      ('${job}', '${crew}', false), ('${job}', '${crew2}', false), ('${job}', '${manager}', true);
  `);

  await db.exec(migration);
  await db.exec(migration); // re-runnable

  // 1. Crew add lines as themselves.
  await as(
    crew,
    `INSERT INTO public.job_write_up_items (job_id, room_id, visit_date, description, quantity, unit)
     VALUES ($1, $2, '2026-10-28', 'Flood cut 2 ft', 48, 'LF')`,
    [job, room],
  );
  const mine = await as(crew, "SELECT created_by FROM public.job_write_up_items");
  check(
    mine.rows.length === 1 && mine.rows[0].created_by === crew,
    "crew adds a line as themselves",
  );
  check(
    await refused(
      crew,
      `INSERT INTO public.job_write_up_items (job_id, description, created_by) VALUES ($1, 'x', $2)`,
      [job, crew2],
    ),
    "nobody writes a line in someone else's name",
  );
  check(
    await refused(
      crew,
      `INSERT INTO public.job_write_up_items (job_id, description) VALUES ($1, '  ')`,
      [job],
    ),
    "an empty description is refused",
  );

  // 2. A stranger sees and writes nothing.
  const seen = await as(stranger, "SELECT id FROM public.job_write_up_items");
  check(seen.rows.length === 0, "someone off the job reads nothing");
  check(
    await refused(
      stranger,
      `INSERT INTO public.job_write_up_items (job_id, description) VALUES ($1, 'x')`,
      [job],
    ),
    "someone off the job writes nothing",
  );

  // 3. Writer or manager changes; a teammate cannot.
  check(
    await refused(crew2, "UPDATE public.job_write_up_items SET description = 'changed'"),
    "a teammate cannot change another's line",
  );
  check(
    await refused(crew2, "DELETE FROM public.job_write_up_items"),
    "a teammate cannot remove another's line",
  );
  const own = await as(crew, "UPDATE public.job_write_up_items SET quantity = 50");
  check(own.affectedRows === 1, "the writer changes their own line");
  const both = await as(crew2, "SELECT count(*)::int AS n FROM public.job_write_up_items");
  check(both.rows[0].n === 1, "a teammate still reads it");
  await as(
    crew2,
    `INSERT INTO public.job_write_up_items (job_id, description) VALUES ($1, 'Set 2 dehus')`,
    [job],
  );
  const managed = await as(
    manager,
    "DELETE FROM public.job_write_up_items WHERE description = 'Set 2 dehus'",
  );
  check(managed.affectedRows === 1, "a job manager removes any line");

  // 4. Room and job deletes.
  await db.exec(`DELETE FROM public.job_rooms WHERE id = '${room}'`);
  const kept = await db.query("SELECT room_id FROM public.job_write_up_items");
  check(kept.rows.length === 1 && kept.rows[0].room_id === null, "a deleted room leaves its lines");
  await db.exec(`DELETE FROM public.jobs WHERE id = '${job}'`);
  const gone = await db.query("SELECT count(*)::int AS n FROM public.job_write_up_items");
  check(gone.rows[0].n === 0, "a deleted job takes its lines");

  const anon = await db.query(
    "SELECT has_table_privilege('anon', 'public.job_write_up_items', 'SELECT') AS s",
  );
  check(anon.rows[0].s === false, "anon cannot read the table");

  console.log(`job-write-ups.pglite: ${assertions} assertions passed`);
} finally {
  await db.close();
}
