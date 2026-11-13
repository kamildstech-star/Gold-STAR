// Run with: node supabase/tests/job-checklist-sections.pglite.mjs <existing PGlite dist/index.js>
// In-memory fixtures only. No connection string, network access or live writes.
//
// Mark, 13 Oct, on Settings › Operations › Job checklists: "these dont show
// up in the job", "let him turn off drying log", "also let him make a new
// section if he wants". Both migrations under test are READ FROM THE FILES,
// never retyped here: 20261006174500 (the tables and the retroactive pass)
// and then 20261013122000 (the Water switch, sections, the type fallback).
//
// What it proves:
//   1. the migration applies on top of 20261006174500 and again on top of
//      itself (re-runnable);
//   2. job types: a job whose legacy loss_type was left NULL is typed by the
//      picked option's key, then its label — it gets its checklists;
//   3. the Water switch: default on; off stops Monitoring and Pick up on
//      water jobs with gear and touches nothing already on a job; only an
//      admin flips it;
//   4. sections: staff read, only an admin adds / renames / switches / moves
//      them, a new one is never built-in and takes a generated key, what it
//      does cannot be edited afterwards, built-in rows are read-only;
//      template lines must belong to a section;
//   5. the pass adds a section's active lines by its types, trigger and due
//      rule, names it in the description, skips it when switched off, and
//      never adds a line twice; the narrow mode extends it where it is;
//   6. delete: only while no task was ever made from it (the ledger counts,
//      so deleting the tasks does not unlock it); its lines go with it;
//   7. the standard restrictive denials, and no anon grant.
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
const crew = "22222222-2222-4222-8222-222222222222";
const leaver = "33333333-3333-4333-8333-333333333333"; // an admin whose profile is switched off
const office = "66666666-6666-4666-8666-666666666666";

const opt = {
  water: "b0000000-0000-4000-8000-000000000001", // key the legacy mapping does not know
  mold: "b0000000-0000-4000-8000-000000000002",
  sewer: "b0000000-0000-4000-8000-000000000003",
};
const J = {
  nullType: "a0000000-0000-4000-8000-000000000001", // loss_type NULL, option "Water Mitigation", gear on site
  water: "a0000000-0000-4000-8000-000000000002", // water, gear on site
  waterBare: "a0000000-0000-4000-8000-000000000003", // water, no gear
  mold: "a0000000-0000-4000-8000-000000000004", // mold, gear on site
  sewer: "a0000000-0000-4000-8000-000000000005", // sewer: unmapped either way
  flagged: "a0000000-0000-4000-8000-000000000006", // water, more work flagged
};

try {
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS;
    CREATE ROLE portal_customer;
    CREATE SCHEMA auth;
    CREATE SCHEMA goldstar_private;
    GRANT USAGE ON SCHEMA public, auth, goldstar_private
      TO anon, authenticated, service_role, portal_customer;

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
    -- 20260927120000, verbatim body.
    CREATE FUNCTION public.gsr_local_date(_at timestamptz) RETURNS date
      LANGUAGE sql IMMUTABLE SET search_path = '' AS
      $$ SELECT (_at AT TIME ZONE 'America/New_York')::date $$;

    CREATE TABLE public.option_list_values (id uuid PRIMARY KEY, key text NOT NULL, label text NOT NULL);
    CREATE TABLE public.jobs (
      id uuid PRIMARY KEY,
      status text NOT NULL,
      loss_type text,
      loss_type_id uuid REFERENCES public.option_list_values(id),
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

    INSERT INTO public.profiles VALUES ('${admin}', true), ('${crew}', true), ('${leaver}', false);
    INSERT INTO public.user_roles VALUES ('${admin}', 'admin'), ('${crew}', 'field'), ('${leaver}', 'admin');
    INSERT INTO public.location_members VALUES ('${crew}', '${office}');
    INSERT INTO public.option_list_values VALUES
      ('${opt.water}', 'water_mitigation_res', 'Water Mitigation'),
      ('${opt.mold}', 'mold_remediation', 'Mold Remediation'),
      ('${opt.sewer}', 'sewer_cat3', 'Sewer / Category 3');
    INSERT INTO public.jobs (id, status, loss_type, loss_type_id, location_id, crew_chief, additional_work_pending) VALUES
      ('${J.nullType}', 'in_progress', NULL, '${opt.water}', '${office}', '${crew}', false),
      ('${J.water}', 'drying', 'water', NULL, '${office}', NULL, false),
      ('${J.waterBare}', 'new', 'water', NULL, '${office}', NULL, false),
      ('${J.mold}', 'scheduled', 'mold', '${opt.mold}', '${office}', NULL, false),
      ('${J.sewer}', 'in_progress', 'sewer', '${opt.sewer}', '${office}', NULL, false),
      ('${J.flagged}', 'in_progress', 'water', NULL, '${office}', NULL, true);
    INSERT INTO public.equipment_placements (job_id, placed_at, expected_retrieval_date) VALUES
      ('${J.nullType}', '2026-09-01T14:00:00Z', '2026-09-06'),
      ('${J.water}', '2026-09-01T14:00:00Z', '2026-09-08'),
      ('${J.mold}', '2026-09-01T14:00:00Z', '2026-09-05');
  `);

  /* ---- 1: both migrations, verbatim; the second one twice ------------- */
  await db.exec(migration("20261006174500_job_task_templates.sql"));

  const one = async (sql) => (await db.query(sql)).rows[0];
  const n = async (sql) => (await one(`SELECT count(*)::int AS n FROM (${sql}) q`)).n;
  const sync = async (dry = true, seededOnly = false) =>
    (await one(`SELECT public.sync_job_automatic_tasks(${dry}, ${seededOnly}) AS r`)).r;
  const as = async (uid, sql, role = "authenticated") => {
    await db.exec(`SET ROLE ${role}; SET request.jwt.claim.sub = '${uid ?? ""}'`);
    try {
      return await db.query(sql);
    } finally {
      await db.exec("RESET ROLE; SELECT set_config('request.jwt.claim.sub','',false)");
    }
  };
  const tasksOn = (job, extra = "true") =>
    n(
      `SELECT 1 FROM public.tasks WHERE job_id = '${job}' AND cadence_key IS NOT NULL AND ${extra}`,
    );

  // The bug, before the fix: the pass cannot type the job whose legacy
  // column was left NULL, so it would add nothing there.
  const before = await sync(true);
  check(
    !(
      await db.query(`SELECT 1 FROM public.job_automatic_task_candidates(false)
                       WHERE job_id = '${J.nullType}'`)
    ).rows.length,
    "before 20261013122000 the job typed only by its picked option gets nothing",
  );

  await db.exec(migration("20261013122000_job_checklist_sections.sql"));
  await db.exec(migration("20261013122000_job_checklist_sections.sql"));

  check(
    (await n(`SELECT 1 FROM public.job_task_sections WHERE builtin`)) === 6,
    "the six built-in sections are rows, once",
  );
  check(
    (await n(`SELECT 1 FROM public.job_task_templates`)) === 53,
    "Mark's 53 lines are untouched",
  );
  check(
    (await n(`SELECT 1 FROM public.job_task_seeding_settings`)) === 3 &&
      (await n(`SELECT 1 FROM public.job_task_seeding_settings
                 WHERE job_scope = 'water' AND seed_equipment_tasks`)) === 1,
    "the Water switch exists and is on, beside Mold and Fire",
  );

  /* ---- 2: the type, however it is spelled ----------------------------- */
  for (const [args, want] of [
    [`NULL, 'water_mitigation_res', 'Water Mitigation'`, "water"],
    [`'water', 'mold_remediation', 'Mold'`, "water"],
    [`NULL, NULL, 'Fire & Smoke Cleaning'`, "fire_smoke"],
    [`NULL, 'MOLD-REMEDIATION', NULL`, "mold"],
    [`'sewer', 'sewer_cat3', 'Sewer / Category 3'`, null],
  ]) {
    const got = (await one(`SELECT public.job_checklist_scope(${args}) AS s`)).s;
    check(got === want, `job_checklist_scope(${args}) is ${want} (got ${got})`);
  }
  const fixedDry = await sync(true);
  check(
    fixedDry.tasks_added === before.tasks_added + 6 + 3 + 5,
    `the job typed by its option now gains Extraction, Monitoring and Pick up (${before.tasks_added} → ${fixedDry.tasks_added})`,
  );

  /* ---- 3: the Water switch -------------------------------------------- */
  check(
    (
      await as(
        crew,
        `UPDATE public.job_task_seeding_settings SET seed_equipment_tasks = false
                      WHERE job_scope = 'water'`,
      )
    ).affectedRows === 0,
    "a crew member cannot flip the Water switch",
  );
  await refuses(
    as(admin, `INSERT INTO public.job_task_seeding_settings (job_scope) VALUES ('roofing')`),
    /check constraint/i,
    "a switch is one of the three job types",
  );
  // Seed the gear jobs first with Water on, so there is something to keep.
  await sync(false);
  check(
    (await tasksOn(J.water, `source = 'job_scope:water_monitoring'`)) === 3 &&
      (await tasksOn(J.water, `source = 'job_scope:water_pickup' AND due_date = '2026-09-08'`)) ===
        5,
    "with Water on, a water job with gear gets Monitoring and Pick up",
  );
  check(
    (await tasksOn(J.nullType)) === 6 + 3 + 5,
    "and the job typed by its picked option gets its whole list",
  );
  check((await tasksOn(J.sewer)) === 0, "a sewer job is still nobody's checklist");
  await as(
    admin,
    `INSERT INTO public.job_task_seeding_settings (job_scope, seed_equipment_tasks) VALUES ('water', false)
     ON CONFLICT (job_scope) DO UPDATE SET seed_equipment_tasks = EXCLUDED.seed_equipment_tasks`,
  );
  await db.exec(`INSERT INTO public.equipment_placements (job_id, placed_at)
                 VALUES ('${J.waterBare}', '2026-09-02T12:00:00Z')`);
  const waterOff = await sync(true);
  check(
    !waterOff.added_by_group.water_monitoring && !waterOff.added_by_group.water_pickup,
    "with Water off, gear newly on a water job adds no Monitoring or Pick up",
  );
  check(
    (await tasksOn(
      J.water,
      `source IN ('job_scope:water_monitoring', 'job_scope:water_pickup')
                             AND status = 'open'`,
    )) === 8,
    "and the water job that already had them keeps them, open",
  );
  await as(
    admin,
    `UPDATE public.job_task_seeding_settings SET seed_equipment_tasks = true
                    WHERE job_scope = 'water'`,
  );
  check(
    (await sync(true)).added_by_group.water_monitoring === 3,
    "switched back on, the newly equipped water job is due its Monitoring",
  );
  await sync(false);

  /* ---- 4: sections, who may do what ----------------------------------- */
  check(
    (await as(crew, `SELECT count(*)::int AS n FROM public.job_task_sections`)).rows[0].n === 6,
    "a crew member reads the sections (the seeding runs as them)",
  );
  await refuses(
    as(
      crew,
      `INSERT INTO public.job_task_sections (label, added_when, due_rule, job_scopes)
              VALUES ('Nope', 'job_type', 'sync', ARRAY['water'])`,
    ),
    /row-level security/i,
    "a crew member cannot add a section",
  );
  await refuses(
    as(
      admin,
      `INSERT INTO public.job_task_sections (label, builtin, added_when, due_rule, job_scopes)
               VALUES ('Fake', true, 'job_type', 'sync', ARRAY['water'])`,
    ),
    /row-level security/i,
    "an admin cannot add a 'built-in' section",
  );
  await refuses(
    as(
      admin,
      `INSERT INTO public.job_task_sections (key, label, added_when, due_rule, job_scopes)
               VALUES ('water_extraction_2', 'Mine', 'job_type', 'sync', ARRAY['water'])`,
    ),
    /row-level security/i,
    "nor choose its key",
  );
  await refuses(
    as(
      admin,
      `INSERT INTO public.job_task_sections (label, added_when, due_rule, job_scopes)
               VALUES ('On status', 'status', 'sync', ARRAY['water'])`,
    ),
    /check constraint/i,
    "a section can only pick a trigger the built-in sections have",
  );
  await refuses(
    as(
      admin,
      `INSERT INTO public.job_task_sections (label, added_when, due_rule, job_scopes)
               VALUES ('Roofing', 'job_type', 'sync', ARRAY['roofing'])`,
    ),
    /check constraint/i,
    "and only the three job types",
  );
  await refuses(
    as(
      admin,
      `INSERT INTO public.job_task_sections (label, added_when, due_rule, job_scopes)
               VALUES ('Nobody', 'job_type', 'sync', ARRAY[]::text[])`,
    ),
    /check constraint/i,
    "and at least one",
  );
  const made = await as(
    admin,
    `INSERT INTO public.job_task_sections (label, added_when, due_rule, job_scopes, sort_order)
     VALUES ('Contents', 'job_type', 'sync', ARRAY['water'], 10),
            ('Scrubber checks', 'equipment', 'retrieval', ARRAY['mold', 'water'], 20),
            ('Rebuild prep', 'additional_work', 'sync', ARRAY['water'], 30),
            ('Unused', 'job_type', 'sync', ARRAY['fire_smoke'], 40)
     RETURNING key, label, created_by`,
  );
  const S = Object.fromEntries(made.rows.map((r) => [r.label, r.key]));
  check(
    made.rows.every((r) => /^s_[0-9a-f]{12}$/.test(r.key) && r.created_by === admin),
    "a new section gets a generated key and records who made it",
  );
  await as(
    admin,
    `UPDATE public.job_task_sections
        SET label = 'Contents & pack-out', added_when = 'equipment', job_scopes = ARRAY['mold'],
            due_rule = 'retrieval', builtin = true, key = 'hijack', sort_order = 15
      WHERE key = '${S.Contents}'`,
  );
  const edited = await one(`SELECT * FROM public.job_task_sections WHERE key = '${S.Contents}'`);
  check(
    edited.label === "Contents & pack-out" && edited.sort_order === 15,
    "an admin renames and moves a section",
  );
  check(
    edited.added_when === "job_type" &&
      edited.due_rule === "sync" &&
      edited.job_scopes.join() === "water" &&
      edited.builtin === false,
    "what it does, its key and its kind survive an attempt to change them",
  );
  check(
    (
      await as(
        admin,
        `UPDATE public.job_task_sections SET label = 'Renamed'
                       WHERE key = 'water_extraction'`,
      )
    ).affectedRows === 0,
    "a built-in section's row is read-only",
  );
  check(
    (
      await as(
        crew,
        `UPDATE public.job_task_sections SET active = false
                      WHERE key = '${S.Contents}'`,
      )
    ).affectedRows === 0,
    "a crew member cannot switch a section off",
  );
  await refuses(
    as(admin, `INSERT INTO public.job_task_templates (group_key, title) VALUES ('roofing', 'x')`),
    /foreign key/i,
    "a line belongs to a section that exists",
  );
  await as(
    admin,
    `INSERT INTO public.job_task_templates (group_key, title, sort_order, active) VALUES
       ('${S.Contents}', 'Photograph contents', 10, true),
       ('${S.Contents}', 'Pack-out list', 20, true),
       ('${S.Contents}', 'Old line', 30, false),
       ('${S["Scrubber checks"]}', 'Check scrubber filter', 10, true),
       ('${S["Rebuild prep"]}', 'Measure for rebuild', 10, true),
       ('${S.Unused}', 'Never used', 10, true)`,
  );

  /* ---- 5: the pass adds sections -------------------------------------- */
  const dry = await sync(true);
  check(
    dry.added_by_group[S.Contents] === 2 * 4,
    `Contents' two active lines on the four open water jobs (got ${dry.added_by_group[S.Contents]})`,
  );
  check(
    dry.added_by_group[S["Scrubber checks"]] === 4,
    "Scrubber checks only where a unit is on site: three water jobs and the mold job",
  );
  check(dry.added_by_group[S["Rebuild prep"]] === 1, "Rebuild prep only on the flagged job");
  check(!dry.added_by_group[S.Unused], "a fire-only section waits for a fire job");
  const real = await sync(false);
  check(real.tasks_added === dry.tasks_added, "the real run does what the dry run said");
  const contents = await one(`SELECT description, due_date = public.gsr_local_date(now()) AS today,
                                     source FROM public.tasks
                               WHERE cadence_key LIKE 'job-scope:${J.water}:${S.Contents}:%' LIMIT 1`);
  check(
    contents.description === "Automatically generated from the Contents & pack-out checklist." &&
      contents.today &&
      contents.source === `job_scope:${S.Contents}`,
    "seeded like a built-in line: named by the section, due today, its own source",
  );
  check(
    (await tasksOn(
      J.mold,
      `source = 'job_scope:${S["Scrubber checks"]}' AND due_date = '2026-09-05'`,
    )) === 1,
    "an equipment section takes the expected-back date",
  );
  check(
    (await n(`SELECT 1 FROM public.tasks WHERE title = 'Old line'`)) === 0,
    "an inactive line of a section is not seeded",
  );
  const twice = await sync(false);
  check(twice.tasks_added === 0 && twice.tasks_renamed === 0, "a second run adds nothing");

  await as(admin, `UPDATE public.job_task_sections SET active = false WHERE key = '${S.Contents}'`);
  await db.exec(`INSERT INTO public.jobs (id, status, loss_type, location_id)
                 VALUES ('a0000000-0000-4000-8000-0000000000aa', 'new', 'water', '${office}')`);
  const off = await sync(true);
  check(
    !off.added_by_group[S.Contents] && off.added_by_group.water_extraction === 6,
    "a switched-off section adds nothing to a new water job, which still gets Extraction",
  );
  check(
    (await n(`SELECT 1 FROM public.tasks WHERE source = 'job_scope:${S.Contents}'
                AND status = 'open'`)) === 8,
    "and what it already put on jobs stays open",
  );
  await as(admin, `UPDATE public.job_task_sections SET active = true WHERE key = '${S.Contents}'`);
  await as(
    admin,
    `INSERT INTO public.job_task_templates (group_key, title, sort_order)
     VALUES ('${S.Contents}', 'Contents sign-off', 40)`,
  );
  const narrow = await as(admin, `SELECT public.sync_job_automatic_tasks(false, true) AS r`);
  check(
    narrow.rows[0].r.tasks_added === 4,
    `a new line reaches the four jobs that have the section, not the one that does not (got ${narrow.rows[0].r.tasks_added})`,
  );

  /* ---- 6: delete -------------------------------------------------------- */
  await refuses(
    as(admin, `DELETE FROM public.job_task_sections WHERE key = '${S["Rebuild prep"]}'`),
    /switch it off instead/i,
    "a section that made tasks cannot be deleted",
  );
  await db.exec(`DELETE FROM public.tasks WHERE source = 'job_scope:${S["Rebuild prep"]}'`);
  await refuses(
    as(admin, `DELETE FROM public.job_task_sections WHERE key = '${S["Rebuild prep"]}'`),
    /switch it off instead/i,
    "nor once its tasks were deleted — the ledger remembers",
  );
  check(
    (await as(crew, `DELETE FROM public.job_task_sections WHERE key = '${S.Unused}'`))
      .affectedRows === 0,
    "a crew member cannot delete a section",
  );
  check(
    (await as(admin, `DELETE FROM public.job_task_sections WHERE key = '${S.Unused}'`))
      .affectedRows === 1,
    "an admin deletes a section nothing was made from",
  );
  check(
    (await n(`SELECT 1 FROM public.job_task_templates WHERE group_key = '${S.Unused}'`)) === 0,
    "and its lines go with it",
  );
  check(
    (await as(admin, `DELETE FROM public.job_task_sections WHERE key = 'fire_smoke'`))
      .affectedRows === 0,
    "a built-in section cannot be deleted from the app",
  );
  await refuses(
    db.query(`DELETE FROM public.job_task_sections WHERE key = 'fire_smoke'`),
    /built-in/i,
    "nor from the SQL editor",
  );

  /* ---- 7: denials -------------------------------------------------------- */
  for (const policy of [
    "active_profile_required",
    "anonymous_business_access_denied",
    "portal_customer_denied",
  ]) {
    const p = (
      await db.query(`SELECT permissive FROM pg_policies
                       WHERE tablename = 'job_task_sections' AND policyname = '${policy}'`)
    ).rows;
    check(p.length === 1 && p[0].permissive === "RESTRICTIVE", `job_task_sections has ${policy}`);
  }
  check(
    (await as(leaver, `SELECT count(*)::int AS n FROM public.job_task_sections`)).rows[0].n === 0,
    "an admin whose profile is switched off reads nothing",
  );
  await refuses(
    as(
      leaver,
      `INSERT INTO public.job_task_sections (label, added_when, due_rule, job_scopes)
                VALUES ('Late', 'job_type', 'sync', ARRAY['water'])`,
    ),
    /row-level security/i,
    "nor writes",
  );
  await refuses(
    as(null, `SELECT 1 FROM public.job_task_sections`, "anon"),
    /permission denied/i,
    "anon has no grant on sections",
  );
  await refuses(
    as(admin, `SELECT * FROM public.job_automatic_task_candidates(false)`),
    /permission denied/i,
    "the candidate list is still internal",
  );

  console.log(`job-checklist-sections.pglite: ${assertions} assertions passed`);
} finally {
  await db.close();
}
