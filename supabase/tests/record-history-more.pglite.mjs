// Run with: node supabase/tests/record-history-more.pglite.mjs <existing PGlite dist/index.js>
// In-memory fixtures only. No connection string, network access or live writes.
//
// The second set of tables for delete/edit history and Restore. Mark: "in
// timeline have a restore button for each item that gets removed or
// changed". The three migrations — #300's, #312's and this one — are READ
// FROM THE FILES and applied in order, so this proves the last one's
// redefinitions keep everything the first two covered.
//
// What it proves:
//   1. an entry written before this migration (uuid row_pk) still restores
//      after row_pk becomes text;
//   2. photos: removing several at once is one entry with the rest as
//      children; Restore clears deleted_at on all of them; only someone who
//      may manage the project can; a photo deleted for good reads "purged";
//      other photo updates are not captured; photos removed before the
//      migration are backfilled once, restorable, and not duplicated;
//   3. crew taken off a job: a manager restores them, and they see the job
//      (and its history) again; a clash on the same person and role says so;
//   4. contact methods and questionnaire answers: edits revert, deletes
//      restore, non-managers are refused, a re-answered question clashes;
//   5. drying readings: crew revert their own edit (the UPDATE rule), only an
//      admin restores a delete (the DELETE rule), weather rows are skipped;
//   6. moisture points: deleting one brings its readings back with it;
//      "removed" (removed_at) reverts like any edit;
//   7. estimates and Quick Estimates still capture and restore after the
//      redefinition;
//   8. the CHECK still lists every earlier table; the live audit runs clean.
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
const rejects = async (promise, pattern, what) => {
  await assert.rejects(promise, pattern, what);
  assertions++;
};

const admin = "a0000000-0000-4000-8000-000000000001";
const manager = "a0000000-0000-4000-8000-000000000002";
const rep = "a0000000-0000-4000-8000-000000000003";
const crew = "a0000000-0000-4000-8000-000000000004";
const officeA = "b0000000-0000-4000-8000-00000000000a";
const jobA = "c0000000-0000-4000-8000-00000000000a";
const project = "e0000000-0000-4000-8000-0000000000aa";
const question = "f0000000-0000-4000-8000-000000000001";

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

    CREATE TABLE public.profiles (
      user_id uuid PRIMARY KEY, full_name text,
      is_active boolean NOT NULL DEFAULT true, approval_status text NOT NULL DEFAULT 'approved'
    );
    CREATE FUNCTION goldstar_private.profile_is_active(_user_id uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
      SELECT EXISTS (SELECT 1 FROM public.profiles p
        WHERE p.user_id = _user_id AND p.is_active IS TRUE AND p.approval_status = 'approved');
    $$;
    CREATE TABLE public.stub_privileged (user_id uuid PRIMARY KEY);
    CREATE TABLE public.location_members (
      user_id uuid NOT NULL, location_id uuid NOT NULL, manages boolean NOT NULL DEFAULT false
    );
    CREATE FUNCTION public.is_privileged(_u uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
      $$ SELECT EXISTS (SELECT 1 FROM public.stub_privileged WHERE user_id = _u) $$;
    CREATE FUNCTION public.can_view_location(_u uuid, _l uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
      $$ SELECT public.is_privileged(_u)
           OR EXISTS (SELECT 1 FROM public.location_members m WHERE m.user_id = _u AND m.location_id = _l) $$;
    CREATE FUNCTION public.can_manage_location(_u uuid, _l uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
      $$ SELECT public.is_privileged(_u)
           OR EXISTS (SELECT 1 FROM public.location_members m
                       WHERE m.user_id = _u AND m.location_id = _l AND m.manages) $$;

    CREATE TABLE public.jobs (id uuid PRIMARY KEY, location_id uuid NOT NULL, crew_chief uuid);
    -- job_assignments + policies, 20260728041824.
    CREATE TABLE public.job_assignments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
      user_id uuid NOT NULL,
      role text NOT NULL DEFAULT 'tech',
      start_date date, end_date date,
      created_at timestamptz NOT NULL DEFAULT now(),
      is_demo boolean NOT NULL DEFAULT false,
      UNIQUE (job_id, user_id, role)
    );
    CREATE FUNCTION public.can_view_job(_user_id uuid, _job_id uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = _job_id AND (
        public.is_privileged(_user_id)
        OR public.can_view_location(_user_id, j.location_id)
        OR j.crew_chief = _user_id
        OR EXISTS (SELECT 1 FROM public.job_assignments ja WHERE ja.job_id = j.id AND ja.user_id = _user_id)
      ));
    $$;
    CREATE FUNCTION public.can_manage_job(_user_id uuid, _job_id uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = _job_id AND (
        public.is_privileged(_user_id)
        OR public.can_manage_location(_user_id, j.location_id)
        OR j.crew_chief = _user_id
      ));
    $$;
    ALTER TABLE public.job_assignments ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "job_assignments_select" ON public.job_assignments FOR SELECT TO authenticated
      USING (user_id = auth.uid() OR public.can_view_job(auth.uid(), job_id));
    CREATE POLICY "job_assignments_write" ON public.job_assignments FOR ALL TO authenticated
      USING (public.can_manage_job(auth.uid(), job_id)) WITH CHECK (public.can_manage_job(auth.uid(), job_id));

    -- The tables #300 and #312 attach to, minimal.
    CREATE TABLE public.job_notes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
      author_id uuid, body text NOT NULL);
    CREATE TABLE public.job_section_notes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
      section_key text NOT NULL, body text NOT NULL, author_id uuid, is_demo boolean NOT NULL DEFAULT false);
    CREATE TABLE public.job_contacts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
      role text NOT NULL DEFAULT 'other', full_name text, email text, phone text, notes text,
      is_default_contact boolean NOT NULL DEFAULT false);
    CREATE TABLE public.tasks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text NOT NULL, description text, assignee uuid,
      due_date date, due_time time, priority text NOT NULL DEFAULT 'normal',
      job_id uuid REFERENCES public.jobs(id) ON DELETE CASCADE, location_id uuid, created_by uuid);
    CREATE TABLE public.estimates (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
      location_id uuid NOT NULL, seq integer NOT NULL, title text, created_by uuid, UNIQUE (job_id, seq));
    CREATE TABLE public.estimate_scopes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      estimate_id uuid NOT NULL REFERENCES public.estimates(id) ON DELETE CASCADE, name text NOT NULL);
    CREATE TABLE public.estimate_lines (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      estimate_id uuid NOT NULL REFERENCES public.estimates(id) ON DELETE CASCADE,
      scope_id uuid REFERENCES public.estimate_scopes(id) ON DELETE CASCADE, name text NOT NULL,
      unit_cost numeric NOT NULL DEFAULT 0);
    CREATE TABLE public.job_calculations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL,
      job_id uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
      job_date date NOT NULL DEFAULT '2026-10-06', job_type text NOT NULL DEFAULT 'water',
      customer_price numeric(12,2) NOT NULL DEFAULT 0, created_by uuid NOT NULL);
    CREATE TABLE public.invoices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
      estimate_id uuid REFERENCES public.estimates(id) ON DELETE SET NULL, invoice_number text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now());

    -- projects and photos + policies, 20260728175932 (no DELETE policy:
    -- deletion is soft).
    CREATE TABLE public.projects (id uuid PRIMARY KEY, job_id uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
      location_id uuid NOT NULL);
    CREATE FUNCTION public.can_view_project(_u uuid, _p uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
      $$ SELECT EXISTS (SELECT 1 FROM public.projects p WHERE p.id = _p AND public.can_view_location(_u, p.location_id)) $$;
    CREATE FUNCTION public.can_manage_project(_u uuid, _p uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
      $$ SELECT EXISTS (SELECT 1 FROM public.projects p WHERE p.id = _p AND public.can_manage_location(_u, p.location_id)) $$;
    CREATE TABLE public.photos (
      id text PRIMARY KEY,
      project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
      uploader_id uuid,
      storage_path_original text NOT NULL,
      captured_at timestamptz,
      folder_id uuid,
      deleted_at timestamptz, deleted_by uuid, deleted_reason text,
      is_demo boolean NOT NULL DEFAULT false
    );
    ALTER TABLE public.photos ENABLE ROW LEVEL SECURITY;
    CREATE POLICY photos_select_visible ON public.photos FOR SELECT TO authenticated
      USING (public.can_view_project(auth.uid(), project_id));
    CREATE POLICY photos_update_manage ON public.photos FOR UPDATE TO authenticated
      USING (public.can_manage_project(auth.uid(), project_id))
      WITH CHECK (public.can_manage_project(auth.uid(), project_id));

    -- job_contact_methods + policies, 20260803205051.
    CREATE TABLE public.job_contact_methods (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
      kind text NOT NULL, label text, value text NOT NULL, extension text,
      is_preferred boolean NOT NULL DEFAULT false, is_demo boolean NOT NULL DEFAULT false
    );
    ALTER TABLE public.job_contact_methods ENABLE ROW LEVEL SECURITY;
    CREATE POLICY job_contact_methods_select ON public.job_contact_methods FOR SELECT TO authenticated
      USING (public.can_view_job(auth.uid(), job_id));
    CREATE POLICY job_contact_methods_write ON public.job_contact_methods FOR ALL TO authenticated
      USING (public.can_manage_job(auth.uid(), job_id)) WITH CHECK (public.can_manage_job(auth.uid(), job_id));

    -- intake questions and answers + policies, 20260818181614.
    CREATE TABLE public.intake_questions (id uuid PRIMARY KEY, prompt text NOT NULL);
    CREATE TABLE public.job_intake_answers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
      question_id uuid NOT NULL REFERENCES public.intake_questions(id) ON DELETE CASCADE,
      answer_text text, answer_bool boolean, answer_date date, answered_by uuid,
      UNIQUE (job_id, question_id)
    );
    ALTER TABLE public.job_intake_answers ENABLE ROW LEVEL SECURITY;
    CREATE POLICY job_intake_answers_select ON public.job_intake_answers FOR SELECT TO authenticated
      USING (public.can_view_job((SELECT auth.uid()), job_id));
    CREATE POLICY job_intake_answers_write ON public.job_intake_answers FOR ALL TO authenticated
      USING (public.can_manage_job((SELECT auth.uid()), job_id))
      WITH CHECK (public.can_manage_job((SELECT auth.uid()), job_id));

    -- drying readings + the live policies, 20260901120000.
    CREATE TABLE public.job_drying_readings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
      reading_date date NOT NULL, point text NOT NULL DEFAULT 'room', label text,
      source text NOT NULL DEFAULT 'manual',
      temperature_f numeric, relative_humidity numeric, dew_point_f numeric, grains_per_pound numeric,
      notes text, created_by uuid, is_demo boolean NOT NULL DEFAULT false
    );
    CREATE UNIQUE INDEX job_drying_readings_daily_weather_uniq
      ON public.job_drying_readings (job_id, reading_date) WHERE source = 'weather';
    ALTER TABLE public.job_drying_readings ENABLE ROW LEVEL SECURITY;
    CREATE POLICY job_drying_readings_select ON public.job_drying_readings FOR SELECT TO authenticated
      USING (public.can_view_job(auth.uid(), job_id));
    CREATE POLICY job_drying_readings_insert ON public.job_drying_readings FOR INSERT TO authenticated
      WITH CHECK (public.can_view_job(auth.uid(), job_id) AND created_by = auth.uid());
    CREATE POLICY job_drying_readings_update ON public.job_drying_readings FOR UPDATE TO authenticated
      USING (created_by = auth.uid() OR public.can_manage_job(auth.uid(), job_id))
      WITH CHECK (created_by = auth.uid() OR public.can_manage_job(auth.uid(), job_id));
    CREATE POLICY job_drying_readings_delete ON public.job_drying_readings FOR DELETE TO authenticated
      USING (public.is_privileged(auth.uid()));

    -- moisture points and readings + policies, 20260928161000.
    CREATE TABLE public.job_moisture_points (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
      material text NOT NULL, location text, dry_standard numeric, removed_at timestamptz,
      created_by uuid, UNIQUE (id, job_id)
    );
    CREATE TABLE public.job_moisture_readings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      point_id uuid NOT NULL, job_id uuid NOT NULL,
      reading_date date NOT NULL, moisture_pct numeric NOT NULL, notes text, created_by uuid,
      FOREIGN KEY (point_id, job_id) REFERENCES public.job_moisture_points (id, job_id) ON DELETE CASCADE
    );
    ALTER TABLE public.job_moisture_points ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.job_moisture_readings ENABLE ROW LEVEL SECURITY;
    CREATE POLICY job_moisture_points_select ON public.job_moisture_points FOR SELECT TO authenticated
      USING (public.can_view_job(auth.uid(), job_id));
    CREATE POLICY job_moisture_points_update ON public.job_moisture_points FOR UPDATE TO authenticated
      USING (created_by = auth.uid() OR public.can_manage_job(auth.uid(), job_id))
      WITH CHECK (created_by = auth.uid() OR public.can_manage_job(auth.uid(), job_id));
    CREATE POLICY job_moisture_points_delete ON public.job_moisture_points FOR DELETE TO authenticated
      USING (public.is_privileged(auth.uid()));
    CREATE POLICY job_moisture_readings_select ON public.job_moisture_readings FOR SELECT TO authenticated
      USING (public.can_view_job(auth.uid(), job_id));
    CREATE POLICY job_moisture_readings_delete ON public.job_moisture_readings FOR DELETE TO authenticated
      USING (public.is_privileged(auth.uid()));

    GRANT SELECT, INSERT, UPDATE, DELETE ON public.job_assignments, public.job_section_notes,
      public.photos, public.job_contact_methods, public.job_intake_answers, public.job_drying_readings,
      public.job_moisture_points, public.job_moisture_readings TO authenticated;
    GRANT SELECT ON public.jobs, public.profiles, public.projects, public.intake_questions TO authenticated;

    INSERT INTO public.profiles (user_id, full_name) VALUES
      ('${admin}', 'Ada Admin'), ('${manager}', 'Mona Manager'), ('${rep}', 'Sarah Rep'), ('${crew}', 'Mike Crew');
    INSERT INTO public.stub_privileged VALUES ('${admin}');
    INSERT INTO public.location_members VALUES
      ('${manager}', '${officeA}', true), ('${rep}', '${officeA}', false);
    INSERT INTO public.jobs VALUES ('${jobA}', '${officeA}', NULL);
    INSERT INTO public.job_assignments (job_id, user_id, role) VALUES ('${jobA}', '${crew}', 'tech');
    INSERT INTO public.projects VALUES ('${project}', '${jobA}', '${officeA}');
    INSERT INTO public.intake_questions VALUES ('${question}', 'Was the water clean?');
  `);

  const as = async (uid, sql, params) => {
    await db.exec(`SET ROLE authenticated; SET request.jwt.claim.sub = '${uid}'`);
    try {
      return await db.query(sql, params);
    } finally {
      await db.exec("RESET ROLE; SELECT set_config('request.jwt.claim.sub','',false)");
    }
  };
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  const n = async (sql, params) => Number((await one(sql, params)).n);
  const restore = async (uid, id) =>
    (await as(uid, `SELECT public.restore_record_history($1) AS r`, [id])).rows[0].r;
  const preview = async (uid, id) =>
    (await as(uid, `SELECT public.record_history_preview($1) AS r`, [id])).rows[0].r;
  const latest = async (table, op) =>
    one(
      `SELECT * FROM public.record_history WHERE table_name = $1 AND op = $2 AND parent_id IS NULL
       ORDER BY seq DESC LIMIT 1`,
      [table, op],
    );

  /* ---- #300 and #312, then an entry and a removed photo from before ---- */
  await db.exec(migration("20261006150000_record_history.sql"));
  await db.exec(migration("20261006163000_estimate_delete.sql"));

  const oldNote = "d0000000-0000-4000-8000-000000000001";
  await as(
    rep,
    `INSERT INTO public.job_section_notes (id, job_id, section_key, body, author_id)
     VALUES ('${oldNote}', '${jobA}', 'drying', 'Before the migration', '${rep}')`,
  );
  await as(rep, `DELETE FROM public.job_section_notes WHERE id = '${oldNote}'`);
  const oldEntry = await latest("job_section_notes", "delete");
  check(oldEntry?.row_pk === oldNote, "fixture: an entry written under #300");

  await db.query(
    `INSERT INTO public.photos (id, project_id, storage_path_original, captured_at, deleted_at, deleted_by, deleted_reason)
     VALUES ('01OLDPHOTO', '${project}', 'p/old.jpg', '2026-09-20T10:00:00Z', '2026-09-25T09:00:00Z', '${manager}', 'Removed from job Pictures')`,
  );

  /* ---- This migration ------------------------------------------------- */
  const mine = migration("20261006200000_record_history_more_tables.sql");
  await db.exec(mine);

  /* ---- 1. Old entries survive row_pk becoming text --------------------- */
  check(
    (
      await one(
        `SELECT data_type FROM information_schema.columns WHERE table_name = 'record_history' AND column_name = 'row_pk'`,
      )
    ).data_type === "text",
    "row_pk is text",
  );
  check((await restore(rep, oldEntry.id)).status === "restored", "a #300 entry still restores");
  check(
    (await n(`SELECT count(*) AS n FROM public.job_section_notes WHERE id = '${oldNote}'`)) === 1,
    "and the note is back",
  );

  /* ---- 2. Photos ------------------------------------------------------ */
  const backfilled = await one(
    `SELECT * FROM public.record_history WHERE table_name = 'photos' AND row_pk = '01OLDPHOTO'`,
  );
  check(
    backfilled &&
      backfilled.actor_id === manager &&
      backfilled.occurred_at.toISOString() === "2026-09-25T09:00:00.000Z" &&
      backfilled.old_row.deleted_at === null,
    "a photo removed before the migration is backfilled: when, who, and the photo as it was",
  );
  await db.exec(mine);
  check(
    (await n(`SELECT count(*) AS n FROM public.record_history WHERE row_pk = '01OLDPHOTO'`)) === 1,
    "re-running the migration does not backfill it twice",
  );

  await db.query(
    `INSERT INTO public.photos (id, project_id, storage_path_original, captured_at) VALUES
       ('01P1', '${project}', 'p/1.jpg', '2026-10-01T10:00:00Z'),
       ('01P2', '${project}', 'p/2.jpg', '2026-10-01T10:01:00Z'),
       ('01P3', '${project}', 'p/3.jpg', '2026-10-01T10:02:00Z'),
       ('01P4', '${project}', 'p/4.jpg', '2026-10-01T10:03:00Z')`,
  );
  await as(manager, `UPDATE public.photos SET folder_id = gen_random_uuid() WHERE id = '01P4'`);
  check(
    (await n(`SELECT count(*) AS n FROM public.record_history WHERE row_pk = '01P4'`)) === 0,
    "a photo update other than removing it is not captured",
  );
  await as(
    manager,
    `UPDATE public.photos SET deleted_at = now(), deleted_by = '${manager}', deleted_reason = 'Removed from job Pictures'
      WHERE id IN ('01P1', '01P2', '01P3')`,
  );
  const batch = await latest("photos", "delete");
  check(batch.summary === "3 photos", "removing three at once is one entry: 3 photos");
  check(
    (await n(`SELECT count(*) AS n FROM public.record_history WHERE parent_id = $1`, [
      batch.id,
    ])) === 2,
    "the other two hang off it",
  );
  await rejects(
    as(rep, `SELECT txid FROM public.record_history LIMIT 1`),
    /permission denied/i,
    "txid is not readable by the app",
  );
  const pv = await preview(manager, batch.id);
  check(pv.status === "ready" && Number(pv.children.photos) === 2, "the preview counts the batch");
  check(
    (await preview(crew, batch.id)).status === "not_allowed",
    "crew who can see the job but not manage its project may not restore photos",
  );
  await rejects(restore(crew, batch.id), /can't restore this/, "and are refused");
  check((await restore(manager, batch.id)).status === "restored", "the manager restores the batch");
  check(
    (await n(
      `SELECT count(*) AS n FROM public.photos WHERE id IN ('01P1','01P2','01P3') AND deleted_at IS NULL`,
    )) === 3,
    "all three photos are back",
  );
  check(
    (await n(
      `SELECT count(*) AS n FROM public.record_history
        WHERE table_name = 'photos' AND op = 'delete' AND row_pk IN ('01P1','01P2','01P3')`,
    )) === 3,
    "un-removing them is not captured as a new removal (still just the batch's three rows)",
  );
  check((await restore(manager, batch.id)).status === "already_restored", "twice is a no-op");
  check(
    (await restore(manager, backfilled.id)).status === "restored",
    "the backfilled photo restores",
  );

  await as(manager, `UPDATE public.photos SET deleted_at = now() WHERE id = '01P4'`);
  const single = await latest("photos", "delete");
  await db.query(`DELETE FROM public.photos WHERE id = '01P4'`);
  check(
    (await preview(manager, single.id)).status === "purged",
    "a photo deleted for good reads purged",
  );
  await rejects(restore(manager, single.id), /deleted for good/, "and refuses with the reason");

  /* ---- 3. Crew taken off a job ---------------------------------------- */
  const crewSeesJob = async () =>
    Number(
      (await as(crew, `SELECT count(*) AS n FROM public.record_history WHERE job_id = '${jobA}'`))
        .rows[0].n,
    );
  check((await crewSeesJob()) > 0, "crew on the job read its history");
  await as(manager, `DELETE FROM public.job_assignments WHERE user_id = '${crew}'`);
  const removedCrew = await latest("job_assignments", "delete");
  check(
    /crew Mike Crew \(tech\)/.test(removedCrew.summary),
    "the entry names who came off the job",
  );
  check((await crewSeesJob()) === 0, "once off the job, crew see none of its history");
  check(
    (await preview(rep, removedCrew.id)).status === "not_allowed",
    "an office member who does not manage the job may not put crew back",
  );
  check(
    (await restore(manager, removedCrew.id)).status === "restored",
    "the manager puts them back",
  );
  check((await crewSeesJob()) > 0, "and crew see the job again");
  await as(manager, `DELETE FROM public.job_assignments WHERE user_id = '${crew}'`);
  const removedAgain = await latest("job_assignments", "delete");
  await db.query(
    `INSERT INTO public.job_assignments (job_id, user_id, role) VALUES ('${jobA}', '${crew}', 'tech')`,
  );
  await rejects(
    restore(manager, removedAgain.id),
    /already on the job in that role/,
    "re-added by hand meanwhile: the clash says so",
  );

  /* ---- 4. Contact methods and answers --------------------------------- */
  const cm = "d1000000-0000-4000-8000-000000000001";
  await as(
    manager,
    `INSERT INTO public.job_contact_methods (id, job_id, kind, label, value) VALUES ('${cm}', '${jobA}', 'phone', 'Mobile', '555-0100')`,
  );
  await as(manager, `UPDATE public.job_contact_methods SET value = '555-0199' WHERE id = '${cm}'`);
  const cmEdit = await latest("job_contact_methods", "update");
  check(JSON.stringify(cmEdit.changed_columns) === '["value"]', "a phone number edit is captured");
  await as(manager, `UPDATE public.job_contact_methods SET is_preferred = true WHERE id = '${cm}'`);
  check(
    (await latest("job_contact_methods", "update")).id === cmEdit.id,
    "making it preferred is not",
  );
  check(
    (await preview(rep, cmEdit.id)).status === "not_allowed",
    "a non-manager may not revert it",
  );
  check((await restore(manager, cmEdit.id)).status === "restored", "the manager reverts it");
  check(
    (await one(`SELECT value FROM public.job_contact_methods WHERE id = '${cm}'`)).value ===
      "555-0100",
    "the number is back",
  );
  await as(manager, `DELETE FROM public.job_contact_methods WHERE id = '${cm}'`);
  check(
    (await restore(manager, (await latest("job_contact_methods", "delete")).id)).status ===
      "restored",
    "a removed number restores",
  );

  await as(
    manager,
    `INSERT INTO public.job_intake_answers (job_id, question_id, answer_text) VALUES ('${jobA}', '${question}', 'Yes, clean')`,
  );
  await as(
    manager,
    `UPDATE public.job_intake_answers SET answer_text = 'No, grey water' WHERE job_id = '${jobA}'`,
  );
  const ansEdit = await latest("job_intake_answers", "update");
  check(
    /answer to "Was the water clean\?"/.test(ansEdit.summary),
    "the answer entry names its question",
  );
  check((await restore(manager, ansEdit.id)).status === "restored", "an answer edit reverts");
  await as(manager, `DELETE FROM public.job_intake_answers WHERE job_id = '${jobA}'`);
  const ansDel = await latest("job_intake_answers", "delete");
  await as(
    manager,
    `INSERT INTO public.job_intake_answers (job_id, question_id, answer_text) VALUES ('${jobA}', '${question}', 'Re-answered')`,
  );
  await rejects(
    restore(manager, ansDel.id),
    /answered again since/,
    "a cleared answer whose question was answered again clashes, by name",
  );

  /* ---- 5. Drying readings --------------------------------------------- */
  const rd = "d2000000-0000-4000-8000-000000000001";
  await as(
    crew,
    `INSERT INTO public.job_drying_readings (id, job_id, reading_date, label, temperature_f, relative_humidity, created_by)
                  VALUES ('${rd}', '${jobA}', '2026-10-05', 'Kitchen', 72, 55, '${crew}')`,
  );
  await as(crew, `UPDATE public.job_drying_readings SET relative_humidity = 48 WHERE id = '${rd}'`);
  const rdEdit = await latest("job_drying_readings", "update");
  check(
    (await restore(crew, rdEdit.id)).status === "restored",
    "crew revert their own reading edit",
  );
  await as(admin, `DELETE FROM public.job_drying_readings WHERE id = '${rd}'`);
  const rdDel = await latest("job_drying_readings", "delete");
  check(
    (await preview(crew, rdDel.id)).status === "not_allowed",
    "but only an admin may restore a deleted reading (the DELETE rule)",
  );
  check((await restore(admin, rdDel.id)).status === "restored", "the admin restores it");
  const before = await n(`SELECT count(*) AS n FROM public.record_history`);
  await db.query(
    `INSERT INTO public.job_drying_readings (job_id, reading_date, source, temperature_f) VALUES ('${jobA}', '2026-10-05', 'weather', 60)`,
  );
  await db.query(
    `UPDATE public.job_drying_readings SET temperature_f = 61 WHERE source = 'weather'`,
  );
  await db.query(`DELETE FROM public.job_drying_readings WHERE source = 'weather'`);
  check(
    (await n(`SELECT count(*) AS n FROM public.record_history`)) === before,
    "weather rows are the system's: never captured",
  );

  /* ---- 6. Moisture points --------------------------------------------- */
  const pt = "d3000000-0000-4000-8000-000000000001";
  await db.query(
    `INSERT INTO public.job_moisture_points (id, job_id, material, location, created_by) VALUES ('${pt}', '${jobA}', 'drywall', 'North wall', '${crew}')`,
  );
  await db.query(`INSERT INTO public.job_moisture_readings (point_id, job_id, reading_date, moisture_pct) VALUES
                  ('${pt}', '${jobA}', '2026-10-04', 28), ('${pt}', '${jobA}', '2026-10-05', 19)`);
  await as(crew, `UPDATE public.job_moisture_points SET removed_at = now() WHERE id = '${pt}'`);
  const ptRemoved = await latest("job_moisture_points", "update");
  check(
    JSON.stringify(ptRemoved.changed_columns) === '["removed_at"]',
    "removing a point is an edit of removed_at",
  );
  check((await restore(crew, ptRemoved.id)).status === "restored", "and reverts");
  check(
    (await one(`SELECT removed_at FROM public.job_moisture_points WHERE id = '${pt}'`))
      .removed_at === null,
    "the point is active again",
  );
  await as(admin, `DELETE FROM public.job_moisture_points WHERE id = '${pt}'`);
  const ptDel = await latest("job_moisture_points", "delete");
  check(
    (await n(
      `SELECT count(*) AS n FROM public.record_history WHERE parent_id = $1 AND table_name = 'job_moisture_readings'`,
      [ptDel.id],
    )) === 2,
    "its readings are captured as its children",
  );
  check(
    Number((await preview(admin, ptDel.id)).children.readings) === 2,
    "the preview counts them",
  );
  check((await restore(admin, ptDel.id)).status === "restored", "the point restores");
  check(
    (await n(`SELECT count(*) AS n FROM public.job_moisture_readings WHERE point_id = '${pt}'`)) ===
      2,
    "with both readings",
  );

  /* ---- 7. #300 and #312's tables still work --------------------------- */
  const est = "d4000000-0000-4000-8000-000000000001";
  await db.query(
    `INSERT INTO public.estimates (id, job_id, location_id, seq, title, created_by) VALUES ('${est}', '${jobA}', '${officeA}', 1, 'Mitigation', '${rep}')`,
  );
  await db.query(
    `INSERT INTO public.estimate_lines (estimate_id, name, unit_cost) VALUES ('${est}', 'Dehu day', 41.5)`,
  );
  await db.exec(`SET request.jwt.claim.sub = '${manager}'`);
  await db.query(`DELETE FROM public.estimates WHERE id = '${est}'`);
  await db.exec(`SELECT set_config('request.jwt.claim.sub','',false)`);
  const estDel = await latest("estimates", "delete");
  check(
    (await n(`SELECT count(*) AS n FROM public.record_history WHERE parent_id = $1`, [
      estDel.id,
    ])) === 1,
    "an estimate's line still hangs off it",
  );
  check((await restore(rep, estDel.id)).status === "restored", "and the estimate restores");
  check(
    Number(
      (await one(`SELECT unit_cost FROM public.estimate_lines WHERE estimate_id = '${est}'`))
        .unit_cost,
    ) === 41.5,
    "with its line",
  );
  const calc = "d5000000-0000-4000-8000-000000000001";
  await db.query(
    `INSERT INTO public.job_calculations (id, location_id, job_id, created_by) VALUES ('${calc}', '${officeA}', '${jobA}', '${rep}')`,
  );
  await db.exec(`SET request.jwt.claim.sub = '${rep}'`);
  await db.query(`DELETE FROM public.job_calculations WHERE id = '${calc}'`);
  await db.exec(`SELECT set_config('request.jwt.claim.sub','',false)`);
  check(
    (await restore(rep, (await latest("job_calculations", "delete")).id)).status === "restored",
    "a Quick Estimate still restores",
  );

  /* ---- 8. The list and the audit -------------------------------------- */
  const def = (
    await one(
      `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'record_history_table_allowed'`,
    )
  ).d;
  for (const t of [
    "job_notes",
    "job_section_notes",
    "job_contacts",
    "tasks",
    "estimates",
    "estimate_scopes",
    "estimate_lines",
    "job_calculations",
    "photos",
    "job_assignments",
    "job_contact_methods",
    "job_intake_answers",
    "job_drying_readings",
    "job_moisture_points",
    "job_moisture_readings",
  ]) {
    check(def.includes(`'${t}'`), `the CHECK still lists ${t}`);
  }
  check(
    !(
      await one(
        `SELECT has_function_privilege('authenticated', 'public.record_history_id_type(text)', 'EXECUTE') AS ok`,
      )
    ).ok,
    "the new helper is not callable by a signed-in user",
  );
  const audit = readFileSync(new URL("./record-history-live-audit.sql", import.meta.url), "utf8")
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const [i, sql] of audit.entries()) {
    const rows = (await db.query(sql)).rows;
    if (i < 4) check(rows.length === 0, `live audit query ${i + 1} returns no rows`);
  }

  console.log(`record-history-more.pglite: ${assertions} assertions passed`);
} finally {
  await db.close();
}
