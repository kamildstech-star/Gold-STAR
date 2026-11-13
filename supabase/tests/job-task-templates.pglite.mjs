// Run with: node supabase/tests/job-task-templates.pglite.mjs <existing PGlite dist/index.js>
// In-memory fixtures only. No connection string, network access or live writes.
//
// Job checklists as data, and the retroactive pass. Mark: "i dont see the
// tasks live, it should work retroactively" and "like this for tasks". The
// migration under test is READ FROM THE FILE, never retyped here.
//
// What it proves:
//   1. templates and switches: every signed-in staff member reads them, only
//      owner / admin / dev (is_privileged — the Supply catalog's rule) writes,
//      nobody deletes, portal customers are denied; a line's key cannot be
//      changed by an edit;
//   2. the seeded-key ledger: primed from today's tasks, filled by a trigger
//      on every automatic insert, kept after the task is deleted, readable
//      with the job, writable by nobody directly;
//   3. sync_job_automatic_tasks: dry run (the default) writes nothing and
//      reports what it would do; the real run adds the lists to OPEN jobs by
//      service category, Remediation only where already triggered,
//      Monitoring and Pick up only where a unit is on site and the switch
//      allows; it skips closed jobs, unmapped categories, inactive lines and
//      deleted tasks; leaves done tasks done and renames open ones; dates
//      Monitoring by the drying window and Pick up by expected retrieval;
//   4. running it twice adds nothing the second time;
//   5. the narrow mode the admin screen uses only extends groups a job
//      already has;
//   6. a non-admin cannot run it; anon cannot even call it.
//
// The surrounding tables are stubs with only the columns the migration
// touches. auth.uid() reads a session setting, as the other fixtures do.
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

const admin = "11111111-1111-4111-8111-111111111111";
const crew = "22222222-2222-4222-8222-222222222222"; // sees jobs in office A only
const office = "66666666-6666-4666-8666-666666666666";
const otherOffice = "77777777-7777-4777-8777-777777777777";

// One job per case.
const J = {
  freshWater: "a0000000-0000-4000-8000-000000000001", // open water, nothing on it
  worked: "a0000000-0000-4000-8000-000000000002", // open water, list already worked
  mold: "a0000000-0000-4000-8000-000000000003", // open mold, a scrubber on site
  paid: "a0000000-0000-4000-8000-000000000004", // water, paid
  fireBack: "a0000000-0000-4000-8000-000000000005", // open fire, gear all collected
  remediation: "a0000000-0000-4000-8000-000000000006", // open water, more work flagged
  rebuild: "a0000000-0000-4000-8000-000000000007", // open reconstruction (unmapped)
  waterGear: "a0000000-0000-4000-8000-000000000008", // open water, units on site, a reset
  otherOffice: "a0000000-0000-4000-8000-000000000009", // open mold in another office
};
const key = (job, group, task) => `job-scope:${job}:${group}:${task}`;

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

    CREATE TABLE public.user_roles (user_id uuid, role text);
    CREATE FUNCTION public.is_privileged(_user_id uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
      $$ SELECT EXISTS (SELECT 1 FROM public.user_roles
                         WHERE user_id = _user_id AND role IN ('owner', 'admin', 'dev')) $$;
    -- 20260927120000, verbatim body.
    CREATE FUNCTION public.gsr_local_date(_at timestamptz) RETURNS date
      LANGUAGE sql IMMUTABLE SET search_path = '' AS
      $$ SELECT (_at AT TIME ZONE 'America/New_York')::date $$;

    CREATE TABLE public.jobs (
      id uuid PRIMARY KEY,
      status text NOT NULL,
      loss_type text,
      location_id uuid NOT NULL,
      account_id uuid,
      crew_chief uuid,
      additional_work_pending boolean NOT NULL DEFAULT false
    );
    CREATE TABLE public.location_members (user_id uuid, location_id uuid);
    CREATE FUNCTION public.can_view_job(_user_id uuid, _job_id uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
      $$ SELECT public.is_privileged(_user_id) OR EXISTS (
           SELECT 1 FROM public.jobs j JOIN public.location_members m
             ON m.location_id = j.location_id
          WHERE j.id = _job_id AND m.user_id = _user_id) $$;

    CREATE TABLE public.tasks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      title text NOT NULL,
      description text,
      assignee uuid,
      due_date date,
      priority text NOT NULL DEFAULT 'normal',
      status text NOT NULL DEFAULT 'open',
      entity_type text,
      entity_id uuid,
      account_id uuid,
      job_id uuid REFERENCES public.jobs(id) ON DELETE CASCADE,
      location_id uuid,
      source text NOT NULL DEFAULT 'manual',
      cadence_key text,
      created_by uuid,
      completed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX tasks_cadence_uniq ON public.tasks (cadence_key) WHERE cadence_key IS NOT NULL;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.tasks TO authenticated;

    CREATE TABLE public.equipment_placements (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
      placed_at timestamptz NOT NULL,
      expected_retrieval_date date,
      retrieved_at timestamptz
    );
    CREATE TABLE public.job_drying_resets (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
      reset_at timestamptz NOT NULL
    );

    INSERT INTO public.user_roles VALUES ('${admin}', 'admin'), ('${crew}', 'field');
    INSERT INTO public.location_members VALUES ('${crew}', '${office}');
    INSERT INTO public.jobs (id, status, loss_type, location_id, crew_chief, additional_work_pending) VALUES
      ('${J.freshWater}', 'new', 'water_mitigation', '${office}', '${crew}', false),
      ('${J.worked}', 'in_progress', 'water', '${office}', '${crew}', false),
      ('${J.mold}', 'scheduled', 'mold_remediation', '${office}', NULL, false),
      ('${J.paid}', 'paid', 'water_mitigation', '${office}', NULL, false),
      ('${J.fireBack}', 'in_progress', 'fire_smoke_cleaning', '${office}', NULL, false),
      ('${J.remediation}', 'drying', 'water_mitigation', '${office}', NULL, true),
      ('${J.rebuild}', 'in_progress', 'reconstruction', '${office}', NULL, false),
      ('${J.waterGear}', 'drying', 'water_mitigation', '${office}', NULL, false),
      ('${J.otherOffice}', 'new', 'mold', '${otherOffice}', NULL, false);

    INSERT INTO public.equipment_placements (job_id, placed_at, expected_retrieval_date, retrieved_at) VALUES
      ('${J.mold}', '2026-09-01T14:00:00Z', '2026-09-05', NULL),
      ('${J.fireBack}', '2026-09-01T14:00:00Z', '2026-09-04', '2026-09-04T15:00:00Z'),
      ('${J.waterGear}', '2026-09-01T14:00:00Z', '2026-09-09', NULL),
      ('${J.waterGear}', '2026-09-01T15:00:00Z', '2026-09-11', NULL),
      ('${J.waterGear}', '2026-09-01T16:00:00Z', '2026-09-03', '2026-09-03T12:00:00Z'),
      ('${J.otherOffice}', '2026-09-01T14:00:00Z', '2026-09-05', NULL);
    -- 9pm in New Jersey on the 6th is already the 7th in UTC: the window ends
    -- 72 hours later, on the 9th by the office calendar, not the 10th.
    INSERT INTO public.job_drying_resets (job_id, reset_at)
      VALUES ('${J.waterGear}', '2026-09-07T01:00:00Z');

    -- The worked job, seeded before the ledger existed: Inspection done,
    -- Pictures still under an old title, Scope of work deleted later (below).
    INSERT INTO public.tasks (title, status, job_id, source, cadence_key, created_at) VALUES
      ('Inspection', 'done', '${J.worked}', 'job_scope:water_extraction', '${key(J.worked, "water_extraction", "inspection")}', '2026-09-01'),
      ('Extraction', 'open', '${J.worked}', 'job_scope:water_extraction', '${key(J.worked, "water_extraction", "extraction")}', '2026-09-01'),
      ('Readings', 'open', '${J.worked}', 'job_scope:water_extraction', '${key(J.worked, "water_extraction", "readings")}', '2026-09-01'),
      ('Set up equipment — scan', 'done', '${J.worked}', 'job_scope:water_extraction', '${key(J.worked, "water_extraction", "setup_equipment_scan")}', '2026-09-01'),
      ('Scope of work – if needed', 'open', '${J.worked}', 'job_scope:water_extraction', '${key(J.worked, "water_extraction", "scope_if_needed")}', '2026-09-01'),
      ('Photos', 'open', '${J.worked}', 'job_scope:water_extraction', '${key(J.worked, "water_extraction", "pictures")}', '2026-09-01'),
      ('Call the adjuster', 'open', '${J.worked}', 'manual', NULL, '2026-09-01');
  `);

  /* ---- The migration, verbatim ---------------------------------------- */
  await db.exec(migration("20261006174500_job_task_templates.sql"));

  const as = async (uid, sql, role = "authenticated") => {
    await db.exec(`SET ROLE ${role}; SET request.jwt.claim.sub = '${uid ?? ""}'`);
    try {
      return await db.query(sql);
    } finally {
      await db.exec("RESET ROLE; SELECT set_config('request.jwt.claim.sub','',false)");
    }
  };
  const one = async (sql) => (await db.query(sql)).rows[0];
  const n = async (sql) => (await one(`SELECT count(*)::int AS n FROM (${sql}) q`)).n;
  const tasksOn = (job, extra = "true") =>
    n(
      `SELECT 1 FROM public.tasks WHERE job_id = '${job}' AND cadence_key IS NOT NULL AND ${extra}`,
    );
  const sync = async (dry = true, seededOnly = false) =>
    (await one(`SELECT public.sync_job_automatic_tasks(${dry}, ${seededOnly}) AS r`)).r;

  /* ---- 1: templates and switches -------------------------------------- */
  check((await n(`SELECT 1 FROM public.job_task_templates`)) === 53, "Mark's 53 lines are seeded");
  check(
    (await n(`SELECT 1 FROM public.job_task_seeding_settings WHERE seed_equipment_tasks`)) === 2,
    "Mold and Fire equipment seeding both default on",
  );
  check(
    (await as(crew, `SELECT count(*)::int AS n FROM public.job_task_templates`)).rows[0].n === 53,
    "a crew member reads every line (the seeding runs as them)",
  );
  check(
    (await as(crew, `SELECT count(*)::int AS n FROM public.job_task_seeding_settings`)).rows[0]
      .n === 2,
    "and reads the switches",
  );
  await refuses(
    as(
      crew,
      `INSERT INTO public.job_task_templates (group_key, title) VALUES ('fire_smoke', 'Nope')`,
    ),
    /row-level security/i,
    "a crew member cannot add a line",
  );
  check(
    (
      await as(
        crew,
        `UPDATE public.job_task_templates SET title = 'Nope' WHERE group_key = 'fire_smoke'`,
      )
    ).affectedRows === 0,
    "a crew member cannot rename a line",
  );
  check(
    (await as(crew, `UPDATE public.job_task_seeding_settings SET seed_equipment_tasks = false`))
      .affectedRows === 0,
    "a crew member cannot flip a switch",
  );
  const added = await as(
    admin,
    `INSERT INTO public.job_task_templates (group_key, title, sort_order)
     VALUES ('water_extraction', 'Moisture map', 70) RETURNING task_key, updated_by`,
  );
  check(/^t_[0-9a-f]{12}$/.test(added.rows[0].task_key), "a new line gets a generated key");
  check(added.rows[0].updated_by === admin, "and records who added it");
  const newKey = added.rows[0].task_key;
  await as(
    admin,
    `UPDATE public.job_task_templates SET title = 'Moisture map – every room', task_key = 'hijack'
      WHERE task_key = '${newKey}'`,
  );
  check(
    (await n(`SELECT 1 FROM public.job_task_templates WHERE task_key = '${newKey}'
              AND title = 'Moisture map – every room'`)) === 1,
    "an admin renames a line, and its key survives an attempt to change it",
  );
  await refuses(
    as(admin, `DELETE FROM public.job_task_templates WHERE task_key = '${newKey}'`),
    /permission denied/i,
    "nobody deletes a line — it is switched off instead",
  );
  await refuses(
    as(admin, `INSERT INTO public.job_task_templates (group_key, title) VALUES ('roofing', 'x')`),
    /check constraint/i,
    "a line belongs to one of the six groups",
  );
  for (const table of ["job_task_templates", "job_task_seeding_settings", "job_task_seed_keys"]) {
    const p = (
      await db.query(`SELECT permissive FROM pg_policies
                       WHERE tablename = '${table}' AND policyname = 'portal_customer_denied'`)
    ).rows;
    check(p.length === 1 && p[0].permissive === "RESTRICTIVE", `${table} denies portal customers`);
  }
  // Even with a grant somebody added by mistake, the restrictive policy holds.
  await db.exec(`GRANT SELECT ON public.job_task_templates TO portal_customer`);
  check(
    (await as(admin, `SELECT count(*)::int AS n FROM public.job_task_templates`, "portal_customer"))
      .rows[0].n === 0,
    "a portal customer sees no lines even holding a stray grant",
  );
  await db.exec(`REVOKE SELECT ON public.job_task_templates FROM portal_customer`);

  /* ---- 2: the ledger --------------------------------------------------- */
  check(
    (await n(`SELECT 1 FROM public.job_task_seed_keys WHERE job_id = '${J.worked}'`)) === 6,
    "the ledger is primed with the six automatic tasks already on a job, not the manual one",
  );
  await db.exec(
    `DELETE FROM public.tasks WHERE cadence_key = '${key(J.worked, "water_extraction", "scope_if_needed")}'`,
  );
  check(
    (await n(`SELECT 1 FROM public.job_task_seed_keys WHERE cadence_key =
              '${key(J.worked, "water_extraction", "scope_if_needed")}'`)) === 1,
    "a deleted task's key stays in the ledger",
  );
  await as(
    crew,
    `INSERT INTO public.tasks (title, job_id, source, cadence_key, created_by)
     VALUES ('Readings', '${J.otherOffice}', 'job_scope:mold_remediation',
             '${key(J.otherOffice, "mold_remediation", "readings_x")}', '${crew}')`,
  );
  check(
    (await n(`SELECT 1 FROM public.job_task_seed_keys WHERE job_id = '${J.otherOffice}'`)) === 1,
    "an automatic task inserted by anyone is recorded, though they cannot write the ledger",
  );
  await db.exec(`DELETE FROM public.tasks WHERE job_id = '${J.otherOffice}'`);
  await db.exec(`DELETE FROM public.job_task_seed_keys WHERE job_id = '${J.otherOffice}'`);
  check(
    (await as(crew, `SELECT count(*)::int AS n FROM public.job_task_seed_keys`)).rows[0].n === 6,
    "the ledger reads with the job: the crew member sees their office's keys",
  );
  await refuses(
    as(
      admin,
      `INSERT INTO public.job_task_seed_keys (cadence_key, job_id)
               VALUES ('job-scope:x', '${J.freshWater}')`,
    ),
    /permission denied/i,
    "nobody writes the ledger directly, admins included",
  );
  await refuses(
    as(admin, `DELETE FROM public.job_task_seed_keys`),
    /permission denied/i,
    "nor clears it",
  );

  /* ---- 3: the dry run --------------------------------------------------- */
  // Switch the new line off again for now; it comes back in step 5.
  await as(
    admin,
    `UPDATE public.job_task_templates SET active = false WHERE task_key = '${newKey}'`,
  );
  const before = await n(`SELECT 1 FROM public.tasks`);
  const dry = await sync();
  check(dry.dry_run === true, "the default is a dry run");
  check((await n(`SELECT 1 FROM public.tasks`)) === before, "a dry run writes nothing");
  // freshWater 6, worked 0 (one deleted, rest present), mold 10+3+5,
  // fireBack 12, remediation 6+17, waterGear 6+3+5, otherOffice 10+3+5.
  const expected = 6 + 18 + 12 + 23 + 14 + 18;
  check(
    dry.tasks_added === expected,
    `the dry run counts ${expected} tasks (got ${dry.tasks_added})`,
  );
  check(dry.jobs_gaining_tasks === 6, "on six jobs");
  check(dry.tasks_renamed === 1, "and one open task to rename (Photos → Pictures)");
  check(dry.open_jobs === 8, "out of eight open jobs");
  check(dry.skipped_previously_deleted === 1, "and reports the one deleted task it leaves alone");
  check(
    dry.added_by_group.water_monitoring === 9 && dry.added_by_group.water_pickup === 15,
    "Monitoring and Pick up on the three jobs with a unit on site",
  );
  await refuses(
    as(crew, `SELECT public.sync_job_automatic_tasks()`),
    /owner or admin/i,
    "a crew member cannot run it, not even dry",
  );
  await refuses(
    as(null, `SELECT public.sync_job_automatic_tasks()`, "anon"),
    /permission denied/i,
    "anon cannot call it",
  );
  await refuses(
    as(admin, `SELECT * FROM public.job_automatic_task_candidates(false)`),
    /permission denied/i,
    "the candidate list is internal",
  );
  check(
    (await as(admin, `SELECT public.sync_job_automatic_tasks() AS r`)).rows[0].r.tasks_added ===
      expected,
    "an admin can run the dry run from the app",
  );

  /* ---- 3: the real run -------------------------------------------------- */
  const real = await sync(false);
  check(
    real.tasks_added === expected && real.tasks_renamed === 1,
    "the real run does what the dry run said",
  );
  check((await tasksOn(J.freshWater)) === 6, "an existing water job has its Extraction list");
  check(
    (await n(`SELECT 1 FROM public.tasks WHERE job_id = '${J.freshWater}'
              AND assignee = '${crew}' AND status = 'open' AND source = 'job_scope:water_extraction'
              AND description = 'Automatically generated from the Water · Extraction checklist.'
              AND due_date = public.gsr_local_date(now())`)) === 6,
    "seeded like the app seeds: the crew chief's, open, due today, same description",
  );
  check(
    (await n(`SELECT 1 FROM public.job_task_seed_keys WHERE job_id = '${J.freshWater}'`)) === 6,
    "and the ledger now remembers them",
  );
  check((await tasksOn(J.worked)) === 5, "the deleted task was not put back");
  check(
    (
      await one(`SELECT status, title FROM public.tasks WHERE cadence_key =
                '${key(J.worked, "water_extraction", "inspection")}'`)
    ).status === "done",
    "a done task stays done",
  );
  check(
    (
      await one(`SELECT title FROM public.tasks WHERE cadence_key =
                '${key(J.worked, "water_extraction", "setup_equipment_scan")}'`)
    ).title === "Set up equipment — scan",
    "and keeps the words it was ticked under",
  );
  check(
    (
      await one(`SELECT title FROM public.tasks WHERE cadence_key =
                '${key(J.worked, "water_extraction", "pictures")}'`)
    ).title === "Pictures",
    "an open task takes the current title",
  );
  check(
    (await n(`SELECT 1 FROM public.tasks WHERE job_id = '${J.worked}' AND title = 'Call the adjuster'
              AND status = 'open'`)) === 1,
    "a manual task is untouched",
  );
  check((await tasksOn(J.paid)) === 0, "a paid job gets nothing");
  check((await tasksOn(J.rebuild)) === 0, "an unmapped service category gets nothing");
  check(
    (await tasksOn(J.fireBack)) === 12 &&
      (await tasksOn(J.fireBack, `source = 'job_scope:fire_smoke'`)) === 12,
    "a fire job whose gear is all back gets Fire and no equipment groups",
  );
  check(
    (await tasksOn(J.remediation, `source = 'job_scope:water_remediation'`)) === 17,
    "Remediation only where it was already triggered",
  );
  check(
    (await tasksOn(J.freshWater, `source = 'job_scope:water_remediation'`)) === 0,
    "and not on a water job without the flag",
  );
  check(
    (await tasksOn(J.mold, `source = 'job_scope:water_monitoring' AND due_date = '2026-09-04'`)) ===
      3,
    "Monitoring is due 72 hours after the first placement",
  );
  check(
    (await tasksOn(J.mold, `source = 'job_scope:water_pickup' AND due_date = '2026-09-05'`)) === 5,
    "Pick up is due on the expected retrieval date",
  );
  check(
    (await tasksOn(
      J.waterGear,
      `source = 'job_scope:water_monitoring' AND due_date = '2026-09-09'`,
    )) === 3,
    "a reset moves the window, read on the office calendar",
  );
  check(
    (await tasksOn(
      J.waterGear,
      `source = 'job_scope:water_pickup' AND due_date = '2026-09-09'`,
    )) === 5,
    "Pick up reads the units still on site, not one already collected",
  );
  check(
    (await tasksOn(J.freshWater, `title = 'Moisture map – every room'`)) === 0,
    "an inactive line is not seeded",
  );

  /* ---- 4: twice is once ------------------------------------------------- */
  const again = await sync(false);
  check(
    again.tasks_added === 0 && again.tasks_renamed === 0,
    "a second run adds and renames nothing",
  );

  /* ---- 5: an edit later, and the narrow mode ---------------------------- */
  await as(
    admin,
    `UPDATE public.job_task_templates SET active = true WHERE task_key = '${newKey}'`,
  );
  await as(
    admin,
    `UPDATE public.job_task_templates SET title = 'Readings – every room'
      WHERE group_key = 'water_extraction' AND task_key = 'readings'`,
  );
  // A water job that never had its list (created after the backfill, its
  // Tasks tab never opened): the narrow mode must leave it for the full run.
  await db.exec(`INSERT INTO public.jobs (id, status, loss_type, location_id)
                 VALUES ('a0000000-0000-4000-8000-0000000000ff', 'new', 'water', '${office}')`);
  const narrow = await as(admin, `SELECT public.sync_job_automatic_tasks(false, true) AS r`);
  const nr = narrow.rows[0].r;
  check(
    nr.tasks_added === 4,
    `the re-activated line reaches the four open jobs that have Water · Extraction (got ${nr.tasks_added})`,
  );
  check(
    (await tasksOn("a0000000-0000-4000-8000-0000000000ff")) === 0,
    "and not a job that never had the list",
  );
  check(
    (await tasksOn(J.mold, `title = 'Moisture map – every room'`)) === 0,
    "nor a job of another type",
  );
  check(
    nr.tasks_renamed === 4,
    `a rename reaches every open, unfinished Readings task (got ${nr.tasks_renamed})`,
  );
  check((await tasksOn(J.paid)) === 0, "a closed job is still left alone");

  /* ---- switches --------------------------------------------------------- */
  await as(
    admin,
    `UPDATE public.job_task_seeding_settings SET seed_equipment_tasks = false
                    WHERE job_scope = 'mold'`,
  );
  await db.exec(`INSERT INTO public.jobs (id, status, loss_type, location_id)
                 VALUES ('a0000000-0000-4000-8000-0000000000ee', 'new', 'mold', '${office}');
                 INSERT INTO public.equipment_placements (job_id, placed_at)
                 VALUES ('a0000000-0000-4000-8000-0000000000ee', '2026-09-02T12:00:00Z');`);
  const off = await sync(true);
  check(
    off.tasks_added === 10 + 7 && !off.added_by_group.water_monitoring,
    "with Mold switched off a new mold job with a scrubber gets Mold only (plus the fresh water job's list)",
  );
  check(
    (await tasksOn(
      J.mold,
      `source IN ('job_scope:water_monitoring', 'job_scope:water_pickup')
                             AND status = 'open'`,
    )) === 8,
    "and the mold job that already had Monitoring keeps it",
  );

  console.log(`job-task-templates.pglite: ${assertions} assertions passed`);
} finally {
  await db.close();
}
