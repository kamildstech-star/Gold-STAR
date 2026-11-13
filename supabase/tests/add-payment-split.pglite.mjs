// Run with: node supabase/tests/add-payment-split.pglite.mjs <existing PGlite dist/index.js>
// In-memory fixtures only. No connection string, network access or live writes.
//
// Mark, 2026-10-07, showing JobNimbus's Add Payment: "make this pop up for add
// payment, just with our look, and allow them to check an invoice it's
// applying to."
//
// The dialog saves a split payment as ONE PostgREST insert of several
// invoice_payments rows (`recordInvoicePayments` in src/lib/add-payment.ts).
// No new function or migration: this proves the existing table, policies and
// triggers — READ FROM THEIR MIGRATION FILES — already give that one insert
// what an RPC would have:
//   1. all or none: one row the write policy refuses takes every row back;
//      and the mutation — the same rows sent one insert at a time — leaves a
//      half-recorded payment, which is why the app must never loop it;
//   2. it goes in under the caller's RLS: a manager may split across any of
//      the office's invoices; an invoice's creator only across their own;
//      another office nothing;
//   3. the rollup trigger moves BOTH invoices (collected, partial/paid);
//   4. the rows of one split share created_at and created_by, which is what
//      `splitSiblings` reads for "split across"; a later save does not;
//   5. the payment trail (tg_invoice_payment_audit) is untouched by the
//      insert — it records edits and removals, as it always has — and still
//      fires when one row of a split is corrected or removed, moving only
//      that invoice back.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
const migration = (name) =>
  readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8").replace(/\r\n/g, "\n");

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
const stranger = "a0000000-0000-4000-8000-000000000004";
const officeA = "b0000000-0000-4000-8000-00000000000a";
const officeB = "b0000000-0000-4000-8000-00000000000b";

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

/** What PostgREST runs for `.from("invoice_payments").insert([...])`: one statement. */
const COLS = "invoice_id, amount, method, received_at, reference, notes, created_by";
const bulkInsert = (uid, rows) =>
  as(
    uid,
    `INSERT INTO public.invoice_payments (${COLS})
     SELECT ${COLS} FROM json_populate_recordset(NULL::public.invoice_payments, $1::json)
     RETURNING id, invoice_id, created_at::text AS created_at, created_by`,
    [JSON.stringify(rows)],
  );

const row = (invoice_id, amount, uid, reference = "104882") => ({
  invoice_id,
  amount,
  method: "Check",
  received_at: "2026-10-07",
  reference,
  notes: null,
  created_by: uid,
});

try {
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role;
    CREATE SCHEMA auth;
    GRANT USAGE ON SCHEMA public, auth TO anon, authenticated;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
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

    -- invoices as 20260731003140, reduced to what a payment touches.
    CREATE TYPE public.invoice_status AS ENUM ('draft','sent','partial','paid','disputed','written_off');
    CREATE TABLE public.invoices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      location_id uuid NOT NULL,
      invoice_number text NOT NULL,
      billed_amount numeric(12,2) NOT NULL DEFAULT 0,
      collected_amount numeric(12,2) NOT NULL DEFAULT 0,
      status public.invoice_status NOT NULL DEFAULT 'sent',
      created_by uuid
    );
    ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
    CREATE POLICY invoices_select ON public.invoices FOR SELECT TO authenticated
      USING (public.can_view_location(auth.uid(), location_id) OR created_by = auth.uid());
    GRANT SELECT ON public.invoices TO authenticated;

    INSERT INTO auth.users VALUES ('${manager}'), ('${rep}'), ('${stranger}');
    INSERT INTO public.location_members VALUES
      ('${manager}', '${officeA}', true), ('${rep}', '${officeA}', false),
      ('${stranger}', '${officeB}', true);
  `);

  // The table, its grants, RLS, policies and rollup, verbatim from the
  // migration that created them; then the rollup as it stands today, and the
  // payment trail.
  const base = migration("20260731003140_56cc0268-7389-44fb-8528-cdefb08d6dbd.sql");
  const start = base.indexOf("-- ---------------- invoice payments ----------------");
  const end = base.indexOf("-- Documents and signatures");
  check(start > 0 && end > start, "found the invoice_payments section of 20260731003140");
  await db.exec(base.slice(start, base.lastIndexOf("-- ====", end)));

  const fix = migration("20260806182105_caaf4b83-8761-427d-be77-434e1ef5d0d2.sql");
  const rollup = fix.match(
    /CREATE OR REPLACE FUNCTION public\.tg_invoice_payment_rollup\(\)[\s\S]*?\$function\$;/,
  );
  check(!!rollup, "found the current rollup in 20260806182105");
  await db.exec(rollup[0]);
  await db.exec(migration("20260927121000_invoice_payment_audit.sql"));

  const invoice = async (number, billed, createdBy, office = officeA) =>
    (
      await db.query(
        `INSERT INTO public.invoices (location_id, invoice_number, billed_amount, created_by)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [office, number, billed, createdBy],
      )
    ).rows[0].id;
  const state = async (id) =>
    (
      await db.query(
        `SELECT collected_amount::text AS collected, status::text AS status FROM public.invoices WHERE id = $1`,
        [id],
      )
    ).rows[0];
  const paymentCount = async () =>
    Number((await db.query(`SELECT count(*)::int AS n FROM public.invoice_payments`)).rows[0].n);
  const trail = async () =>
    (
      await db.query(
        `SELECT action, invoice_id FROM public.invoice_payment_changes ORDER BY created_at`,
      )
    ).rows;

  const mitigation = await invoice("GS-INV-1022", 1000, rep);
  const rebuild = await invoice("GS-INV-3488", 2500, manager);
  const elsewhere = await invoice("GS-INV-9001", 700, stranger, officeB);

  // 1 + 3 + 4. A manager splits one check across both invoices.
  const saved = await bulkInsert(manager, [
    row(mitigation, 1000, manager),
    row(rebuild, 1500, manager),
  ]);
  check(saved.rows.length === 2, "one insert writes one row per ticked invoice");
  const s1 = await state(mitigation);
  const s2 = await state(rebuild);
  check(s1.collected === "1000.00" && s1.status === "paid", "rollup: the first invoice is paid");
  check(
    s2.collected === "1500.00" && s2.status === "partial",
    "rollup: the second invoice is part paid",
  );
  check(
    saved.rows[0].created_at === saved.rows[1].created_at,
    "the rows of one split share created_at",
  );
  check(
    saved.rows.every((r) => r.created_by === manager),
    "the rows of one split share created_by",
  );
  check((await trail()).length === 0, "recording writes no correction trail (it never did)");

  const later = await bulkInsert(manager, [row(rebuild, 100, manager, "104883")]);
  check(
    later.rows[0].created_at !== saved.rows[0].created_at,
    "a separate save does not look like part of the split",
  );

  // 1 + 2. A split including an invoice the caller may not write is refused
  // whole: nothing lands on the invoice they could write either.
  const before = await paymentCount();
  await rejects(
    bulkInsert(rep, [row(mitigation, 10, rep), row(rebuild, 10, rep)]),
    /row-level security/,
    "the rep (creator of 1022 only) cannot split onto 3488",
  );
  check((await paymentCount()) === before, "all or none: no row of the refused split was kept");
  check((await state(mitigation)).collected === "1000.00", "all or none: 1022 did not move");

  const own = await bulkInsert(rep, [row(mitigation, 25, rep)]);
  check(own.rows.length === 1, "the invoice's creator may record on their own invoice");

  await rejects(
    bulkInsert(stranger, [row(elsewhere, 50, stranger), row(rebuild, 50, stranger)]),
    /row-level security/,
    "a manager of another office cannot reach this office's invoice",
  );
  check(
    (await state(elsewhere)).collected === "0.00",
    "all or none: the other office's did not move",
  );

  await rejects(
    bulkInsert(manager, [
      row(mitigation, 10, manager),
      { ...row(rebuild, 10, manager), amount: null },
    ]),
    /null value|not-null/,
    "one bad row (no amount) refuses the whole split",
  );
  check((await state(mitigation)).collected === "1025.00", "all or none on a bad row too");

  // 5. Correcting one row of the split: the trail fires, only that invoice moves.
  await as(
    manager,
    `UPDATE public.invoice_payments SET amount = 1400, change_reason = 'typo' WHERE id = $1`,
    [saved.rows[1].id],
  );
  const t = await trail();
  check(
    t.length === 1 && t[0].action === "edit" && t[0].invoice_id === rebuild,
    "edit is in the trail",
  );
  check((await state(rebuild)).collected === "1500.00", "rollup follows the edit (1400 + 100)");
  check(
    (await state(mitigation)).collected === "1025.00",
    "the other half of the split is untouched",
  );
  await as(manager, `DELETE FROM public.invoice_payments WHERE id = $1`, [saved.rows[0].id]);
  const t2 = await trail();
  check(t2.length === 2 && t2[1].action === "remove", "removal is in the trail");
  check((await state(mitigation)).collected === "25.00", "rollup follows the removal");

  // Mutation: the same split sent one insert at a time — the loop the app
  // must never use — keeps the first row when the second is refused.
  const n0 = await paymentCount();
  await bulkInsert(rep, [row(mitigation, 5, rep)]);
  await rejects(
    bulkInsert(rep, [row(rebuild, 5, rep)]),
    /row-level security/,
    "mutation: the second single insert is refused",
  );
  check(
    (await paymentCount()) === n0 + 1,
    "mutation: one insert per row leaves a half-recorded payment",
  );

  console.log(`add-payment-split.pglite: ${assertions} assertions passed`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.close();
}
