// Run with: node supabase/tests/estimate-delete.pglite.mjs <existing PGlite dist/index.js>
// In-memory fixtures only. No connection string, network access or live writes.
//
// Deleting an estimate from a job's Billing tab, restorable from the Timeline.
// Mark: "add a delete button here" (an empty ESTIMATE-2 draft), and in the same
// message "in timeline have a restore button for each item that gets removed
// or changed". Both migrations under test — #300's record_history and this
// PR's estimate delete — are READ FROM THE FILES, never retyped here.
//
// What it proves:
//   1. record_history_covers(): false before this migration's trigger is
//      there, true for estimates and job_calculations after, false for
//      invoices; anon cannot call it;
//   2. an invoiced estimate cannot be deleted (and neither can an invoiced
//      Quick Estimate, once invoices.job_calculation_id exists), even by an
//      admin; an uninvoiced one can, by whoever its DELETE policy allows;
//   3. a deleted estimate comes back whole from restore_record_history;
//   4. a deleted Quick Estimate is captured — summary and display without
//      its price — and comes back, but only for someone who could have
//      deleted it;
//   5. deleting a whole job with an invoiced estimate is not blocked;
//   6. mutation: with the guard trigger dropped, the invoiced delete in (2)
//      goes through — so (2) is the guard's doing.
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
const jobGone = "c0000000-0000-4000-8000-0000000000ff";

/** Run `sql` as `uid` through the authenticated role, as PostgREST would. */
async function as(uid, sql, params = []) {
  await db.exec(
    `SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', '${uid}', false);`,
  );
  try {
    return await db.query(sql, params);
  } finally {
    await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claim.sub', '', false);`);
  }
}

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
      is_active boolean NOT NULL DEFAULT true,
      approval_status text NOT NULL DEFAULT 'approved'
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
    CREATE FUNCTION public.can_view_job(_user_id uuid, _job_id uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = _job_id AND (
        public.is_privileged(_user_id) OR public.can_view_location(_user_id, j.location_id)
        OR j.crew_chief = _user_id));
    $$;
    CREATE FUNCTION public.can_manage_job(_user_id uuid, _job_id uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = _job_id AND (
        public.is_privileged(_user_id) OR public.can_manage_location(_user_id, j.location_id)));
    $$;

    -- The other tables #300 attaches its trigger to; only what it touches.
    CREATE TABLE public.job_notes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE, author_id uuid, body text);
    CREATE TABLE public.job_section_notes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE, section_key text,
      body text, author_id uuid);
    CREATE TABLE public.job_contacts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE, role text, full_name text);
    CREATE TABLE public.tasks (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      job_id uuid REFERENCES public.jobs(id) ON DELETE CASCADE, title text, created_by uuid,
      location_id uuid);

    -- estimates + policies, 20260813172023.
    CREATE TABLE public.estimates (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
      location_id uuid NOT NULL,
      seq integer,
      status text NOT NULL DEFAULT 'draft',
      title text,
      total numeric(14,2) NOT NULL DEFAULT 0,
      created_by uuid,
      UNIQUE (job_id, seq)
    );
    ALTER TABLE public.estimates ENABLE ROW LEVEL SECURITY;
    CREATE POLICY estimates_select ON public.estimates FOR SELECT TO authenticated
      USING (public.can_view_location((SELECT auth.uid()), location_id) OR created_by = (SELECT auth.uid()));
    CREATE POLICY estimates_delete ON public.estimates FOR DELETE TO authenticated
      USING (public.can_manage_location((SELECT auth.uid()), location_id) OR created_by = (SELECT auth.uid()));
    CREATE TABLE public.estimate_scopes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      estimate_id uuid NOT NULL REFERENCES public.estimates(id) ON DELETE CASCADE,
      name text NOT NULL, position integer NOT NULL DEFAULT 0
    );
    CREATE TABLE public.estimate_lines (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      estimate_id uuid NOT NULL REFERENCES public.estimates(id) ON DELETE CASCADE,
      scope_id uuid REFERENCES public.estimate_scopes(id) ON DELETE CASCADE,
      position integer NOT NULL DEFAULT 0, name text NOT NULL,
      quantity numeric(12,2) NOT NULL DEFAULT 1, unit_price numeric(12,2) NOT NULL DEFAULT 0
    );

    -- job_calculations + its delete policy, 20260903172802; SELECT as 20260910160806.
    CREATE TABLE public.job_calculations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      location_id uuid NOT NULL,
      job_id uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
      job_date date NOT NULL DEFAULT '2026-10-06',
      job_type text NOT NULL DEFAULT 'water',
      customer_price numeric(12,2) NOT NULL DEFAULT 0,
      internal_cost numeric(12,2) NOT NULL DEFAULT 0,
      created_by uuid NOT NULL
    );
    ALTER TABLE public.job_calculations ENABLE ROW LEVEL SECURITY;
    CREATE POLICY job_calculations_select ON public.job_calculations FOR SELECT TO authenticated
      USING (public.can_view_location((SELECT auth.uid()), location_id) OR created_by = (SELECT auth.uid()));
    CREATE POLICY job_calculations_delete ON public.job_calculations FOR DELETE TO authenticated
      USING (public.can_manage_location((SELECT auth.uid()), location_id) OR created_by = (SELECT auth.uid()));

    -- invoices, ON DELETE SET NULL to the estimate as in 20260818171314.
    CREATE TABLE public.invoices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
      estimate_id uuid REFERENCES public.estimates(id) ON DELETE SET NULL,
      invoice_number text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
    -- Nobody but an admin sees invoices here, so the guard must look past RLS.
    CREATE POLICY invoices_select ON public.invoices FOR SELECT TO authenticated
      USING (public.is_privileged((SELECT auth.uid())));

    GRANT SELECT, INSERT, UPDATE, DELETE ON public.estimates, public.estimate_scopes,
      public.estimate_lines, public.job_calculations, public.invoices TO authenticated;
    GRANT SELECT ON public.jobs, public.profiles TO authenticated;

    INSERT INTO public.profiles (user_id, full_name) VALUES
      ('${admin}', 'Ada Admin'), ('${manager}', 'Mona Manager'),
      ('${rep}', 'Sarah Rep'), ('${crew}', 'Mike Crew');
    INSERT INTO public.stub_privileged VALUES ('${admin}');
    INSERT INTO public.location_members (user_id, location_id, manages) VALUES
      ('${manager}', '${officeA}', true), ('${rep}', '${officeA}', false),
      ('${crew}', '${officeA}', false);
    INSERT INTO public.jobs (id, location_id) VALUES ('${jobA}', '${officeA}'), ('${jobGone}', '${officeA}');
  `);

  // #300 first, as it must be applied.
  await db.exec(migration("20261006150000_record_history.sql"));

  // 1. Before this migration: no record_history_covers, so the app offers nothing.
  await rejects(
    as(rep, `SELECT public.record_history_covers('estimates')`),
    /does not exist/,
    "before this migration the probe is missing, which the app reads as 'no Delete'",
  );

  const mine = migration("20261006163000_estimate_delete.sql");
  await db.exec(mine);
  await db.exec(mine); // re-runnable

  const covers = async (t) =>
    (await as(rep, `SELECT public.record_history_covers($1) AS c`, [t])).rows[0].c;
  check((await covers("estimates")) === true, "estimates are covered");
  check(
    (await covers("job_calculations")) === true,
    "Quick Estimates are covered by this migration",
  );
  check((await covers("invoices")) === false, "invoices are not (money is out)");
  check((await covers("no_such_table")) === false, "an unknown table is simply not covered");
  await db.exec(`SET ROLE anon;`);
  await rejects(
    db.query(`SELECT public.record_history_covers('estimates')`),
    /permission denied/,
    "anon cannot call it",
  );
  await db.exec(`RESET ROLE;`);

  // 2. Invoiced estimates stay; uninvoiced ones go.
  const est = async (title, by) =>
    (
      await db.query(
        `INSERT INTO public.estimates (job_id, location_id, seq, title, created_by)
         VALUES ($1, $2, (SELECT COALESCE(MAX(seq),0)+1 FROM public.estimates WHERE job_id = $1), $3, $4)
         RETURNING id`,
        [jobA, officeA, title, by],
      )
    ).rows[0].id;
  const invoiced = await est("Invoiced", rep);
  await db.query(
    `INSERT INTO public.invoices (job_id, estimate_id, invoice_number) VALUES ($1, $2, 'GS-INV-2026-00018')`,
    [jobA, invoiced],
  );
  await rejects(
    as(admin, `DELETE FROM public.estimates WHERE id = $1`, [invoiced]),
    /invoiced as GS-INV-2026-00018/,
    "an admin cannot delete an invoiced estimate",
  );
  await rejects(
    as(rep, `DELETE FROM public.estimates WHERE id = $1`, [invoiced]),
    /invoiced as GS-INV-2026-00018/,
    "its author cannot either — and is told the invoice number they could not see",
  );
  check(
    (await db.query(`SELECT 1 FROM public.estimates WHERE id = $1`, [invoiced])).rows.length === 1,
    "the invoiced estimate is still there",
  );

  const empty = await est("Empty draft", manager);
  await db.query(
    `INSERT INTO public.estimate_scopes (estimate_id, name) VALUES ($1, 'Basement');
     `.trim(),
    [empty],
  );
  const crewDelete = await as(crew, `DELETE FROM public.estimates WHERE id = $1 RETURNING id`, [
    empty,
  ]);
  check(crewDelete.rows.length === 0, "crew cannot delete a manager's estimate (RLS, 0 rows)");
  const repDelete = await as(rep, `DELETE FROM public.estimates WHERE id = $1 RETURNING id`, [
    empty,
  ]);
  check(repDelete.rows.length === 0, "a rep who is not its author or a manager cannot either");
  const mgrDelete = await as(manager, `DELETE FROM public.estimates WHERE id = $1 RETURNING id`, [
    empty,
  ]);
  check(mgrDelete.rows.length === 1, "the office manager can");

  // 3. It comes back whole.
  const estHist = (
    await db.query(
      `SELECT id FROM public.record_history WHERE table_name = 'estimates' AND row_pk = $1 AND op = 'delete'`,
      [empty],
    )
  ).rows[0]?.id;
  check(!!estHist, "the delete was captured by #300's trigger");
  const back = (await as(manager, `SELECT public.restore_record_history($1) AS r`, [estHist]))
    .rows[0].r;
  check(back.status === "restored", "and restores");
  check(
    (
      await db.query(
        `SELECT count(*)::int AS n FROM public.estimate_scopes WHERE estimate_id = $1`,
        [empty],
      )
    ).rows[0].n === 1,
    "with its scope",
  );

  // 4. Quick Estimates.
  const calc = (
    await db.query(
      `INSERT INTO public.job_calculations (location_id, job_id, job_type, customer_price, internal_cost, created_by)
       VALUES ($1, $2, 'fire_smoke', 2350, 900, $3) RETURNING id`,
      [officeA, jobA, rep],
    )
  ).rows[0].id;
  const crewCalc = await as(
    crew,
    `DELETE FROM public.job_calculations WHERE id = $1 RETURNING id`,
    [calc],
  );
  check(crewCalc.rows.length === 0, "crew cannot delete a rep's Quick Estimate");
  const repCalc = await as(rep, `DELETE FROM public.job_calculations WHERE id = $1 RETURNING id`, [
    calc,
  ]);
  check(repCalc.rows.length === 1, "its author can");
  const calcHist = (
    await db.query(
      `SELECT id, summary FROM public.record_history WHERE table_name = 'job_calculations' AND row_pk = $1`,
      [calc],
    )
  ).rows[0];
  check(!!calcHist, "the Quick Estimate's delete was captured");
  check(
    calcHist.summary === 'Quick Estimate "Fire / Smoke" of 2026-10-06',
    `summary: ${calcHist.summary}`,
  );
  const preview = (await as(rep, `SELECT public.record_history_preview($1) AS p`, [calcHist.id]))
    .rows[0].p;
  check(preview.status === "ready", `the author sees Restore ready (${preview.status})`);
  // On the human-readable part only: the preview also carries the entry's
  // random id, which can contain "900" by chance.
  check(
    JSON.stringify(Object.keys(preview.detail).sort()) === '["date","type"]' &&
      !JSON.stringify(preview.detail).includes("2350") &&
      !JSON.stringify(preview.detail).includes("900"),
    `the preview shows type and date, never the price or the cost (${JSON.stringify(preview.detail)})`,
  );
  const crewPreview = (
    await as(crew, `SELECT public.record_history_preview($1) AS p`, [calcHist.id])
  ).rows[0].p;
  check(
    crewPreview.status === "not_allowed",
    "crew, who could not have deleted it, cannot restore it",
  );
  await rejects(
    as(crew, `SELECT public.restore_record_history($1)`, [calcHist.id]),
    /can't restore this/,
    "and the restore refuses them",
  );
  const calcBack = (await as(rep, `SELECT public.restore_record_history($1) AS r`, [calcHist.id]))
    .rows[0].r;
  check(calcBack.status === "restored", "the author restores it");
  const row = (
    await db.query(
      `SELECT customer_price, internal_cost FROM public.job_calculations WHERE id = $1`,
      [calc],
    )
  ).rows[0];
  check(
    Number(row.customer_price) === 2350 && Number(row.internal_cost) === 900,
    "price and withheld cost intact",
  );

  // An invoiced Quick Estimate, once 20261006161000's column exists.
  await db.exec(`ALTER TABLE public.invoices ADD COLUMN job_calculation_id uuid
    REFERENCES public.job_calculations(id) ON DELETE SET NULL;`);
  await db.query(
    `INSERT INTO public.invoices (job_id, job_calculation_id, invoice_number) VALUES ($1, $2, 'GS-INV-2026-00019')`,
    [jobA, calc],
  );
  await rejects(
    as(rep, `DELETE FROM public.job_calculations WHERE id = $1`, [calc]),
    /invoiced as GS-INV-2026-00019/,
    "an invoiced Quick Estimate cannot be deleted",
  );

  // 5. Deleting the whole job is not blocked by an invoiced estimate on it.
  const goneEst = (
    await db.query(
      `INSERT INTO public.estimates (job_id, location_id, seq, created_by) VALUES ($1, $2, 1, $3) RETURNING id`,
      [jobGone, officeA, rep],
    )
  ).rows[0].id;
  await db.query(
    `INSERT INTO public.invoices (job_id, estimate_id, invoice_number) VALUES ($1, $2, 'GS-INV-X')`,
    [jobGone, goneEst],
  );
  await db.query(`DELETE FROM public.jobs WHERE id = $1`, [jobGone]);
  check(
    (await db.query(`SELECT 1 FROM public.jobs WHERE id = $1`, [jobGone])).rows.length === 0,
    "a job with an invoiced estimate can still be deleted as a whole",
  );

  // 6. Mutation: without the guard, the invoiced delete goes through.
  await db.exec(`DROP TRIGGER estimates_refuse_invoiced_delete ON public.estimates;`);
  const unguarded = await as(admin, `DELETE FROM public.estimates WHERE id = $1 RETURNING id`, [
    invoiced,
  ]);
  check(
    unguarded.rows.length === 1,
    "mutation: with the guard dropped the invoiced delete succeeds",
  );

  console.log(`estimate-delete.pglite: ${assertions} assertions passed`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.close();
}
