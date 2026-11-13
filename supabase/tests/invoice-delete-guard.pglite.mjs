// Run with: node supabase/tests/invoice-delete-guard.pglite.mjs <existing PGlite dist/index.js>
// In-memory fixtures only. No connection string, network access or live writes.
//
// Only an untouched draft invoice can be deleted. Mark, of the Invoices card:
// "need to rework this box to make more sense and need a delete or undo".
// The migration under test is READ FROM THE FILE.
//
// What it proves:
//   1. an untouched draft deletes, for an office manager (invoices_delete);
//      someone else deletes nothing (RLS, 0 rows);
//   2. even a manager cannot delete a sent, ruled-on, paid, or ever-paid
//      (payment removed, trail kept) invoice, or one in any other status;
//   3. a delete is written to activity_log by the existing logger;
//   4. a whole job with a paid invoice can still be deleted;
//   5. mutation: with the guard dropped, the paid delete goes through.
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
const rep = "a0000000-0000-4000-8000-000000000003";
const officeA = "b0000000-0000-4000-8000-00000000000a";
const jobA = "c0000000-0000-4000-8000-00000000000a";
const jobGone = "c0000000-0000-4000-8000-0000000000ff";

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
    CREATE SCHEMA auth;
    GRANT USAGE ON SCHEMA public, auth TO anon, authenticated;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

    CREATE TABLE public.location_members (user_id uuid, location_id uuid, manages boolean);
    CREATE FUNCTION public.can_view_location(_u uuid, _l uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
      $$ SELECT EXISTS (SELECT 1 FROM public.location_members m WHERE m.user_id = _u AND m.location_id = _l) $$;
    CREATE FUNCTION public.can_manage_location(_u uuid, _l uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
      $$ SELECT EXISTS (SELECT 1 FROM public.location_members m
                         WHERE m.user_id = _u AND m.location_id = _l AND m.manages) $$;

    CREATE TABLE public.jobs (id uuid PRIMARY KEY, location_id uuid NOT NULL);

    -- invoices as 20260731003140, with its delete policy.
    CREATE TYPE public.invoice_status AS ENUM ('draft','sent','partial','paid','disputed','written_off');
    CREATE TABLE public.invoices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
      location_id uuid NOT NULL,
      invoice_number text NOT NULL,
      billed_amount numeric(12,2) NOT NULL DEFAULT 0,
      approved_amount numeric(12,2),
      collected_amount numeric(12,2) NOT NULL DEFAULT 0,
      status public.invoice_status NOT NULL DEFAULT 'draft',
      sent_at timestamptz,
      created_by uuid
    );
    ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
    CREATE POLICY invoices_select ON public.invoices FOR SELECT TO authenticated
      USING (public.can_view_location(auth.uid(), location_id) OR created_by = auth.uid());
    CREATE POLICY invoices_delete ON public.invoices FOR DELETE TO authenticated
      USING (public.can_manage_location(auth.uid(), location_id));
    CREATE TABLE public.invoice_payments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
      amount numeric(12,2) NOT NULL
    );
    CREATE TABLE public.invoice_payment_changes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      payment_id uuid NOT NULL,
      invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
      action text NOT NULL
    );

    -- activity_log and the generic logger's DELETE path, 20260820194628 /
    -- 20260820195702, reduced to what a delete writes.
    CREATE TABLE public.activity_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      module text NOT NULL, event_type text NOT NULL, actor_id uuid,
      summary text NOT NULL, detail jsonb NOT NULL DEFAULT '{}'::jsonb,
      record_type text, record_id uuid, record_label text
    );
    CREATE FUNCTION public.log_row_activity() RETURNS trigger LANGUAGE plpgsql
      SECURITY DEFINER SET search_path = public AS $$
    DECLARE v_row jsonb := to_jsonb(OLD);
    BEGIN
      INSERT INTO public.activity_log (module, event_type, actor_id, summary, detail, record_type, record_id, record_label)
      VALUES (TG_ARGV[0], TG_ARGV[1] || '.delete', auth.uid(),
              'Invoice deleted — ' || (v_row ->> TG_ARGV[3]),
              jsonb_build_object('table', TG_TABLE_NAME, 'job_id', v_row ->> 'job_id'),
              TG_ARGV[1], (v_row ->> TG_ARGV[2])::uuid, v_row ->> TG_ARGV[3]);
      RETURN OLD;
    END $$;
    CREATE TRIGGER log_activity_invoices AFTER DELETE ON public.invoices
      FOR EACH ROW EXECUTE FUNCTION public.log_row_activity('billing', 'invoice', 'id', 'invoice_number');

    GRANT SELECT, DELETE ON public.invoices TO authenticated;
    INSERT INTO public.location_members VALUES ('${manager}', '${officeA}', true), ('${rep}', '${officeA}', false);
    INSERT INTO public.jobs VALUES ('${jobA}', '${officeA}'), ('${jobGone}', '${officeA}');
  `);

  const mine = migration("20261006181000_invoice_delete_guard.sql");
  await db.exec(mine);
  await db.exec(mine); // re-runnable

  let n = 0;
  const invoice = async (patch = {}, job = jobA) => {
    n += 1;
    const cols = {
      job_id: job,
      location_id: officeA,
      invoice_number: `GS-INV-2026-000${10 + n}`,
      created_by: rep,
      ...patch,
    };
    const keys = Object.keys(cols);
    const { rows } = await db.query(
      `INSERT INTO public.invoices (${keys.join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id, invoice_number`,
      Object.values(cols),
    );
    return rows[0];
  };
  const del = (uid, id) => as(uid, `DELETE FROM public.invoices WHERE id = $1 RETURNING id`, [id]);

  // 1. An untouched draft.
  const draft = await invoice();
  check((await del(rep, draft.id)).rows.length === 0, "its author, not a manager, deletes nothing");
  check(
    (await del(manager, draft.id)).rows.length === 1,
    "an office manager deletes the untouched draft",
  );

  // 3. ... and it was logged.
  const log = await db.query(`SELECT * FROM public.activity_log WHERE record_id = $1`, [draft.id]);
  check(
    log.rows.length === 1 && log.rows[0].event_type === "invoice.delete",
    "the delete is in activity_log",
  );
  check(log.rows[0].detail.job_id === jobA, "with the job, so it reaches the job's Timeline");

  // 2. Everything that has left the building stays.
  const cases = [
    ["sent", { status: "sent", sent_at: new Date().toISOString() }],
    ["moved back to draft after sending", { sent_at: new Date().toISOString() }],
    ["ruled on by the carrier", { approved_amount: 900 }],
    ["paid", { status: "paid", collected_amount: 1198 }],
    ["written off", { status: "written_off" }],
    ["disputed", { status: "disputed" }],
  ];
  for (const [what, patch] of cases) {
    const inv = await invoice(patch);
    await rejects(del(manager, inv.id), /can't be deleted/, `a ${what} invoice cannot be deleted`);
  }
  const withPayment = await invoice();
  await db.query(`INSERT INTO public.invoice_payments (invoice_id, amount) VALUES ($1, 100)`, [
    withPayment.id,
  ]);
  await rejects(
    del(manager, withPayment.id),
    /can't be deleted/,
    "nor a draft with a payment on it",
  );
  const withTrail = await invoice();
  await db.query(
    `INSERT INTO public.invoice_payment_changes (payment_id, invoice_id, action) VALUES (gen_random_uuid(), $1, 'remove')`,
    [withTrail.id],
  );
  await rejects(
    del(manager, withTrail.id),
    /can't be deleted/,
    "nor a draft whose payment was removed — the trail would go with it",
  );

  // 4. A whole job goes, paid invoice and all.
  await invoice({ status: "paid", collected_amount: 50 }, jobGone);
  await db.query(`DELETE FROM public.jobs WHERE id = $1`, [jobGone]);
  check(
    (await db.query(`SELECT 1 FROM public.invoices WHERE job_id = $1`, [jobGone])).rows.length ===
      0,
    "deleting a job is not blocked by its paid invoice",
  );

  // 5. Mutation.
  const paid = await invoice({ status: "paid", collected_amount: 10 });
  await db.exec(`DROP TRIGGER invoices_refuse_issued_delete ON public.invoices;`);
  check(
    (await del(manager, paid.id)).rows.length === 1,
    "mutation: without the guard a paid invoice deletes",
  );

  console.log(`invoice-delete-guard.pglite: ${assertions} assertions passed`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.close();
}
