// Run with: node supabase/tests/job-field-revert.pglite.mjs <existing PGlite dist/index.js>
// In-memory fixtures only. No connection string, network access or live writes.
//
// Revert a change to the job's own fields from the Timeline. Mark: "in
// timeline have a restore button for each item that gets removed or
// changed". Both migrations under test — the original field-change logger
// (20260820184525) and the revert (20261006152000) — are READ FROM THE FILES,
// in order, so the redefined logger is proved to replace the original.
//
// What it proves:
//   1. a stage move reverts as one edit: stage and status come back together,
//      and the revert is logged by the same trail with reverts_id set;
//   2. reverting twice is a no-op;
//   3. another office cannot even read the change; crew who can see the job
//      but may not edit it are refused by jobs_update, and nothing changes;
//   4. a field edited again since refuses and is named; newer first, then
//      older, works;
//   5. money fields are never reverted — alone they refuse, beside other
//      fields they are left as they are;
//   6. dates, times, booleans and numbers survive the text round trip;
//   7. reverts_id cannot be claimed for an edit that did not undo anything;
//   8. the functions are SECURITY INVOKER and not executable by anon;
//   9. mutation: with jobs_update opened up, the same crew revert goes
//      through — so (3) is the jobs policy's doing.
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

const manager = "a0000000-0000-4000-8000-000000000002";
const crew = "a0000000-0000-4000-8000-000000000004";
const outsider = "a0000000-0000-4000-8000-000000000005";
const officeA = "b0000000-0000-4000-8000-00000000000a";
const officeB = "b0000000-0000-4000-8000-00000000000b";
const job = "c0000000-0000-4000-8000-00000000000a";
const pipeline = "d0000000-0000-4000-8000-000000000001";
const stNew = "d1000000-0000-4000-8000-000000000001";
const stProgress = "d1000000-0000-4000-8000-000000000002";
const stDrying = "d1000000-0000-4000-8000-000000000003";

try {
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

    CREATE TABLE public.location_members (
      user_id uuid NOT NULL, location_id uuid NOT NULL, manages boolean NOT NULL DEFAULT false
    );
    CREATE FUNCTION public.is_privileged(_u uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
    CREATE FUNCTION public.can_view_location(_u uuid, _l uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
      $$ SELECT EXISTS (SELECT 1 FROM public.location_members m WHERE m.user_id = _u AND m.location_id = _l) $$;
    CREATE FUNCTION public.can_manage_location(_u uuid, _l uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
      $$ SELECT EXISTS (SELECT 1 FROM public.location_members m
                         WHERE m.user_id = _u AND m.location_id = _l AND m.manages) $$;

    CREATE TYPE public.job_status AS ENUM
      ('new','scheduled','in_progress','drying','complete','invoiced','paid','cancelled');
    CREATE TABLE public.pipelines (id uuid PRIMARY KEY, entity_type text, is_default boolean, location_id uuid);
    CREATE TABLE public.pipeline_stages (
      id uuid PRIMARY KEY, pipeline_id uuid, key text, name text,
      is_won boolean NOT NULL DEFAULT false, is_lost boolean NOT NULL DEFAULT false
    );

    CREATE TABLE public.jobs (
      id uuid PRIMARY KEY,
      location_id uuid NOT NULL,
      crew_chief uuid,
      created_by uuid,
      status public.job_status NOT NULL DEFAULT 'new',
      stage_id uuid,
      pipeline_id uuid,
      stage_entered_at timestamptz,
      customer_name text,
      address text,
      locality text,
      lat double precision,
      lon double precision,
      agreed_price numeric(12,2),
      loss_date date,
      call_time time,
      rehabbed_after_1978 boolean,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE public.job_assignments (job_id uuid, user_id uuid);

    -- jobs_select (20260820071015, with my_visible_location_ids stubbed as
    -- office membership) and jobs_update (20260728041824), verbatim.
    ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;
    CREATE POLICY jobs_select ON public.jobs FOR SELECT TO authenticated USING (
      created_by = (SELECT auth.uid())
      OR crew_chief = (SELECT auth.uid())
      OR (SELECT public.is_privileged((SELECT auth.uid())))
      OR public.can_view_location((SELECT auth.uid()), location_id)
      OR EXISTS (SELECT 1 FROM public.job_assignments ja
                  WHERE ja.job_id = jobs.id AND ja.user_id = (SELECT auth.uid())));
    CREATE POLICY "jobs_update" ON public.jobs FOR UPDATE TO authenticated
      USING (public.can_manage_location(auth.uid(), location_id) OR crew_chief = auth.uid())
      WITH CHECK (public.can_manage_location(auth.uid(), location_id) OR crew_chief = auth.uid());
    GRANT SELECT, INSERT, UPDATE ON public.jobs TO authenticated;
    GRANT SELECT ON public.job_assignments, public.pipeline_stages, public.pipelines TO authenticated;

    -- can_view_job (20260728041824), which job_field_changes' policy uses.
    CREATE FUNCTION public.can_view_job(_user_id uuid, _job_id uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = _job_id AND (
        public.is_privileged(_user_id)
        OR public.can_view_location(_user_id, j.location_id)
        OR j.crew_chief = _user_id
        OR EXISTS (SELECT 1 FROM public.job_assignments ja WHERE ja.job_id = j.id AND ja.user_id = _user_id)
      ));
    $$;

    -- jobs_sync_stage_status (20260810172058), verbatim.
    CREATE OR REPLACE FUNCTION public.jobs_sync_stage_status()
    RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
    DECLARE
      v_stage public.pipeline_stages%ROWTYPE;
      v_pipeline uuid;
    BEGIN
      IF NEW.stage_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.stage_id IS DISTINCT FROM OLD.stage_id) THEN
        SELECT * INTO v_stage FROM public.pipeline_stages WHERE id = NEW.stage_id;
        NEW.pipeline_id := v_stage.pipeline_id;
        NEW.stage_entered_at := now();
        IF v_stage.key IN ('new','scheduled','in_progress','drying','complete','invoiced','paid','cancelled') THEN
          NEW.status := v_stage.key::public.job_status;
        ELSIF v_stage.is_won THEN
          NEW.status := 'complete'::public.job_status;
        ELSIF v_stage.is_lost THEN
          NEW.status := 'cancelled'::public.job_status;
        ELSE
          NEW.status := 'in_progress'::public.job_status;
        END IF;
        RETURN NEW;
      END IF;
      IF NEW.stage_id IS NULL OR (TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status) THEN
        SELECT s.id, s.pipeline_id INTO v_stage.id, v_pipeline
          FROM public.pipeline_stages s
          JOIN public.pipelines p ON p.id = s.pipeline_id
         WHERE p.entity_type = 'job' AND p.is_default
           AND (p.location_id IS NULL OR p.location_id = NEW.location_id)
           AND s.key = NEW.status::text
         ORDER BY (p.location_id IS NOT NULL) DESC
         LIMIT 1;
        IF v_stage.id IS NOT NULL THEN
          NEW.stage_id := v_stage.id;
          NEW.pipeline_id := v_pipeline;
          NEW.stage_entered_at := COALESCE(NEW.stage_entered_at, now());
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER trg_jobs_sync_stage_status BEFORE INSERT OR UPDATE ON public.jobs
      FOR EACH ROW EXECUTE FUNCTION public.jobs_sync_stage_status();

    INSERT INTO public.location_members VALUES
      ('${manager}', '${officeA}', true), ('${outsider}', '${officeB}', true);
    INSERT INTO public.pipelines VALUES ('${pipeline}', 'job', true, NULL);
    INSERT INTO public.pipeline_stages (id, pipeline_id, key, name) VALUES
      ('${stNew}', '${pipeline}', 'new', 'New'),
      ('${stProgress}', '${pipeline}', 'in_progress', 'In progress'),
      ('${stDrying}', '${pipeline}', 'drying', 'Drying');
    INSERT INTO public.jobs (id, location_id, customer_name, address, locality, lat, lon,
                             agreed_price, loss_date, call_time, rehabbed_after_1978)
      VALUES ('${job}', '${officeA}', 'Alice Homeowner', '1 Elm St', 'Springfield', 40.1, -75.2,
              5000, '2026-09-30', '08:15', false);
    INSERT INTO public.job_assignments VALUES ('${job}', '${crew}');
  `);

  /* ---- The migrations, verbatim, in order ----------------------------- */
  await db.exec(migration("20260820184525_9e653d96-1380-46ee-9da0-c247ef94894d.sql"));
  await db.exec(migration("20261006152000_job_field_revert.sql"));

  const as = async (uid, sql, params) => {
    await db.exec(`SET ROLE authenticated; SET request.jwt.claim.sub = '${uid}'`);
    try {
      return await db.query(sql, params);
    } finally {
      await db.exec("RESET ROLE; SELECT set_config('request.jwt.claim.sub','',false)");
    }
  };
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  const jobRow = () => one(`SELECT * FROM public.jobs WHERE id = '${job}'`);
  const changeOf = async (field) =>
    one(
      `SELECT * FROM public.job_field_changes WHERE job_id = '${job}' AND field = $1
       ORDER BY changed_at DESC, id DESC LIMIT 1`,
      [field],
    );
  const revert = async (uid, id) =>
    (await as(uid, `SELECT public.revert_job_field_change($1) AS r`, [id])).rows[0].r;
  const state = async (uid, id) =>
    (await as(uid, `SELECT public.job_field_change_state($1) AS r`, [id])).rows[0].r;
  const count = async () =>
    Number((await one(`SELECT count(*) AS n FROM public.job_field_changes`)).n);

  // Set the starting stage outside the log, so the first logged edit is the move.
  await db.query(`UPDATE public.jobs SET stage_id = '${stNew}' WHERE id = '${job}'`);
  await db.query(`DELETE FROM public.job_field_changes`);

  /* ---- 1. A stage move reverts as one edit ---------------------------- */
  await as(manager, `UPDATE public.jobs SET stage_id = '${stProgress}' WHERE id = '${job}'`);
  check((await jobRow()).status === "in_progress", "fixture: the stage move set status");
  const stageChange = await changeOf("stage_id");
  const statusChange = await changeOf("status");
  check(
    stageChange &&
      statusChange &&
      stageChange.changed_at.getTime() === statusChange.changed_at.getTime(),
    "the stage and status rows share one instant — one edit",
  );
  const st1 = await state(manager, statusChange.id);
  check(st1.status === "ready" && st1.may_edit === true, "the manager's preview is ready");
  check(
    st1.fields.some((f) => f.field === "status" && f.before === "new" && f.now === "in_progress"),
    "the preview shows status new → in_progress, now in_progress",
  );
  check((await revert(manager, statusChange.id)).status === "reverted", "the manager reverts it");
  const afterRevert = await jobRow();
  check(
    afterRevert.stage_id === stNew && afterRevert.status === "new",
    "stage and status are back together",
  );
  const revertRows = (
    await db.query(
      `SELECT field, reverts_id, changed_by FROM public.job_field_changes WHERE reverts_id IS NOT NULL`,
    )
  ).rows;
  check(
    revertRows.some((r) => r.field === "stage_id" && r.reverts_id === stageChange.id) &&
      revertRows.some((r) => r.field === "status" && r.reverts_id === statusChange.id),
    "the revert is logged by the same trail, each row tied to the row it undid",
  );
  check(
    revertRows.every((r) => r.changed_by === manager),
    "and names who reverted",
  );

  /* ---- 2. Twice is a no-op -------------------------------------------- */
  const before2 = await count();
  check(
    (await revert(manager, stageChange.id)).status === "already_reverted",
    "reverting again answers already reverted",
  );
  check((await count()) === before2, "and writes nothing");

  /* ---- 3. Who may revert ---------------------------------------------- */
  await as(
    manager,
    `UPDATE public.jobs SET customer_name = 'Alice H. Homeowner' WHERE id = '${job}'`,
  );
  const nameChange = await changeOf("customer_name");
  await rejects(
    revert(outsider, nameChange.id),
    /not available/,
    "another office cannot read the change, let alone revert it",
  );
  const crewState = await state(crew, nameChange.id);
  check(
    crewState.status === "ready" && crewState.may_edit === false,
    "crew can see the change; the preview's hint says they may not edit the job",
  );
  await rejects(
    revert(crew, nameChange.id),
    /can't change this job/,
    "crew are refused by jobs_update",
  );
  check((await jobRow()).customer_name === "Alice H. Homeowner", "and the job is unchanged");

  /* ---- 4. Conflicts --------------------------------------------------- */
  await as(
    manager,
    `UPDATE public.jobs SET customer_name = 'Alice Homeowner-Smith' WHERE id = '${job}'`,
  );
  const nameChange2 = await changeOf("customer_name");
  const conflict = await state(manager, nameChange.id);
  check(conflict.status === "conflict", "an edit changed again since is a conflict");
  check(
    conflict.fields.find((f) => f.field === "customer_name").moved === true,
    "and the field is flagged as moved",
  );
  await rejects(
    revert(manager, nameChange.id),
    /Changed again since \(customer_name\)/,
    "the revert refuses and names the field",
  );
  check((await jobRow()).customer_name === "Alice Homeowner-Smith", "the newer edit is untouched");
  check((await revert(manager, nameChange2.id)).status === "reverted", "newer first");
  check((await revert(manager, nameChange.id)).status === "reverted", "then the older");
  check((await jobRow()).customer_name === "Alice Homeowner", "back to the original");

  /* ---- 5. Money is never reverted ------------------------------------- */
  await as(manager, `UPDATE public.jobs SET agreed_price = 7500 WHERE id = '${job}'`);
  const priceChange = await changeOf("agreed_price");
  check(
    (await state(manager, priceChange.id)).status === "nothing_revertable",
    "a money-only change has nothing revertable",
  );
  await rejects(
    revert(manager, priceChange.id),
    /money and system fields are left out/,
    "and refuses with the reason",
  );
  await as(
    manager,
    `UPDATE public.jobs SET address = '9 Oak Ave', locality = 'Shelbyville', agreed_price = 9000 WHERE id = '${job}'`,
  );
  const addrChange = await changeOf("address");
  check((await revert(manager, addrChange.id)).status === "reverted", "a mixed edit reverts");
  const mixed = await jobRow();
  check(
    mixed.address === "1 Elm St" && mixed.locality === "Springfield",
    "the address fields come back",
  );
  check(Number(mixed.agreed_price) === 9000, "the money field beside them is left as it is");

  /* ---- 6. Types survive the round trip -------------------------------- */
  await as(
    manager,
    `UPDATE public.jobs SET loss_date = '2026-10-02', call_time = '14:45', rehabbed_after_1978 = true,
       lat = 41.25, lon = -74.5 WHERE id = '${job}'`,
  );
  const typed = await changeOf("loss_date");
  check((await revert(manager, typed.id)).status === "reverted", "a typed group reverts");
  const t = await jobRow();
  check(
    t.loss_date.toISOString().slice(0, 10) === "2026-09-30" &&
      t.call_time === "08:15:00" &&
      t.rehabbed_after_1978 === false &&
      t.lat === 40.1 &&
      t.lon === -75.2,
    "date, time, boolean and double come back exactly",
  );

  /* ---- 7. reverts_id cannot be claimed -------------------------------- */
  // A raw-SQL session forging the setting, then making an edit that is not
  // an undo of the anchored change: nothing is marked.
  await db.exec(`
    SET ROLE authenticated; SET request.jwt.claim.sub = '${manager}';
    SELECT set_config('job_field_changes.reverting', '${nameChange2.id}', false);
    UPDATE public.jobs SET customer_name = 'Someone Else' WHERE id = '${job}';
    SELECT set_config('job_field_changes.reverting', '', false);
    RESET ROLE;
  `);
  check(
    (await changeOf("customer_name")).reverts_id === null,
    "an edit that does not restore the old value is not marked as a revert",
  );

  /* ---- 8. Invoker, not anon ------------------------------------------- */
  const fns = (
    await db.query(
      `SELECT proname, prosecdef FROM pg_proc
        WHERE proname IN ('revert_job_field_change', 'job_field_change_state', 'job_revertable_fields')`,
    )
  ).rows;
  check(
    fns.length === 3 && fns.every((f) => f.prosecdef === false),
    "all three are SECURITY INVOKER",
  );
  for (const sig of [
    "public.revert_job_field_change(uuid)",
    "public.job_field_change_state(uuid)",
    "public.job_revertable_fields()",
  ]) {
    check(
      !(await one(`SELECT has_function_privilege('anon', $1, 'EXECUTE') AS ok`, [sig])).ok,
      `anon cannot execute ${sig}`,
    );
  }
  const fieldList = (await one(`SELECT public.job_revertable_fields() AS f`)).f;
  check(
    ![
      "agreed_price",
      "billed_amount",
      "collected_amount",
      "approved_amount",
      "deductible",
      "deposit_amount",
      "estimated_amount",
      "commission_rate_pct",
      "id",
      "created_by",
      "pipeline_id",
      "stage_entered_at",
      "updated_at",
    ].some((f) => fieldList.includes(f)),
    "no money or system field is on the allow-list",
  );

  /* ---- 9. Mutation: the jobs policy is what stops crew ----------------- */
  await as(manager, `UPDATE public.jobs SET customer_name = 'Crew Test' WHERE id = '${job}'`);
  const crewTarget = await changeOf("customer_name");
  await rejects(revert(crew, crewTarget.id), /can't change this job/, "crew refused (control)");
  await db.exec(`ALTER POLICY "jobs_update" ON public.jobs USING (true) WITH CHECK (true)`);
  check(
    (await revert(crew, crewTarget.id)).status === "reverted",
    "MUTATION: with jobs_update opened up, the same crew revert goes through",
  );

  console.log(`job-field-revert.pglite: ${assertions} assertions passed`);
} finally {
  await db.close();
}
