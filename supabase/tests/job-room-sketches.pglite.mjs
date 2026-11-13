// Run with: node supabase/tests/job-room-sketches.pglite.mjs <existing PGlite dist/index.js>
// In-memory fixtures only. No connection string, network access or live writes.
//
// FE12 (migration 20261028130000): job_room_sketches. The migration is READ
// FROM THE FILE; jobs, job_rooms, documents and the job-access helpers are
// stubbed with the live signatures and meaning.
//
// What it proves:
//   1. Someone on the job adds a sketch as themselves; never as someone else.
//   2. Anyone on the job marks a sketch up; nobody off the job sees it.
//   3. Only the markup, name, room and floor can change — not the file.
//   4. A sketch is removed by whoever added it or a job manager.
//   5. A removed room unlinks its sketches; a non-array markup is refused;
//      the migration is re-runnable; anon reaches nothing.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
const FILE = "20261028130000_job_room_sketches.sql";
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
const doc = "cccccccc-0000-4000-8000-00000000000c";
const doc2 = "cccccccc-0000-4000-8000-00000000000d";

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

    CREATE TABLE public.documents (id uuid PRIMARY KEY);
    INSERT INTO public.documents VALUES ('${doc}'), ('${doc2}');
    INSERT INTO public.jobs VALUES ('${job}');
    INSERT INTO public.job_rooms VALUES ('${room}', '${job}');
    INSERT INTO public.job_people VALUES
      ('${job}', '${crew}', false), ('${job}', '${crew2}', false), ('${job}', '${manager}', true);
  `);

  await db.exec(migration);
  await db.exec(migration); // re-runnable

  const add = (user, by, d = doc) =>
    as(
      user,
      `INSERT INTO public.job_room_sketches (job_id, room_id, name, document_id, width, height, created_by)
       VALUES ($1, $2, 'Kitchen', $3, 2000, 1500, $4)`,
      [job, room, d, by],
    );

  // 1. Added as yourself only.
  await add(crew, crew);
  const rows = await as(crew, "SELECT created_by, annotations FROM public.job_room_sketches");
  check(
    rows.rows.length === 1 && rows.rows[0].created_by === crew,
    "crew adds a sketch as themselves",
  );
  check(
    Array.isArray(rows.rows[0].annotations) && rows.rows[0].annotations.length === 0,
    "markup starts empty",
  );
  let impersonated = false;
  try {
    await add(crew, crew2, doc2);
    impersonated = true;
  } catch {
    /* refused */
  }
  check(!impersonated, "nobody adds a sketch in someone else's name");

  // 2. Teammates mark up; strangers see nothing.
  const marked = await as(
    crew2,
    `UPDATE public.job_room_sketches SET annotations = '[{"kind":"marker","x":0.5,"y":0.5,"equipment":"dehumidifier"}]'`,
  );
  check(marked.affectedRows === 1, "a teammate marks the sketch up");
  const seen = await as(stranger, "SELECT id FROM public.job_room_sketches");
  check(seen.rows.length === 0, "someone off the job sees no sketch");
  check(
    await refused(stranger, "UPDATE public.job_room_sketches SET name = 'x'"),
    "someone off the job cannot mark it up",
  );

  // 3. The file and size stay put.
  check(
    await refused(crew, `UPDATE public.job_room_sketches SET document_id = '${doc2}'`),
    "the sketch's file cannot be swapped",
  );
  check(
    await refused(crew, "UPDATE public.job_room_sketches SET width = 10"),
    "its size cannot change",
  );

  // 4. Remove: writer or manager only.
  check(
    await refused(crew2, "DELETE FROM public.job_room_sketches"),
    "a teammate cannot remove it",
  );
  await add(crew2, crew2, doc2);
  const managed = await as(
    manager,
    `DELETE FROM public.job_room_sketches WHERE document_id = '${doc2}'`,
  );
  check(managed.affectedRows === 1, "a job manager removes any sketch");

  // 5. Room delete, bad markup, anon.
  let bad = false;
  try {
    await db.exec(`UPDATE public.job_room_sketches SET annotations = '{"kind":"area"}'`);
    bad = true;
  } catch {
    /* refused */
  }
  check(!bad, "markup must be a list");
  await db.exec(`DELETE FROM public.job_rooms WHERE id = '${room}'`);
  const kept = await db.query("SELECT room_id FROM public.job_room_sketches");
  check(
    kept.rows.length === 1 && kept.rows[0].room_id === null,
    "a removed room unlinks its sketch",
  );
  const anon = await db.query(
    "SELECT has_table_privilege('anon', 'public.job_room_sketches', 'SELECT') AS s",
  );
  check(anon.rows[0].s === false, "anon cannot read the table");

  console.log(`job-room-sketches.pglite: ${assertions} assertions passed`);
} finally {
  await db.close();
}
