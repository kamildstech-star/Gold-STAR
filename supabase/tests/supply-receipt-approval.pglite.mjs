// Run with: node supabase/tests/supply-receipt-approval.pglite.mjs <existing PGlite dist/index.js>
// In-memory fixtures only. No connection string, network access or live writes.
//
// The receipt approval gate. Mark, 5 Oct: "Need area for crews to upload
// purchase receipts. It should probably be tied to purchasing, AI to read the
// items and need to get approved just to add to purchase tracking."
//
// An approval that only the browser enforces is decoration: anybody can call
// the API the button calls. So this proves the gate where it lives, in the
// database, against the REAL migrations read from disk (never retyped):
//
//   20260918090000  supply_purchases and its finance/manager write policy
//   20260918180000  supply_receipts
//   20260925132000  a receipt pinned to an order
//   20261005173000  the approval gate under test
//
// What it proves:
//   1. crew can upload their own receipt and save the AI's draft onto it —
//      and cannot file one born approved, in someone else's name, or against
//      a job in another office;
//   2. crew cannot approve at all — their own receipt or anybody's;
//   3. crew cannot write purchase tracking directly, with or without a
//      receipt id;
//   4. an uploader can never approve or reject their own receipt, even a
//      manager with full authority over that office;
//   5. nobody signed in can change a receipt's status directly, or write /
//      edit a purchase row that names a receipt — approve_supply_receipt is
//      the only way in, while hand-typed purchases still work as before;
//   6. an authorised approver (a colleague in the office, or finance) can
//      approve, and what lands in purchase tracking is the approver's
//      corrected lines, tagged with the receipt, in one transaction; the
//      uploader is notified; a second approval is refused;
//   7. a manager of a different office cannot approve;
//   8. rejecting needs a reason, the uploader can read it, and is notified;
//   9. an approved receipt cannot be deleted; a pending one can be by its
//      uploader; legacy 'reviewed' rows become 'approved'; anon has no
//      execute on any of it.
//
// Surrounding tables (locations, jobs, supply_items, supply_requests,
// accounts, app_settings, notifications) are stubs with the columns the
// migrations touch. can_view_finance and can_manage_location are stubbed over
// a roles table with production's role lists; auth.uid() reads a session
// setting, the way the other fixtures here do it.
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
const eq = (actual, expected, what) => {
  assert.equal(actual, expected, `${what} (got ${actual}, wanted ${expected})`);
  assertions++;
};
const refused = async (promise, pattern, what) => {
  await assert.rejects(promise, pattern, what);
  assertions++;
};

const crew = "11111111-1111-4111-8111-111111111111";
const crew2 = "12121212-1212-4121-8121-121212121212";
const manager = "22222222-2222-4222-8222-222222222222";
const manager2 = "23232323-2323-4232-8232-232323232323";
const otherManager = "33333333-3333-4333-8333-333333333333";
const finance = "44444444-4444-4444-8444-444444444444";
const office = "66666666-6666-4666-8666-666666666666";
const otherOffice = "77777777-7777-4777-8777-777777777777";
const job = "88888888-8888-4888-8888-888888888888";
const otherJob = "89898989-8989-4898-8898-898989898989";
const legacy = "aaaaaaaa-0000-4000-8000-000000000001";

try {
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;

    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);

    CREATE TABLE public.locations (id uuid PRIMARY KEY);
    CREATE TABLE public.accounts (id uuid PRIMARY KEY);
    CREATE TABLE public.jobs (id uuid PRIMARY KEY, location_id uuid NOT NULL);
    CREATE TABLE public.supply_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);
    CREATE TABLE public.supply_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      location_id uuid,
      requester_id uuid
    );
    CREATE TABLE public.app_settings (key text PRIMARY KEY, value jsonb);
    CREATE TYPE public.notification_type AS ENUM ('supply_status', 'lead_approval');
    CREATE TABLE public.notifications (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL,
      type public.notification_type NOT NULL,
      title text NOT NULL,
      body text,
      entity_type text,
      entity_id uuid,
      href text
    );

    -- Production's access helpers, over a roles table: can_view_finance is
    -- owner/admin/sales_head/dev; can_manage_location is privileged, or a
    -- member of the office holding office/location_manager/sales_manager.
    CREATE TABLE public.user_roles (user_id uuid, role text);
    CREATE TABLE public.location_members (user_id uuid, location_id uuid);
    CREATE FUNCTION public.can_view_finance(_user_id uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
        SELECT EXISTS (SELECT 1 FROM public.user_roles
                       WHERE user_id = _user_id AND role IN ('owner','admin','sales_head','dev'));
      $$;
    CREATE FUNCTION public.can_manage_location(_user_id uuid, _location_id uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
        SELECT _location_id IS NOT NULL AND (
          EXISTS (SELECT 1 FROM public.user_roles
                  WHERE user_id = _user_id AND role IN ('owner','admin','dev'))
          OR (EXISTS (SELECT 1 FROM public.location_members
                      WHERE user_id = _user_id AND location_id = _location_id)
              AND EXISTS (SELECT 1 FROM public.user_roles
                          WHERE user_id = _user_id
                            AND role IN ('office','location_manager','sales_manager'))));
      $$;

    GRANT SELECT ON public.jobs, public.supply_requests, public.locations TO authenticated;

    INSERT INTO auth.users VALUES
      ('${crew}'), ('${crew2}'), ('${manager}'), ('${manager2}'), ('${otherManager}'), ('${finance}');
    INSERT INTO public.locations VALUES ('${office}'), ('${otherOffice}');
    INSERT INTO public.jobs VALUES ('${job}', '${office}'), ('${otherJob}', '${otherOffice}');
    INSERT INTO public.user_roles VALUES
      ('${crew}', 'crew'), ('${crew2}', 'crew'),
      ('${manager}', 'location_manager'), ('${manager2}', 'office'),
      ('${otherManager}', 'location_manager'), ('${finance}', 'sales_head');
    INSERT INTO public.location_members VALUES
      ('${crew}', '${office}'), ('${crew2}', '${office}'),
      ('${manager}', '${office}'), ('${manager2}', '${office}'),
      ('${otherManager}', '${otherOffice}');
  `);

  /* ---- The migrations, verbatim, in order ----------------------------- */
  await db.exec(migration("20260918090000_supply_inventory_and_purchasing.sql"));
  await db.exec(migration("20260918180000_supply_receipts.sql"));
  await db.exec(migration("20260925132000_supply_receipts_on_orders.sql"));

  // A receipt confirmed under the old flow, before this change existed.
  await db.exec(`
    INSERT INTO public.supply_receipts (id, location_id, uploaded_by, storage_bucket, storage_path, status)
    VALUES ('${legacy}', '${office}', '${crew}', 'documents', 'supply-receipts/old.webp', 'reviewed');
  `);

  await db.exec(migration("20261005173000_supply_receipt_approval.sql"));

  /** Run one statement as a signed-in user; never leaves the role set. */
  const as = async (uid, sql) => {
    await db.exec(`SET ROLE authenticated; SET request.jwt.claim.sub = '${uid}'`);
    try {
      return await db.query(sql);
    } finally {
      await db.exec("RESET ROLE; SELECT set_config('request.jwt.claim.sub','',false)");
    }
  };
  const one = async (sql) => (await db.query(sql)).rows[0];
  const purchases = async (where = "true") =>
    (await one(`SELECT count(*)::int AS n FROM public.supply_purchases WHERE ${where}`)).n;
  const notes = async (uid) =>
    (
      await db.query(
        `SELECT title, body, href FROM public.notifications WHERE user_id = '${uid}' ORDER BY title`,
      )
    ).rows;

  /** Upload a receipt as `uid`, the way uploadSupplyReceipt inserts it. */
  const upload = async (uid, id, extra = "") =>
    as(
      uid,
      `INSERT INTO public.supply_receipts (id, location_id, uploaded_by, storage_bucket, storage_path, status${extra ? ", job_id" : ""})
       VALUES ('${id}', '${office}', '${uid}', 'documents', 'supply-receipts/${id}.webp', 'uploaded'${extra ? `, '${extra}'` : ""})`,
    );

  const lines = (arr) => `'${JSON.stringify(arr)}'::jsonb`;
  const approve = (uid, id, supplier, linesSql, date = "current_date") =>
    as(
      uid,
      `SELECT public.approve_supply_receipt('${id}', ${supplier}, ${date}, ${linesSql}) AS n`,
    );

  /* ---- 9 (first): the legacy word is migrated, not kept ---------------- */
  eq(
    (await one(`SELECT status FROM public.supply_receipts WHERE id = '${legacy}'`)).status,
    "approved",
    "a receipt confirmed under the old flow reads as approved",
  );
  await refused(
    db.query(`UPDATE public.supply_receipts SET status = 'reviewed' WHERE id = '${legacy}'`),
    /supply_receipts_status_known/,
    "'reviewed' is no longer a status at all",
  );

  /* ---- 1: crew uploads, and saves the AI's draft ----------------------- */
  const crewReceipt = "c0000000-0000-4000-8000-000000000001";
  await upload(crew, crewReceipt, job);
  eq(
    (await one(`SELECT job_id FROM public.supply_receipts WHERE id = '${crewReceipt}'`)).job_id,
    job,
    "crew can upload a receipt against a job in their office",
  );

  const draft = {
    supplier: "Home Depot",
    purchasedOn: "2026-10-04",
    total: 48.72,
    lines: [
      { label: "Contractor bags", quantity: 2, unitPrice: 19.99, total: 39.98 },
      { label: "Duct tape", quantity: 1, unitPrice: 8.74, total: 8.74 },
    ],
  };
  eq(
    (
      await as(
        crew,
        `SELECT public.save_supply_receipt_draft('${crewReceipt}', ${lines(draft)}) AS s`,
      )
    ).rows[0].s,
    "uploaded",
    "the uploader can save the AI's draft onto their own receipt",
  );
  check(
    (
      await one(
        `SELECT parsed->>'supplier' AS s FROM public.supply_receipts WHERE id = '${crewReceipt}'`,
      )
    ).s === "Home Depot",
    "the draft is stored — before this change a crew member's draft matched no row",
  );

  await refused(
    as(
      crew,
      `INSERT INTO public.supply_receipts (location_id, uploaded_by, storage_bucket, storage_path, status)
       VALUES ('${office}', '${crew}', 'documents', 'x.webp', 'approved')`,
    ),
    /row-level security/i,
    "a receipt cannot be born approved",
  );
  await refused(
    as(
      crew,
      `INSERT INTO public.supply_receipts (location_id, uploaded_by, storage_bucket, storage_path, status, reviewed_by)
       VALUES ('${office}', '${crew}', 'documents', 'x.webp', 'uploaded', '${manager}')`,
    ),
    /row-level security/i,
    "a receipt cannot arrive carrying a reviewer's name",
  );
  await refused(
    as(
      crew,
      `INSERT INTO public.supply_receipts (location_id, uploaded_by, storage_bucket, storage_path, status)
       VALUES ('${office}', '${crew2}', 'documents', 'x.webp', 'uploaded')`,
    ),
    /row-level security/i,
    "a receipt cannot be filed in somebody else's name",
  );
  await refused(
    as(
      crew,
      `INSERT INTO public.supply_receipts (location_id, uploaded_by, storage_bucket, storage_path, status, job_id)
       VALUES ('${office}', '${crew}', 'documents', 'x.webp', 'uploaded', '${otherJob}')`,
    ),
    /row-level security/i,
    "a receipt cannot be filed against a job in another office",
  );

  const crew2Receipt = "c0000000-0000-4000-8000-000000000002";
  await upload(crew2, crew2Receipt);
  await refused(
    as(crew, `SELECT public.save_supply_receipt_draft('${crew2Receipt}', ${lines(draft)})`),
    /Only the person who uploaded/,
    "crew cannot overwrite a colleague's draft",
  );

  /* ---- 2: crew cannot approve at all ----------------------------------- */
  const goodLines = lines([
    { label: "Contractor bags", quantity: 2, unit_price: 19.99, total: null },
  ]);
  await refused(
    approve(crew, crewReceipt, "'Home Depot'", goodLines),
    /Only finance or a manager/,
    "crew cannot approve their own receipt",
  );
  await refused(
    approve(crew, crew2Receipt, "'Home Depot'", goodLines),
    /Only finance or a manager/,
    "crew cannot approve a colleague's receipt either",
  );
  await refused(
    as(crew, `SELECT public.reject_supply_receipt('${crew2Receipt}', 'nope')`),
    /Only finance or a manager/,
    "crew cannot reject",
  );
  await refused(
    as(crew, `UPDATE public.supply_receipts SET status = 'approved' WHERE id = '${crewReceipt}'`),
    /permission denied/i,
    "crew cannot flip a receipt's status directly",
  );
  eq(
    (await one(`SELECT status FROM public.supply_receipts WHERE id = '${crewReceipt}'`)).status,
    "uploaded",
    "after all that, the crew receipt is still waiting",
  );

  /* ---- 3: crew cannot write purchase tracking directly ----------------- */
  await refused(
    as(
      crew,
      `INSERT INTO public.supply_purchases (location_id, item_label, supplier_name, quantity, unit_price, total_cost)
       VALUES ('${office}', 'Bags', 'Home Depot', 1, 10, 10)`,
    ),
    /row-level security/i,
    "crew cannot insert a purchase by hand",
  );
  await refused(
    as(
      crew,
      `INSERT INTO public.supply_purchases (location_id, item_label, supplier_name, quantity, unit_price, total_cost, receipt_id)
       VALUES ('${office}', 'Bags', 'Home Depot', 1, 10, 10, '${crewReceipt}')`,
    ),
    /row-level security/i,
    "crew cannot insert a purchase that claims to come from their receipt",
  );
  eq(await purchases(), 0, "purchase tracking is still empty");

  /* ---- 4: an uploader never decides their own receipt ------------------ */
  const managerReceipt = "c0000000-0000-4000-8000-000000000003";
  await upload(manager, managerReceipt);
  await refused(
    approve(manager, managerReceipt, "'Home Depot'", goodLines),
    /You uploaded this receipt/,
    "a manager with full authority over the office still cannot approve their own receipt",
  );
  await refused(
    as(manager, `SELECT public.reject_supply_receipt('${managerReceipt}', 'withdrawing')`),
    /You uploaded this receipt/,
    "nor reject it",
  );

  /* ---- 5: approve_supply_receipt is the only door ---------------------- */
  await refused(
    as(
      manager,
      `UPDATE public.supply_receipts SET status = 'approved' WHERE id = '${managerReceipt}'`,
    ),
    /permission denied/i,
    "a manager cannot mark a receipt approved directly — the old Confirm path is closed",
  );
  await refused(
    as(
      manager,
      `INSERT INTO public.supply_purchases (location_id, item_label, supplier_name, quantity, unit_price, total_cost, receipt_id)
       VALUES ('${office}', 'Bags', 'Home Depot', 1, 10, 10, '${managerReceipt}')`,
    ),
    /row-level security/i,
    "a manager cannot write a purchase line against a receipt directly",
  );
  await as(
    manager,
    `INSERT INTO public.supply_purchases (location_id, item_label, supplier_name, quantity, unit_price, total_cost)
     VALUES ('${office}', 'Gloves', 'Grainger', 4, 5, 20)`,
  );
  eq(await purchases("receipt_id IS NULL"), 1, "a hand-typed purchase still works for a manager");
  const manual = await as(
    manager,
    `UPDATE public.supply_purchases SET receipt_id = '${managerReceipt}' WHERE item_label = 'Gloves'`,
  ).catch((e) => e);
  check(
    manual instanceof Error && /row-level security/i.test(manual.message),
    "a hand-typed purchase cannot be re-pointed at a receipt afterwards",
  );

  /* ---- 6: an authorised approver can, through the function ------------- */
  // The approver corrects the AI: the bags were 3, not 2, and the tape line
  // was misread as 8.74 when it was 7.48. What lands is what they confirmed.
  const corrected = lines([
    { label: "Contractor bags", quantity: 3, unit_price: 19.99, total: null },
    { label: "Duct tape", quantity: 1, unit_price: 7.48, total: 7.48 },
  ]);
  eq(
    (await approve(manager, crewReceipt, "'Home Depot #4410'", corrected, "'2026-10-04'::date"))
      .rows[0].n,
    2,
    "a manager of the office approves a crew member's receipt",
  );
  const written = (
    await db.query(
      `SELECT item_label, quantity::text, unit_price::text, total_cost::text, supplier_name,
              purchased_on::text, created_by, receipt_id, location_id
         FROM public.supply_purchases WHERE receipt_id = '${crewReceipt}' ORDER BY item_label`,
    )
  ).rows;
  eq(written.length, 2, "both confirmed lines are in purchase tracking");
  eq(written[0].quantity, "3.00", "the approver's corrected quantity, not the model's 2");
  eq(written[0].total_cost, "59.97", "a null total is quantity × unit price");
  eq(written[1].unit_price, "7.48", "the approver's corrected price, not the model's 8.74");
  eq(written[0].supplier_name, "Home Depot #4410", "the approver's supplier");
  eq(written[0].purchased_on, "2026-10-04", "the approver's date");
  eq(written[0].created_by, manager, "the purchase is recorded as entered by the approver");
  eq(written[0].location_id, office, "in the receipt's office");

  const after = await one(
    `SELECT status, reviewed_by, approved_lines, parsed FROM public.supply_receipts WHERE id = '${crewReceipt}'`,
  );
  eq(after.status, "approved", "the receipt is approved");
  eq(after.reviewed_by, manager, "and says who approved it");
  eq(Number(after.approved_lines.total), 67.45, "the confirmed total is kept on the receipt");
  eq(after.parsed.lines[0].quantity, 2, "the model's own draft is kept beside it, untouched");

  const told = await notes(crew);
  eq(told.length, 1, "the uploader is notified");
  eq(told[0].title, "Receipt approved", "that it was approved");
  check(/\$67\.45/.test(told[0].body), "with the confirmed total");
  eq(told[0].href, "/receipts", "and a link to their receipts");

  await refused(
    approve(manager2, crewReceipt, "'Home Depot'", goodLines),
    /already been approved/,
    "a second approval is refused — no double counting",
  );
  eq(await purchases(`receipt_id = '${crewReceipt}'`), 2, "still exactly two lines");

  eq(
    (
      await as(
        manager,
        `UPDATE public.supply_purchases SET quantity = 30 WHERE receipt_id = '${crewReceipt}'`,
      )
    ).affectedRows,
    0,
    "an approved line cannot be edited afterwards — the approved figures stick",
  );
  eq(
    (
      await one(
        `SELECT max(quantity)::text AS q FROM public.supply_purchases WHERE receipt_id = '${crewReceipt}'`,
      )
    ).q,
    "3.00",
    "the approved quantity is unchanged",
  );

  // A colleague approves the manager's own receipt; finance approves crew2's.
  eq(
    (await approve(manager2, managerReceipt, "'Lowes'", goodLines)).rows[0].n,
    1,
    "a colleague in the office can approve the manager's receipt",
  );
  await as(crew2, `SELECT public.save_supply_receipt_draft('${crew2Receipt}', NULL)`);
  eq(
    (await one(`SELECT status FROM public.supply_receipts WHERE id = '${crew2Receipt}'`)).status,
    "unreadable",
    "a read that found nothing marks the receipt unreadable",
  );

  /* ---- 7: another office's manager cannot ------------------------------ */
  await refused(
    approve(otherManager, crew2Receipt, "'Home Depot'", goodLines),
    /Only finance or a manager/,
    "a manager of a different office cannot approve",
  );

  eq(
    (await approve(finance, crew2Receipt, "'Home Depot'", goodLines)).rows[0].n,
    1,
    "finance approves an unreadable receipt from the lines they typed",
  );

  /* ---- validation and atomicity --------------------------------------- */
  const v = "c0000000-0000-4000-8000-000000000004";
  await upload(crew, v);
  await refused(
    approve(manager, v, "'X'", "'[]'::jsonb"),
    /at least one line/,
    "no lines, no approval",
  );
  await refused(approve(manager, v, "''", goodLines), /which supplier/, "a supplier is required");
  await refused(
    approve(manager, v, "'X'", goodLines, "NULL::date"),
    /what day/,
    "a purchase date is required",
  );
  await refused(
    approve(manager, v, "'X'", goodLines, "current_date + 30"),
    /does not look right/,
    "a date a month in the future is refused",
  );
  await refused(
    approve(manager, v, "'X'", lines([{ label: "Bags", quantity: 0, unit_price: 3 }])),
    /not possible/,
    "a zero quantity is refused",
  );
  await refused(
    approve(manager, v, "'X'", lines([{ label: "Bags", quantity: "two", unit_price: 3 }])),
    /needs a quantity and a unit price/,
    "a quantity that is not a number is refused",
  );
  const before = await purchases();
  await refused(
    approve(
      manager,
      v,
      "'X'",
      lines([
        { label: "Good line", quantity: 1, unit_price: 3 },
        { label: "", quantity: 1, unit_price: 3 },
      ]),
    ),
    /needs a description/,
    "a blank line is refused",
  );
  eq(await purchases(), before, "and the good line before it was rolled back with it");
  eq(
    (await one(`SELECT status FROM public.supply_receipts WHERE id = '${v}'`)).status,
    "uploaded",
    "the receipt is still waiting after a refused approval",
  );

  /* ---- 8: rejecting ---------------------------------------------------- */
  await refused(
    as(manager, `SELECT public.reject_supply_receipt('${v}', '   ')`),
    /Say why/,
    "a rejection needs a reason",
  );
  await as(
    manager,
    `SELECT public.reject_supply_receipt('${v}', 'Personal items — not company stock')`,
  );
  const seen = (
    await as(crew, `SELECT status, rejection_reason FROM public.supply_receipts WHERE id = '${v}'`)
  ).rows[0];
  eq(seen.status, "rejected", "the uploader sees it was rejected");
  eq(seen.rejection_reason, "Personal items — not company stock", "and why");
  check(
    (await notes(crew)).some(
      (n) => n.title === "Receipt not approved" && /Personal items/.test(n.body),
    ),
    "the uploader is notified of the rejection with the reason",
  );
  await refused(
    approve(manager2, v, "'X'", goodLines),
    /already been rejected/,
    "a rejected receipt cannot then be approved into spending",
  );
  await refused(
    as(crew, `SELECT public.save_supply_receipt_draft('${v}', ${lines(draft)})`),
    /already been rejected/,
    "nor its draft rewritten",
  );

  /* ---- 9: deletes and grants ------------------------------------------ */
  const del = await as(manager, `DELETE FROM public.supply_receipts WHERE id = '${crewReceipt}'`);
  eq(del.affectedRows, 0, "an approved receipt cannot be deleted, even by a manager");
  await refused(
    db.query(`DELETE FROM public.supply_receipts WHERE id = '${crewReceipt}'`),
    /foreign key/i,
    "and the purchase lines hold on to it even without RLS",
  );
  const pending = "c0000000-0000-4000-8000-000000000005";
  await upload(crew, pending);
  eq(
    (await as(crew2, `DELETE FROM public.supply_receipts WHERE id = '${pending}'`)).affectedRows,
    0,
    "a colleague cannot delete somebody's pending receipt",
  );
  eq(
    (await as(crew, `DELETE FROM public.supply_receipts WHERE id = '${pending}'`)).affectedRows,
    1,
    "the uploader can delete their own while it is still waiting — the wrong photo",
  );

  for (const sig of [
    "public.approve_supply_receipt(uuid,text,date,jsonb)",
    "public.reject_supply_receipt(uuid,text)",
    "public.save_supply_receipt_draft(uuid,jsonb)",
    "public.can_approve_supply_receipt(uuid,uuid)",
  ]) {
    check(
      (await one(`SELECT has_function_privilege('anon', '${sig}', 'EXECUTE') AS ok`)).ok === false,
      `anon cannot execute ${sig}`,
    );
    check(
      (await one(`SELECT has_function_privilege('authenticated', '${sig}', 'EXECUTE') AS ok`))
        .ok === true,
      `authenticated can execute ${sig} — the function checks the caller itself`,
    );
  }

  await db.exec("SET request.jwt.claim.sub = ''");
  await refused(
    db.query(
      `SELECT public.approve_supply_receipt('${managerReceipt}', 'X', current_date, ${goodLines})`,
    ),
    /Sign in/,
    "no session, no approval",
  );

  console.log(`supply-receipt-approval.pglite: ${assertions} assertions passed`);
} finally {
  await db.close();
}
