// Run with: node supabase/tests/todo-items.pglite.mjs <existing PGlite dist/index.js>
// In-memory fixtures only. No connection string, network access or live writes.
//
// The to-do list's row boundary. Mark: "a to do list ... which would be user
// specific". The migration under test is READ FROM THE FILE, never retyped
// here, so this cannot drift from what ships.
//
// What it proves:
//   1. a rep sees their own rows and nobody else's, on all four verbs;
//   2. a row cannot be filed as somebody else (WITH CHECK);
//   3. deleting the task deletes the pin (ON DELETE CASCADE); deleting the
//      job leaves the quick item, now under "No job" (ON DELETE SET NULL);
//   4. a quick item needs a title; one pin per task per person, and the
//      same task pinned by two people is two rows;
//   5. promote_todo_item makes the task and turns the item into its pin in
//      ONE transaction: a failure on the second write rolls back the first,
//      a replay with the same task id is a no-op, a stranger's item raises.
//
// The surrounding tables (tasks, jobs, profiles, location_members) are
// stubs with only the columns the migration touches. auth.uid() reads a
// session setting, the way the other fixtures in this directory do it.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
const migration = (name) =>
  readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8");

let assertions = 0;
const check = (value, what) => {
  assert.equal(value, true, what);
  assertions++;
};

const rep = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const office = "66666666-6666-4666-8666-666666666666";
const otherOffice = "77777777-7777-4777-8777-777777777777";
const job = "88888888-8888-4888-8888-888888888888";
const account = "99999999-9999-4999-8999-999999999999";
const task = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const task2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

try {
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;

    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

    CREATE TABLE public.jobs (
      id uuid PRIMARY KEY,
      location_id uuid,
      account_id uuid
    );
    CREATE TABLE public.profiles (
      user_id uuid PRIMARY KEY,
      primary_location_id uuid
    );
    CREATE TABLE public.location_members (
      user_id uuid NOT NULL,
      location_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    -- tasks, column for column as the function inserts them, with the same
    -- insert policy production has: created_by must be the caller.
    CREATE TABLE public.tasks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      title text NOT NULL,
      assignee uuid,
      due_date date,
      priority text NOT NULL DEFAULT 'normal',
      status text NOT NULL DEFAULT 'open',
      source text NOT NULL DEFAULT 'manual',
      job_id uuid REFERENCES public.jobs(id) ON DELETE CASCADE,
      account_id uuid,
      location_id uuid,
      entity_type text,
      entity_id uuid,
      created_by uuid,
      completed_at timestamptz
    );
    ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "tasks visible in scope" ON public.tasks FOR SELECT TO authenticated
      USING (assignee = auth.uid() OR created_by = auth.uid());
    CREATE POLICY "tasks insert" ON public.tasks FOR INSERT TO authenticated
      WITH CHECK (created_by = auth.uid());
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.tasks TO authenticated;
    GRANT SELECT ON public.jobs, public.profiles, public.location_members TO authenticated;

    INSERT INTO public.jobs VALUES ('${job}', '${office}', '${account}');
    INSERT INTO public.profiles VALUES ('${rep}', '${otherOffice}'), ('${other}', NULL);
    INSERT INTO public.tasks (id, title, assignee, created_by, job_id)
      VALUES ('${task}', 'Pull equipment', '${other}', '${other}', '${job}'),
             ('${task2}', 'Call adjuster', '${rep}', '${rep}', NULL);
  `);

  /* ---- The migration, verbatim ---------------------------------------- */
  await db.exec(migration("20260918120000_todo_items.sql"));

  /** Run one statement as a signed-in user; never leaves the role set. */
  const as = async (uid, sql) => {
    await db.exec(`SET ROLE authenticated; SET request.jwt.claim.sub = '${uid}'`);
    try {
      return await db.query(sql);
    } finally {
      await db.exec("RESET ROLE; SELECT set_config('request.jwt.claim.sub','',false)");
    }
  };
  const count = async (uid, where = "true") =>
    (await as(uid, `SELECT count(*)::int AS n FROM public.todo_items WHERE ${where}`)).rows[0].n;
  const total = async () =>
    (await db.query("SELECT count(*)::int AS n FROM public.todo_items")).rows[0].n;

  /* ---- 1 & 2: owner only ---------------------------------------------- */
  await as(rep, `INSERT INTO public.todo_items (id, title, job_id)
                 VALUES ('c1c1c1c1-0000-4000-8000-000000000001', 'Pick up filters', '${job}')`);
  await as(rep, `INSERT INTO public.todo_items (id, task_id)
                 VALUES ('c1c1c1c1-0000-4000-8000-000000000002', '${task}')`);
  await as(other, `INSERT INTO public.todo_items (title) VALUES ('Order tarps')`);

  check((await total()) === 3, "three rows filed by two people");
  check((await count(rep)) === 2, "the rep sees their own two rows");
  check((await count(other)) === 1, "the other rep sees only their one");
  check(
    (await count(rep, `title = 'Order tarps'`)) === 0,
    "a colleague's quick item is invisible, not just filtered",
  );
  // user_id defaults to auth.uid(): a row inserted without naming it is yours.
  check(
    (await db.query(`SELECT user_id FROM public.todo_items WHERE title = 'Order tarps'`)).rows[0]
      .user_id === other,
    "user_id defaults to the caller",
  );

  await assert.rejects(
    as(rep, `INSERT INTO public.todo_items (user_id, title) VALUES ('${other}', 'Forged')`),
    /row-level security/i,
    "filing a row as somebody else is refused",
  );
  assertions++;

  const upd = await as(rep, `UPDATE public.todo_items SET title = 'x' WHERE title = 'Order tarps'`);
  check(upd.affectedRows === 0, "updating a colleague's row touches nothing");
  const del = await as(rep, `DELETE FROM public.todo_items WHERE title = 'Order tarps'`);
  check(del.affectedRows === 0, "deleting a colleague's row touches nothing");
  check((await total()) === 3, "and the row is still there");

  // No manager read: nothing in the policies consults an office or a role.
  const policies = (
    await db.query(
      `SELECT qual, with_check FROM pg_policies WHERE tablename = 'todo_items'`,
    )
  ).rows;
  check(policies.length === 4, "exactly four policies, one per verb");
  check(
    policies.every((p) => !/location|has_role/.test(`${p.qual ?? ""} ${p.with_check ?? ""}`)),
    "no policy reaches past the owner",
  );

  /* ---- 3: cascades ---------------------------------------------------- */
  // The rep's pin is on a task assigned to the OTHER rep — "including one
  // assigned to someone else that I want to keep an eye on" — so the pin's
  // task_id can point at a task its owner did not create.
  await db.query(`DELETE FROM public.tasks WHERE id = '${task}'`);
  check(
    (await count(rep, `task_id IS NOT NULL`)) === 0,
    "deleting the task deletes the pin",
  );
  check((await count(rep)) === 1, "the quick item survives");

  await db.query(`DELETE FROM public.jobs WHERE id = '${job}'`);
  check(
    (await count(rep, `title = 'Pick up filters' AND job_id IS NULL`)) === 1,
    "deleting the job keeps the quick item, now under No job",
  );
  await db.query(`INSERT INTO public.jobs VALUES ('${job}', '${office}', '${account}')`);

  /* ---- 4: shape constraints ------------------------------------------- */
  await assert.rejects(
    as(rep, `INSERT INTO public.todo_items (title) VALUES ('   ')`),
    /todo_items_quick_needs_title/,
    "a quick item with no title is refused",
  );
  assertions++;
  await assert.rejects(
    as(rep, `INSERT INTO public.todo_items (title) VALUES (NULL)`),
    /todo_items_quick_needs_title/,
    "a null title without a task is refused",
  );
  assertions++;

  await as(rep, `INSERT INTO public.todo_items (task_id) VALUES ('${task2}')`);
  await assert.rejects(
    as(rep, `INSERT INTO public.todo_items (task_id) VALUES ('${task2}')`),
    /todo_items_one_pin_per_task/,
    "pinning the same task twice is refused",
  );
  assertions++;
  // ...which is what makes ON CONFLICT DO NOTHING a replay-safe pin.
  const replay = await as(
    rep,
    `INSERT INTO public.todo_items (task_id) VALUES ('${task2}') ON CONFLICT (user_id, task_id) DO NOTHING`,
  );
  check(replay.affectedRows === 0, "a replayed pin is a no-op");
  await as(other, `INSERT INTO public.todo_items (task_id) VALUES ('${task2}')`);
  check(
    (await db.query(`SELECT count(*)::int AS n FROM public.todo_items WHERE task_id = '${task2}'`))
      .rows[0].n === 2,
    "two people can pin the same task",
  );

  /* ---- 5: promote_todo_item ------------------------------------------- */
  const quick = "c1c1c1c1-0000-4000-8000-000000000001";
  await db.query(`UPDATE public.todo_items SET job_id = '${job}' WHERE id = '${quick}'`);
  const newTask = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

  await assert.rejects(
    as(other, `SELECT public.promote_todo_item('${quick}', '${newTask}', NULL)`),
    /no longer on your list/,
    "a stranger cannot promote my item",
  );
  assertions++;
  check(
    (await db.query(`SELECT count(*)::int AS n FROM public.tasks WHERE id = '${newTask}'`)).rows[0]
      .n === 0,
    "and no task was filed for them",
  );

  // Atomicity: make the SECOND write fail and prove the first rolled back.
  await db.exec(`
    CREATE FUNCTION public.todo_test_refuse() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'simulated failure on the item update'; END $$;
    CREATE TRIGGER todo_test_refuse BEFORE UPDATE ON public.todo_items
      FOR EACH ROW WHEN (NEW.task_id IS NOT NULL) EXECUTE FUNCTION public.todo_test_refuse();
  `);
  await assert.rejects(
    as(rep, `SELECT public.promote_todo_item('${quick}', '${newTask}', DATE '2026-09-20')`),
    /simulated failure/,
    "the item update failing surfaces",
  );
  assertions++;
  check(
    (await db.query(`SELECT count(*)::int AS n FROM public.tasks WHERE id = '${newTask}'`)).rows[0]
      .n === 0,
    "the task insert rolled back with it — no task without its pin",
  );
  check(
    (await db.query(`SELECT task_id FROM public.todo_items WHERE id = '${quick}'`)).rows[0]
      .task_id === null,
    "the item is still a quick item",
  );
  await db.exec(`DROP TRIGGER todo_test_refuse ON public.todo_items; DROP FUNCTION public.todo_test_refuse();`);

  // The happy path.
  const promoted = await as(
    rep,
    `SELECT public.promote_todo_item('${quick}', '${newTask}', DATE '2026-09-20') AS id`,
  );
  check(promoted.rows[0].id === newTask, "returns the task id it was given");
  const t = (await db.query(`SELECT *, due_date::text AS due_text FROM public.tasks WHERE id = '${newTask}'`)).rows[0];
  check(!!t, "the task exists");
  check(t.title === "Pick up filters", "with the item's title");
  check(t.assignee === rep && t.created_by === rep, "assigned to and created by the caller");
  check(t.job_id === job && t.account_id === account, "on the item's job and its account");
  check(t.location_id === office, "in the job's office, not the caller's own");
  check(t.source === "todo" && t.status === "open", "source todo, status open");
  check(t.due_text === "2026-09-20", "with the due date given");
  check(t.entity_type === "job" && t.entity_id === job, "linked the way the task dialog links a job task");
  const it = (await db.query(`SELECT * FROM public.todo_items WHERE id = '${quick}'`)).rows[0];
  check(it.task_id === newTask && it.job_id === null, "the item is now the pin for that task");

  // Replay with the same task id: a no-op, not a second task.
  const again = await as(rep, `SELECT public.promote_todo_item('${quick}', '${newTask}', NULL) AS id`);
  check(again.rows[0].id === newTask, "a replay returns the same id");
  check(
    (await db.query(`SELECT count(*)::int AS n FROM public.tasks WHERE title = 'Pick up filters'`))
      .rows[0].n === 1,
    "and files no second task",
  );
  // A different task id against an already-promoted item is a real conflict.
  await assert.rejects(
    as(rep, `SELECT public.promote_todo_item('${quick}', gen_random_uuid(), NULL)`),
    /already a task/,
    "promoting a pin again is refused",
  );
  assertions++;

  // Location fallback: no job -> the caller's primary office.
  const loose = "c1c1c1c1-0000-4000-8000-000000000009";
  await as(rep, `INSERT INTO public.todo_items (id, title) VALUES ('${loose}', 'Renew DOT card')`);
  const looseTask = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  await as(rep, `SELECT public.promote_todo_item('${loose}', '${looseTask}', NULL)`);
  const lt = (await db.query(`SELECT * FROM public.tasks WHERE id = '${looseTask}'`)).rows[0];
  check(lt.job_id === null && lt.location_id === otherOffice, "no job: the caller's primary office");

  // Signed out is refused before anything is read.
  await db.exec("SET ROLE authenticated");
  try {
    await assert.rejects(
      db.query(`SELECT public.promote_todo_item('${loose}', gen_random_uuid(), NULL)`),
      /Sign in/,
      "no session, no promotion",
    );
    assertions++;
  } finally {
    await db.exec("RESET ROLE");
  }

  check(
    (await db.query(
      `SELECT has_function_privilege('anon', 'public.promote_todo_item(uuid,uuid,date)', 'EXECUTE') AS ok`,
    )).rows[0].ok === false,
    "anon cannot call it",
  );

  console.log(`todo-items.pglite: ${assertions} assertions passed`);
} finally {
  await db.close();
}
