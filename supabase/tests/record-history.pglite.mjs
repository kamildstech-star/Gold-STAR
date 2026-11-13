// Run with: node supabase/tests/record-history.pglite.mjs <existing PGlite dist/index.js>
// In-memory fixtures only. No connection string, network access or live writes.
//
// Delete and edit history with Restore. Mark: "in timeline have a restore
// button for each item that gets removed or changed". The migration under
// test is READ FROM THE FILE, never retyped here, so this cannot drift from
// what ships.
//
// What it proves:
//   1. capture: a delete stores the whole row, an edit stores only the
//      captured columns that moved, and noise (a completion, a demo row, an
//      account task, a whole job going) stores nothing;
//   2. reading: you see a job's history only if you can see the job; the
//      before-image columns are not readable by any signed-in user; nobody
//      can insert, edit or delete history rows; an estimate's line rows are
//      not readable at all;
//   3. restore stays inside the table's own rule: another office cannot
//      restore (or even learn the entry exists), crew cannot restore what
//      they could not have removed, an author can, an admin can restore a
//      colleague's note under the colleague's name, an inactive profile
//      cannot;
//   4. the allow-list: history cannot name another table (CHECK), and with
//      the CHECK removed the function's own list still refuses;
//   5. restore is idempotent: twice is a no-op, a second deletion is its
//      own entry;
//   6. conflicts: reverting an edit that was edited again refuses and says
//      which field moved; the newer revert first, then the older, works;
//      an edit to a since-deleted row says "restore the deletion first";
//   7. an estimate comes back whole — scopes, lines, the withheld unit cost,
//      its number and its totals — and refuses cleanly when its number has
//      been reused;
//   8. mutation: with the permission rule replaced by `true`, the crew
//      restore in (3) goes through — so (3) is the rule's doing.
//
// The surrounding tables are stubs with only the columns the migration
// touches, but each carries the SAME row policies production has (quoted
// from the migrations named beside them), because the restore rule mirrors
// those policies and this is where a mismatch would show.
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
const outsider = "a0000000-0000-4000-8000-000000000005";
const inactive = "a0000000-0000-4000-8000-000000000006";
const officeA = "b0000000-0000-4000-8000-00000000000a";
const officeB = "b0000000-0000-4000-8000-00000000000b";
const jobA = "c0000000-0000-4000-8000-00000000000a";
const jobB = "c0000000-0000-4000-8000-00000000000b";
const jobGone = "c0000000-0000-4000-8000-0000000000ff";

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
      user_id uuid PRIMARY KEY,
      full_name text,
      is_active boolean NOT NULL DEFAULT true,
      approval_status text NOT NULL DEFAULT 'approved'
    );
    -- 20260908013000, verbatim in substance.
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
    CREATE TABLE public.job_assignments (job_id uuid NOT NULL, user_id uuid NOT NULL);
    -- 20260728041824, verbatim.
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

    -- job_notes + policies, 20260728041824.
    CREATE TABLE public.job_notes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
      author_id uuid,
      body text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE public.job_notes ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "job_notes_select" ON public.job_notes FOR SELECT TO authenticated
      USING (public.can_view_job(auth.uid(), job_id));
    CREATE POLICY "job_notes_insert" ON public.job_notes FOR INSERT TO authenticated
      WITH CHECK (author_id = auth.uid() AND public.can_view_job(auth.uid(), job_id));
    CREATE POLICY "job_notes_update" ON public.job_notes FOR UPDATE TO authenticated
      USING (author_id = auth.uid() OR public.is_privileged(auth.uid()))
      WITH CHECK (author_id = auth.uid() OR public.is_privileged(auth.uid()));
    CREATE POLICY "job_notes_delete" ON public.job_notes FOR DELETE TO authenticated
      USING (author_id = auth.uid() OR public.is_privileged(auth.uid()));

    -- job_section_notes + policies, 20260810194233.
    CREATE TABLE public.job_section_notes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
      section_key text NOT NULL,
      body text NOT NULL,
      author_id uuid,
      is_demo boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE public.job_section_notes ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "View section notes on visible jobs" ON public.job_section_notes
      FOR SELECT TO authenticated USING (public.can_view_job((SELECT auth.uid()), job_id));
    CREATE POLICY "Add section notes on visible jobs" ON public.job_section_notes
      FOR INSERT TO authenticated
      WITH CHECK (public.can_view_job((SELECT auth.uid()), job_id) AND author_id = (SELECT auth.uid()));
    CREATE POLICY "Authors and managers edit section notes" ON public.job_section_notes
      FOR UPDATE TO authenticated
      USING (author_id = (SELECT auth.uid()) OR public.can_manage_job((SELECT auth.uid()), job_id))
      WITH CHECK (author_id = (SELECT auth.uid()) OR public.can_manage_job((SELECT auth.uid()), job_id));
    CREATE POLICY "Authors and managers delete section notes" ON public.job_section_notes
      FOR DELETE TO authenticated
      USING (author_id = (SELECT auth.uid()) OR public.can_manage_job((SELECT auth.uid()), job_id));

    -- job_contacts + policies, 20260805193344 / 20260810184457.
    CREATE TABLE public.job_contacts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
      contact_id uuid, account_id uuid,
      role text NOT NULL DEFAULT 'other',
      full_name text, email text, phone text, notes text,
      created_by uuid,
      is_default_contact boolean NOT NULL DEFAULT false,
      sort_order integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX job_contacts_one_default_idx ON public.job_contacts (job_id) WHERE is_default_contact;
    ALTER TABLE public.job_contacts ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "job_contacts_select" ON public.job_contacts FOR SELECT TO authenticated
      USING (public.can_view_job(auth.uid(), job_id));
    CREATE POLICY "job_contacts_write" ON public.job_contacts FOR ALL TO authenticated
      USING (public.can_manage_job(auth.uid(), job_id))
      WITH CHECK (public.can_manage_job(auth.uid(), job_id));

    -- tasks + policies, 20260804184212 / 20260806211227 / 20260925121000.
    CREATE TABLE public.tasks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      title text NOT NULL,
      description text,
      assignee uuid,
      due_date date,
      due_time time,
      priority text NOT NULL DEFAULT 'normal',
      status text NOT NULL DEFAULT 'open',
      job_id uuid REFERENCES public.jobs(id) ON DELETE CASCADE,
      account_id uuid,
      location_id uuid,
      created_by uuid,
      completed_at timestamptz,
      is_demo boolean NOT NULL DEFAULT false,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "tasks visible in scope" ON public.tasks FOR SELECT TO authenticated
      USING (assignee = (SELECT auth.uid()) OR created_by = (SELECT auth.uid())
        OR (location_id IS NOT NULL AND public.can_view_location((SELECT auth.uid()), location_id))
        OR (job_id IS NOT NULL AND public.can_view_job((SELECT auth.uid()), job_id)));
    CREATE POLICY "tasks insert" ON public.tasks FOR INSERT TO authenticated
      WITH CHECK (created_by = auth.uid());
    CREATE POLICY "tasks update in scope" ON public.tasks FOR UPDATE TO authenticated
      USING (assignee = auth.uid() OR created_by = auth.uid()
        OR (location_id IS NOT NULL AND public.can_manage_location(auth.uid(), location_id)))
      WITH CHECK (assignee = auth.uid() OR created_by = auth.uid()
        OR (location_id IS NOT NULL AND public.can_manage_location(auth.uid(), location_id)));
    CREATE POLICY "tasks delete own" ON public.tasks FOR DELETE TO authenticated
      USING (created_by = auth.uid()
        OR (location_id IS NOT NULL AND public.can_manage_location(auth.uid(), location_id)));

    -- estimates, scopes, lines + policies + the seq and totals triggers,
    -- 20260813172023; unit_cost withheld as in 20260909100000.
    CREATE TABLE public.estimates (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
      location_id uuid NOT NULL,
      seq integer,
      status text NOT NULL DEFAULT 'draft',
      title text,
      tax_rate numeric(6,4) NOT NULL DEFAULT 0,
      subtotal numeric(14,2) NOT NULL DEFAULT 0,
      tax numeric(14,2) NOT NULL DEFAULT 0,
      total numeric(14,2) NOT NULL DEFAULT 0,
      created_by uuid,
      is_demo boolean NOT NULL DEFAULT false,
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (job_id, seq)
    );
    ALTER TABLE public.estimates ENABLE ROW LEVEL SECURITY;
    CREATE POLICY estimates_select ON public.estimates FOR SELECT TO authenticated
      USING (public.can_view_location((SELECT auth.uid()), location_id) OR created_by = (SELECT auth.uid()));
    CREATE POLICY estimates_insert ON public.estimates FOR INSERT TO authenticated
      WITH CHECK (public.can_view_location((SELECT auth.uid()), location_id) AND created_by = (SELECT auth.uid()));
    CREATE POLICY estimates_update ON public.estimates FOR UPDATE TO authenticated
      USING (public.can_manage_location((SELECT auth.uid()), location_id) OR created_by = (SELECT auth.uid()))
      WITH CHECK (public.can_manage_location((SELECT auth.uid()), location_id) OR created_by = (SELECT auth.uid()));
    CREATE POLICY estimates_delete ON public.estimates FOR DELETE TO authenticated
      USING (public.can_manage_location((SELECT auth.uid()), location_id) OR created_by = (SELECT auth.uid()));
    CREATE FUNCTION public.assign_estimate_seq() RETURNS trigger LANGUAGE plpgsql
      SECURITY DEFINER SET search_path = public AS $$
    BEGIN
      IF NEW.seq IS NULL OR NEW.seq = 0 THEN
        SELECT COALESCE(MAX(seq), 0) + 1 INTO NEW.seq FROM public.estimates WHERE job_id = NEW.job_id;
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER estimates_assign_seq BEFORE INSERT ON public.estimates
      FOR EACH ROW EXECUTE FUNCTION public.assign_estimate_seq();

    CREATE TABLE public.estimate_scopes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      estimate_id uuid NOT NULL REFERENCES public.estimates(id) ON DELETE CASCADE,
      name text NOT NULL,
      position integer NOT NULL DEFAULT 0
    );
    CREATE TABLE public.estimate_lines (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      estimate_id uuid NOT NULL REFERENCES public.estimates(id) ON DELETE CASCADE,
      scope_id uuid REFERENCES public.estimate_scopes(id) ON DELETE CASCADE,
      position integer NOT NULL DEFAULT 0,
      name text NOT NULL,
      quantity numeric(12,2) NOT NULL DEFAULT 1,
      unit_cost numeric(12,2) NOT NULL DEFAULT 0,
      unit_price numeric(12,2) NOT NULL DEFAULT 0,
      taxable boolean NOT NULL DEFAULT true,
      subtotal numeric(14,2) GENERATED ALWAYS AS (quantity * unit_price) STORED
    );
    ALTER TABLE public.estimate_scopes ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.estimate_lines ENABLE ROW LEVEL SECURITY;
    CREATE POLICY estimate_scopes_all ON public.estimate_scopes TO authenticated
      USING (EXISTS (SELECT 1 FROM public.estimates e WHERE e.id = estimate_id
        AND (public.can_view_location((SELECT auth.uid()), e.location_id) OR e.created_by = (SELECT auth.uid()))))
      WITH CHECK (EXISTS (SELECT 1 FROM public.estimates e WHERE e.id = estimate_id
        AND (public.can_view_location((SELECT auth.uid()), e.location_id) OR e.created_by = (SELECT auth.uid()))));
    CREATE POLICY estimate_lines_all ON public.estimate_lines TO authenticated
      USING (EXISTS (SELECT 1 FROM public.estimates e WHERE e.id = estimate_id
        AND (public.can_view_location((SELECT auth.uid()), e.location_id) OR e.created_by = (SELECT auth.uid()))))
      WITH CHECK (EXISTS (SELECT 1 FROM public.estimates e WHERE e.id = estimate_id
        AND (public.can_view_location((SELECT auth.uid()), e.location_id) OR e.created_by = (SELECT auth.uid()))));
    CREATE FUNCTION public.recalc_estimate_totals() RETURNS trigger LANGUAGE plpgsql
      SECURITY DEFINER SET search_path = public AS $$
    DECLARE eid uuid := COALESCE(NEW.estimate_id, OLD.estimate_id); rate numeric; sub numeric; tsub numeric;
    BEGIN
      SELECT tax_rate INTO rate FROM public.estimates WHERE id = eid;
      IF rate IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;
      SELECT COALESCE(SUM(subtotal), 0), COALESCE(SUM(subtotal) FILTER (WHERE taxable), 0)
        INTO sub, tsub FROM public.estimate_lines WHERE estimate_id = eid;
      UPDATE public.estimates SET subtotal = ROUND(sub, 2), tax = ROUND(tsub * rate, 2),
        total = ROUND(sub, 2) + ROUND(tsub * rate, 2) WHERE id = eid;
      RETURN COALESCE(NEW, OLD);
    END $$;
    CREATE TRIGGER estimate_lines_recalc AFTER INSERT OR UPDATE OR DELETE ON public.estimate_lines
      FOR EACH ROW EXECUTE FUNCTION public.recalc_estimate_totals();

    GRANT SELECT, INSERT, UPDATE, DELETE ON public.job_notes, public.job_section_notes,
      public.job_contacts, public.tasks, public.estimates, public.estimate_scopes TO authenticated;
    GRANT INSERT, UPDATE, DELETE ON public.estimate_lines TO authenticated;
    GRANT SELECT (id, estimate_id, scope_id, position, name, quantity, unit_price, taxable, subtotal)
      ON public.estimate_lines TO authenticated;
    GRANT SELECT ON public.jobs, public.profiles TO authenticated;

    INSERT INTO public.profiles (user_id, full_name, is_active) VALUES
      ('${admin}', 'Ada Admin', true), ('${manager}', 'Mona Manager', true),
      ('${rep}', 'Sarah Rep', true), ('${crew}', 'Mike Crew', true),
      ('${outsider}', 'Otto Outsider', true), ('${inactive}', 'Ina Inactive', false);
    INSERT INTO public.stub_privileged VALUES ('${admin}');
    INSERT INTO public.location_members (user_id, location_id, manages) VALUES
      ('${manager}', '${officeA}', true), ('${rep}', '${officeA}', false),
      ('${inactive}', '${officeA}', true), ('${outsider}', '${officeB}', true);
    INSERT INTO public.jobs VALUES ('${jobA}', '${officeA}', NULL), ('${jobB}', '${officeB}', NULL),
      ('${jobGone}', '${officeA}', NULL);
    INSERT INTO public.job_assignments VALUES ('${jobA}', '${crew}');
  `);

  /* ---- The migration, verbatim ---------------------------------------- */
  await db.exec(migration("20261006150000_record_history.sql"));

  /** Run one statement as a signed-in user; never leaves the role set. */
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
      `SELECT * FROM public.record_history WHERE table_name = $1 AND op = $2 ORDER BY seq DESC LIMIT 1`,
      [table, op],
    );

  /* ---- 1. Capture ----------------------------------------------------- */
  const note1 = "d0000000-0000-4000-8000-000000000001";
  await as(
    rep,
    `INSERT INTO public.job_section_notes (id, job_id, section_key, body, author_id)
     VALUES ('${note1}', '${jobA}', 'mitigation', 'Water in the basement, 3 inches', '${rep}')`,
  );
  await as(rep, `DELETE FROM public.job_section_notes WHERE id = '${note1}'`);
  const delNote = await latest("job_section_notes", "delete");
  check(delNote?.row_pk === note1, "deleting a section note writes a history row for it");
  check(delNote.actor_id === rep, "the history row names who deleted it");
  check(
    delNote.old_row.body === "Water in the basement, 3 inches" &&
      delNote.old_row.author_id === rep &&
      delNote.old_row.section_key === "mitigation",
    "a delete stores the whole row",
  );
  check(
    /mitigation note "Water in the basement/.test(delNote.summary),
    "the summary is a readable label of the item",
  );
  check(delNote.job_id === jobA, "the history row carries the job");

  const task1 = "e0000000-0000-4000-8000-000000000001";
  await db.query(
    `INSERT INTO public.tasks (id, title, assignee, job_id, location_id, created_by, due_date)
     VALUES ('${task1}', 'Pull equipment', '${crew}', '${jobA}', '${officeA}', '${manager}', '2026-10-10')`,
  );
  await as(manager, `UPDATE public.tasks SET title = 'Pull dehus' WHERE id = '${task1}'`);
  const edit1 = await latest("tasks", "update");
  check(
    JSON.stringify(edit1.changed_columns) === '["title"]',
    "an edit records only the captured columns that moved",
  );
  check(
    edit1.old_row.title === "Pull equipment" && edit1.new_row.title === "Pull dehus",
    "an edit stores the old and new values",
  );
  check(
    edit1.changes.title.before === "Pull equipment" && edit1.changes.title.after === "Pull dehus",
    "and a display-safe before/after",
  );
  check(!("assignee" in edit1.old_row), "columns that did not move are not stored");

  const before = await n(`SELECT count(*) AS n FROM public.record_history`);
  await as(
    crew,
    `UPDATE public.tasks SET status = 'done', completed_at = now() WHERE id = '${task1}'`,
  );
  check(
    (await n(`SELECT count(*) AS n FROM public.record_history`)) === before,
    "completing a task is not captured (Complete and Reopen undo each other)",
  );
  await as(
    crew,
    `UPDATE public.tasks SET status = 'open', completed_at = NULL WHERE id = '${task1}'`,
  );

  await as(manager, `UPDATE public.tasks SET assignee = '${rep}' WHERE id = '${task1}'`);
  const reassign = await latest("tasks", "update");
  check(
    reassign.changes.assignee.before === "Mike Crew" &&
      reassign.changes.assignee.after === "Sarah Rep",
    "an assignee change reads as names, not ids",
  );

  await db.query(
    `INSERT INTO public.job_section_notes (job_id, section_key, body, author_id, is_demo)
     VALUES ('${jobA}', 'mitigation', 'demo', '${rep}', true)`,
  );
  await db.query(`DELETE FROM public.job_section_notes WHERE is_demo`);
  await db.query(
    `INSERT INTO public.tasks (title, created_by, account_id) VALUES ('Account call', '${rep}', '${officeA}')`,
  );
  await db.query(`DELETE FROM public.tasks WHERE title = 'Account call'`);
  check(
    (await n(`SELECT count(*) AS n FROM public.record_history`)) === before + 1,
    "demo rows and account tasks (no job) are not captured",
  );

  /* ---- 2. Reading ----------------------------------------------------- */
  const visible = async (uid) =>
    Number(
      (await as(uid, `SELECT count(*) AS n FROM public.record_history WHERE job_id = '${jobA}'`))
        .rows[0].n,
    );
  check((await visible(rep)) >= 3, "an office member reads the job's history");
  check((await visible(crew)) >= 3, "crew on the job read it");
  check((await visible(outsider)) === 0, "another office reads none of it");
  check((await visible(inactive)) === 0, "an inactive profile reads none of it");

  await rejects(
    as(rep, `SELECT old_row FROM public.record_history LIMIT 1`),
    /permission denied/i,
    "the before-image column is not readable by a signed-in user",
  );
  await rejects(
    as(rep, `SELECT * FROM public.record_history LIMIT 1`),
    /permission denied/i,
    "select * fails by design",
  );
  await rejects(
    as(
      rep,
      `INSERT INTO public.record_history (table_name, row_pk, op, job_id, summary, old_row)
       VALUES ('job_notes', gen_random_uuid(), 'delete', '${jobA}', 'forged', '{}')`,
    ),
    /permission denied/i,
    "history cannot be forged from the app",
  );
  await rejects(
    as(rep, `UPDATE public.record_history SET summary = 'x'`),
    /permission denied/i,
    "history cannot be edited from the app",
  );
  await rejects(
    as(rep, `DELETE FROM public.record_history`),
    /permission denied/i,
    "history cannot be pruned from the app",
  );

  const policies = (
    await db.query(
      `SELECT policyname, permissive, roles::text AS roles FROM pg_policies WHERE tablename = 'record_history'`,
    )
  ).rows;
  check(
    policies.some(
      (p) =>
        p.policyname === "portal_customer_denied" &&
        p.permissive === "RESTRICTIVE" &&
        /portal_customer/.test(p.roles),
    ),
    "the portal_customer_denied restrictive policy is installed",
  );
  check(
    policies.some(
      (p) => p.policyname === "active_profile_required" && p.permissive === "RESTRICTIVE",
    ),
    "the active_profile_required restrictive policy is installed",
  );

  const fnPriv = async (role, sig) =>
    (await one(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`, [role, sig])).ok;
  check(
    !(await fnPriv("anon", "public.restore_record_history(uuid)")) &&
      !(await fnPriv("anon", "public.record_history_preview(uuid)")),
    "anon cannot execute restore or preview",
  );
  for (const sig of [
    "public.record_history_reinsert(text, jsonb)",
    "public.record_history_may_restore(uuid, text, text, jsonb, jsonb)",
    "public.record_history_state(public.record_history, uuid)",
    "public.record_history_capture()",
  ]) {
    check(!(await fnPriv("authenticated", sig)), `${sig} is not callable by a signed-in user`);
  }

  /* ---- 3. Restore stays inside the table's own rule -------------------- */
  await rejects(
    restore(outsider, delNote.id),
    /not available/,
    "another office cannot restore the entry",
  );
  await rejects(
    preview(outsider, delNote.id),
    /not available/,
    "nor preview it — the same answer as an entry that does not exist",
  );
  await rejects(
    restore(outsider, "f0000000-0000-4000-8000-000000000000"),
    /not available/,
    "an unknown id gives that same answer",
  );
  check(
    (await preview(crew, delNote.id)).status === "not_allowed",
    "the preview tells crew they may not restore a colleague's note",
  );
  await rejects(
    restore(crew, delNote.id),
    /can't restore this/,
    "crew cannot restore what they could not have removed",
  );
  check(
    (await n(`SELECT count(*) AS n FROM public.job_section_notes WHERE id = '${note1}'`)) === 0,
    "and the note stays deleted",
  );
  await rejects(
    restore(inactive, delNote.id),
    /not active/,
    "an inactive profile cannot restore, even as a manager of the office",
  );

  const p1 = await preview(rep, delNote.id);
  check(
    p1.status === "ready" && p1.detail.body === "Water in the basement, 3 inches",
    "the author's preview shows what will come back",
  );
  const r1 = await restore(rep, delNote.id);
  check(r1.status === "restored", "the author restores their own note");
  const back = await one(`SELECT * FROM public.job_section_notes WHERE id = '${note1}'`);
  check(
    back?.body === "Water in the basement, 3 inches" && back.author_id === rep,
    "it comes back with its own id, body and author",
  );
  const marker = await one(
    `SELECT * FROM public.record_history WHERE restores_id = $1 AND op = 'restore'`,
    [delNote.id],
  );
  check(marker?.actor_id === rep, "the restore is itself logged, with who did it");
  check(
    (await n(
      `SELECT count(*) AS n FROM public.record_history WHERE row_pk = '${note1}' AND op <> 'restore' AND seq > $1`,
      [delNote.seq],
    )) === 0,
    "the restore's own insert is not captured as a fresh change",
  );

  // A colleague's job note, removed by an admin.
  const note2 = "d0000000-0000-4000-8000-000000000002";
  await as(
    rep,
    `INSERT INTO public.job_notes (id, job_id, author_id, body) VALUES ('${note2}', '${jobA}', '${rep}', 'Adjuster coming Tuesday')`,
  );
  await as(admin, `DELETE FROM public.job_notes WHERE id = '${note2}'`);
  const delNote2 = await latest("job_notes", "delete");
  check(
    (await preview(manager, delNote2.id)).status === "not_allowed",
    "an office manager may not restore it: job_notes_delete says author or privileged",
  );
  // Why the restore cannot be SECURITY INVOKER: a plain INSERT is refused.
  await rejects(
    as(
      admin,
      `INSERT INTO public.job_notes (id, job_id, author_id, body) VALUES ('${note2}', '${jobA}', '${rep}', 'Adjuster coming Tuesday')`,
    ),
    /row-level security/i,
    "an admin cannot re-insert a colleague's note directly (the insert policy pins the author)",
  );
  check((await restore(admin, delNote2.id)).status === "restored", "but the admin can restore it");
  check(
    (await one(`SELECT author_id FROM public.job_notes WHERE id = '${note2}'`))?.author_id === rep,
    "under the colleague's name",
  );

  // A job contact: the manager rule.
  const contact1 = "d0000000-0000-4000-8000-000000000003";
  await as(
    manager,
    `INSERT INTO public.job_contacts (id, job_id, role, full_name, phone, is_default_contact)
     VALUES ('${contact1}', '${jobA}', 'adjuster', 'Pat Adjuster', '555-0100', true)`,
  );
  await as(manager, `DELETE FROM public.job_contacts WHERE id = '${contact1}'`);
  const delContact = await latest("job_contacts", "delete");
  check(
    (await preview(rep, delContact.id)).status === "not_allowed",
    "a rep who cannot manage the job cannot restore a job contact",
  );
  // Somebody else became the default meanwhile.
  await as(
    manager,
    `INSERT INTO public.job_contacts (job_id, role, full_name, is_default_contact) VALUES ('${jobA}', 'owner', 'Olive Owner', true)`,
  );
  await rejects(
    restore(manager, delContact.id),
    /another contact is now the default/,
    "a unique clash says what clashed",
  );
  check(
    (await n(`SELECT count(*) AS n FROM public.job_contacts WHERE id = '${contact1}'`)) === 0,
    "and writes nothing",
  );
  await db.query(
    `UPDATE public.job_contacts SET is_default_contact = false WHERE full_name = 'Olive Owner'`,
  );
  check(
    (await restore(manager, delContact.id)).status === "restored",
    "once the clash is gone the manager restores it",
  );

  /* ---- 4. The allow-list ---------------------------------------------- */
  await rejects(
    db.query(
      `INSERT INTO public.record_history (table_name, row_pk, op, job_id, summary, old_row)
       VALUES ('profiles', '${rep}', 'delete', '${jobA}', 'x', '{"user_id":"${rep}"}')`,
    ),
    /record_history_table_allowed/,
    "even the owner cannot file history against a table off the list",
  );
  // Mutation: take the CHECK away and the function's own list still holds.
  await db.exec(`ALTER TABLE public.record_history DROP CONSTRAINT record_history_table_allowed`);
  const forged = await one(
    `INSERT INTO public.record_history (table_name, row_pk, op, job_id, summary, old_row)
     VALUES ('profiles', gen_random_uuid(), 'delete', '${jobA}', 'x',
             '{"user_id":"a0000000-0000-4000-8000-0000000000ee","full_name":"Planted"}')
     RETURNING id`,
  );
  await rejects(
    restore(admin, forged.id),
    /not available for profiles/,
    "restore refuses a table off its own list, CHECK or no CHECK",
  );
  await rejects(
    db.query(`SELECT public.record_history_reinsert('profiles', '{"user_id":"${rep}"}')`),
    /not available for profiles/,
    "and so does the re-insert helper",
  );
  check(
    (await n(`SELECT count(*) AS n FROM public.profiles WHERE full_name = 'Planted'`)) === 0,
    "nothing was written to the table off the list",
  );
  await db.exec(`
    DELETE FROM public.record_history WHERE table_name = 'profiles';
    ALTER TABLE public.record_history ADD CONSTRAINT record_history_table_allowed CHECK (table_name IN (
      'job_notes', 'job_section_notes', 'job_contacts', 'tasks',
      'estimates', 'estimate_scopes', 'estimate_lines'));
  `);

  /* ---- 5. Idempotent -------------------------------------------------- */
  const again = await restore(rep, delNote.id);
  check(again.status === "already_restored", "restoring twice answers already restored");
  check(
    (await n(`SELECT count(*) AS n FROM public.job_section_notes WHERE id = '${note1}'`)) === 1,
    "and does not duplicate the note",
  );
  check(
    (await n(`SELECT count(*) AS n FROM public.record_history WHERE restores_id = $1`, [
      delNote.id,
    ])) === 1,
    "one restore marker per entry",
  );
  await as(rep, `DELETE FROM public.job_section_notes WHERE id = '${note1}'`);
  const delNoteAgain = await latest("job_section_notes", "delete");
  check(delNoteAgain.id !== delNote.id, "a second deletion is its own entry");
  check(
    (await preview(rep, delNote.id)).status === "already_restored",
    "the first entry still reads as restored",
  );
  check((await restore(rep, delNoteAgain.id)).status === "restored", "the second one restores");
  await rejects(
    restore(rep, marker.id),
    /nothing to put back/,
    "a restore marker is not itself restorable",
  );

  /* ---- 6. Conflicts --------------------------------------------------- */
  // task1 title: "Pull dehus" now (edit1: equipment -> dehus). Edit it again.
  await as(manager, `UPDATE public.tasks SET title = 'Pull dehus and fans' WHERE id = '${task1}'`);
  const edit2 = await latest("tasks", "update");
  const conflictPreview = await preview(manager, edit1.id);
  check(
    conflictPreview.status === "conflict",
    "reverting an edit that was edited again is a conflict",
  );
  const titleField = conflictPreview.fields.find((f) => f.column === "title");
  check(
    titleField.moved === true &&
      titleField.now === "Pull dehus and fans" &&
      titleField.before === "Pull equipment",
    "the preview shows what it was, what this change made it, and what it is now",
  );
  await rejects(
    restore(manager, edit1.id),
    /Changed again since \(title\)/,
    "the restore refuses and names the field",
  );
  check(
    (await one(`SELECT title FROM public.tasks WHERE id = '${task1}'`)).title ===
      "Pull dehus and fans",
    "and does not clobber the newer edit",
  );
  check((await restore(manager, edit2.id)).status === "restored", "the newer edit reverts");
  check(
    (await one(`SELECT title FROM public.tasks WHERE id = '${task1}'`)).title === "Pull dehus",
    "back to the middle value",
  );
  check((await restore(manager, edit1.id)).status === "restored", "then the older one reverts");
  check(
    (await one(`SELECT title FROM public.tasks WHERE id = '${task1}'`)).title === "Pull equipment",
    "back to the original",
  );
  check(
    (await n(
      `SELECT count(*) AS n FROM public.record_history WHERE row_pk = '${task1}' AND op = 'update' AND seq > $1`,
      [edit2.seq],
    )) === 0,
    "a revert is logged as a restore, not as a fresh edit",
  );

  // Already reverted by hand.
  await as(manager, `UPDATE public.tasks SET due_date = '2026-10-20' WHERE id = '${task1}'`);
  const dueEdit = await latest("tasks", "update");
  await as(manager, `UPDATE public.tasks SET due_date = '2026-10-10' WHERE id = '${task1}'`);
  check(
    (await restore(manager, dueEdit.id)).status === "already_reverted",
    "an edit somebody already undid by hand answers already reverted",
  );

  // The UPDATE rule, both halves: the crew member was the assignee until the
  // reassignment to the rep; reverting it would need USING on the row as it
  // is now (assignee = rep, created by the manager), which crew fails.
  check(
    (await preview(crew, reassign.id)).status !== "ready",
    "crew cannot revert a reassignment away from them (USING on the current row)",
  );

  // Edit, then delete: the edit is gone with the row.
  const task2 = "e0000000-0000-4000-8000-000000000002";
  await db.query(
    `INSERT INTO public.tasks (id, title, job_id, location_id, created_by) VALUES ('${task2}', 'Moisture map', '${jobA}', '${officeA}', '${rep}')`,
  );
  await as(rep, `UPDATE public.tasks SET priority = 'high' WHERE id = '${task2}'`);
  const prioEdit = await latest("tasks", "update");
  await as(rep, `DELETE FROM public.tasks WHERE id = '${task2}'`);
  const delTask2 = await latest("tasks", "delete");
  check((await preview(rep, prioEdit.id)).status === "gone", "an edit to a deleted row reads gone");
  await rejects(
    restore(rep, prioEdit.id),
    /Restore the deletion first/,
    "and says to restore the deletion first",
  );
  check((await restore(rep, delTask2.id)).status === "restored", "the deletion restores");
  check(
    (await one(`SELECT priority FROM public.tasks WHERE id = '${task2}'`)).priority === "high",
    "with the row as it was when deleted",
  );
  check((await restore(rep, prioEdit.id)).status === "restored", "and then the edit reverts");

  /* ---- 7. An estimate comes back whole -------------------------------- */
  const est = "e5000000-0000-4000-8000-000000000001";
  const scope = "e5000000-0000-4000-8000-0000000000a1";
  await as(
    rep,
    `INSERT INTO public.estimates (id, job_id, location_id, title, tax_rate, created_by)
     VALUES ('${est}', '${jobA}', '${officeA}', 'Mitigation', 0.1, '${rep}')`,
  );
  await as(
    rep,
    `INSERT INTO public.estimate_scopes (id, estimate_id, name) VALUES ('${scope}', '${est}', 'Basement')`,
  );
  await db.query(
    `INSERT INTO public.estimate_lines (estimate_id, scope_id, name, quantity, unit_cost, unit_price)
     VALUES ('${est}', '${scope}', 'Dehumidifier day', 3, 41.50, 95),
            ('${est}', '${scope}', 'Air mover day', 6, 9.25, 30)`,
  );
  const estBefore = await one(
    `SELECT seq, subtotal, tax, total FROM public.estimates WHERE id = '${est}'`,
  );
  check(Number(estBefore.total) === 511.5, "the fixture estimate totals 465 + 10% tax");

  await as(manager, `DELETE FROM public.estimates WHERE id = '${est}'`);
  const delEst = await latest("estimates", "delete");
  const kids = (
    await db.query(`SELECT table_name FROM public.record_history WHERE parent_id = $1`, [delEst.id])
  ).rows.map((r) => r.table_name);
  check(
    kids.filter((t) => t === "estimate_lines").length === 2 &&
      kids.filter((t) => t === "estimate_scopes").length === 1,
    "the estimate's scope and lines are captured as its children (the trigger fires before the cascade)",
  );
  check(
    (await n(
      `SELECT count(*) AS n FROM public.record_history WHERE table_name = 'estimate_lines' AND parent_id IS NULL`,
    )) === 0,
    "no line is captured on its own",
  );
  check(
    Number(
      (await as(rep, `SELECT count(*) AS n FROM public.record_history WHERE parent_id IS NOT NULL`))
        .rows[0].n,
    ) === 0,
    "line rows are not readable, even by the estimate's author",
  );
  const estPreview = await preview(rep, delEst.id);
  check(
    estPreview.status === "ready" &&
      estPreview.detail.number === "ESTIMATE-1" &&
      Number(estPreview.children.lines) === 2 &&
      !("total" in estPreview.detail),
    "the preview shows the number, title and line count — never the money",
  );
  check(
    (await preview(crew, delEst.id)).status === "not_allowed",
    "crew may not restore an estimate (estimates_delete: office manager or its creator)",
  );
  check((await restore(rep, delEst.id)).status === "restored", "its creator restores it");
  const estAfter = await one(
    `SELECT seq, subtotal, tax, total FROM public.estimates WHERE id = '${est}'`,
  );
  check(
    estAfter.seq === estBefore.seq && Number(estAfter.total) === Number(estBefore.total),
    "same number, same totals",
  );
  check(
    (await n(`SELECT count(*) AS n FROM public.estimate_scopes WHERE id = '${scope}'`)) === 1 &&
      (await n(`SELECT count(*) AS n FROM public.estimate_lines WHERE estimate_id = '${est}'`)) ===
        2,
    "its scope and both lines are back",
  );
  check(
    Number(
      (await one(`SELECT unit_cost FROM public.estimate_lines WHERE name = 'Dehumidifier day'`))
        .unit_cost,
    ) === 41.5,
    "including the withheld unit cost, which the restorer could never have read",
  );

  // The number is taken by a newer estimate.
  await as(manager, `DELETE FROM public.estimates WHERE id = '${est}'`);
  const delEst2 = await latest("estimates", "delete");
  await as(
    rep,
    `INSERT INTO public.estimates (job_id, location_id, title, created_by) VALUES ('${jobA}', '${officeA}', 'Rebuild', '${rep}')`,
  );
  await rejects(
    restore(rep, delEst2.id),
    /another estimate on this job now has that number/,
    "a reused estimate number refuses with a reason",
  );
  check(
    (await n(`SELECT count(*) AS n FROM public.estimate_lines WHERE estimate_id = '${est}'`)) === 0,
    "and leaves no half-restored lines behind",
  );

  /* ---- 8. Mutation: the rule is what stops crew ------------------------ */
  await as(rep, `DELETE FROM public.job_section_notes WHERE id = '${note1}'`);
  const delNote3 = await latest("job_section_notes", "delete");
  await rejects(restore(crew, delNote3.id), /can't restore this/, "crew is refused (control)");
  await db.exec(`
    ALTER FUNCTION public.record_history_may_restore(uuid, text, text, jsonb, jsonb)
      RENAME TO record_history_may_restore_real;
    CREATE FUNCTION public.record_history_may_restore(uuid, text, text, jsonb, jsonb)
      RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
  `);
  check(
    (await restore(crew, delNote3.id)).status === "restored",
    "MUTATION: with the rule replaced by true, the same crew restore goes through",
  );
  await db.exec(`
    DROP FUNCTION public.record_history_may_restore(uuid, text, text, jsonb, jsonb);
    ALTER FUNCTION public.record_history_may_restore_real(uuid, text, text, jsonb, jsonb)
      RENAME TO record_history_may_restore;
  `);

  /* ---- 9. A whole job going ------------------------------------------- */
  await db.query(
    `INSERT INTO public.job_section_notes (job_id, section_key, body, author_id) VALUES ('${jobGone}', 'drying', 'x', '${rep}')`,
  );
  await as(rep, `DELETE FROM public.job_section_notes WHERE job_id = '${jobGone}'`);
  check(
    (await n(`SELECT count(*) AS n FROM public.record_history WHERE job_id = '${jobGone}'`)) === 1,
    "fixture: the gone job has one history row",
  );
  await db.query(
    `INSERT INTO public.job_section_notes (job_id, section_key, body, author_id) VALUES ('${jobGone}', 'drying', 'y', '${rep}')`,
  );
  await db.query(`DELETE FROM public.jobs WHERE id = '${jobGone}'`);
  check(
    (await n(`SELECT count(*) AS n FROM public.record_history WHERE job_id = '${jobGone}'`)) === 0,
    "deleting a whole job captures nothing of its cascade and takes its history with it",
  );

  /* ---- 10. The live audit runs clean here ----------------------------- */
  // The SQL Mark pastes after applying; zero rows from 1–4 here keeps it
  // honest, and query 5 (informational) at least has to parse and run.
  const audit = readFileSync(new URL("./record-history-live-audit.sql", import.meta.url), "utf8")
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  check(audit.length === 5, "the live audit has five queries");
  for (const [i, sql] of audit.entries()) {
    const rows = (await db.query(sql)).rows;
    if (i < 4) check(rows.length === 0, `live audit query ${i + 1} returns no rows`);
  }

  console.log(`record-history.pglite: ${assertions} assertions passed`);
} finally {
  await db.close();
}
