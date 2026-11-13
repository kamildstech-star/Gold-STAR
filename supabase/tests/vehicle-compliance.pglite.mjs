// Run with: node supabase/tests/vehicle-compliance.pglite.mjs <existing PGlite dist/index.js>
// In-memory fixtures only. No connection string, network access or live writes.
//
// Vehicle paperwork and maintenance: the row boundary, the documents, and the
// alerts. Mark: "add more boxes for insurance, registration, etc, with alerts
// for each vehicle to make sure nothing lapses". The migrations under test are
// READ FROM THE FILES, in order, never retyped here.
//
// What it proves:
//   1. the maintenance tables (20260928124000) and the new vehicle_documents
//      table answer the same question: an office's vans are seen by that
//      office (and corporate), written by its managers or fleet.manage, and
//      invisible to another office — on every verb;
//   2. the DOT inspection is now an allowed kind;
//   3. a document belongs to one thing — a due kind OR a record — its path
//      must start with its own van, and a receipt cannot point at another
//      van's record;
//   4. a renewed document supersedes the current one, which stays as history;
//   5. the vehicle-documents bucket asks can_view_vehicle to read and
//      can_manage_vehicle to write, and a malformed path is simply no access;
//   6. portal customers are denied by the restrictive policy;
//   7. run_vehicle_due_alerts(): an expired policy reaches the office manager
//      AND the owner, at high priority, worded "has expired"; an item in its
//      last week reaches only the manager; a viewer never hears; a rerun the
//      same day sends nothing new; signed-in users cannot run it.
//
// Dates are relative to current_date inside SQL, never a fixed day, so the
// fixture is right on any day it runs.
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

const manager = "11111111-1111-4111-8111-111111111111"; // manages office N
const viewer = "22222222-2222-4222-8222-222222222222"; // member of N, no manage
const stranger = "33333333-3333-4333-8333-333333333333"; // manages office S only
const owner = "44444444-4444-4444-8444-444444444444"; // owner role, in no office
const fleetMgr = "55555555-5555-4555-8555-555555555555"; // fleet.manage everywhere
const officeN = "66666666-6666-4666-8666-666666666666";
const officeS = "77777777-7777-4777-8777-777777777777";
const vanN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const vanS = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const vanLoose = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"; // no office yet

try {
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS;
    CREATE ROLE portal_customer;
    CREATE SCHEMA auth;
    CREATE SCHEMA storage;
    GRANT USAGE ON SCHEMA public, auth, storage TO anon, authenticated, service_role, portal_customer;

    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);

    CREATE TYPE public.notification_type AS ENUM ('task_due');
    CREATE TYPE public.notification_priority AS ENUM ('low', 'normal', 'high', 'urgent');
    CREATE TYPE public.app_role AS ENUM ('owner', 'admin', 'location_manager', 'field');

    CREATE TABLE public.notifications (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL,
      type public.notification_type NOT NULL,
      title text NOT NULL,
      body text,
      entity_type text,
      entity_id uuid,
      href text,
      priority public.notification_priority NOT NULL DEFAULT 'normal',
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE public.vehicles (
      id uuid PRIMARY KEY,
      label text NOT NULL,
      location_id uuid,
      is_demo boolean NOT NULL DEFAULT false
    );
    CREATE TABLE public.location_members (user_id uuid NOT NULL, location_id uuid NOT NULL);
    CREATE TABLE public.location_managers (user_id uuid NOT NULL, location_id uuid NOT NULL);
    CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
    CREATE TABLE public.user_perms (user_id uuid NOT NULL, perm text NOT NULL, location_id uuid);

    -- The access helpers, reduced to the rule each one encodes in production.
    CREATE FUNCTION public.is_privileged(_u uuid) RETURNS boolean LANGUAGE sql STABLE AS
      $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _u AND role IN ('owner','admin')) $$;
    CREATE FUNCTION public.has_permission(_u uuid, _perm text, _loc uuid) RETURNS boolean LANGUAGE sql STABLE AS
      $$ SELECT EXISTS (SELECT 1 FROM public.user_perms
                         WHERE user_id = _u AND perm = _perm
                           AND (location_id IS NULL OR location_id = _loc)) $$;
    CREATE FUNCTION public.can_view_location(_u uuid, _loc uuid) RETURNS boolean LANGUAGE sql STABLE AS
      $$ SELECT public.is_privileged(_u)
             OR EXISTS (SELECT 1 FROM public.location_members WHERE user_id = _u AND location_id = _loc) $$;
    CREATE FUNCTION public.can_manage_location(_u uuid, _loc uuid) RETURNS boolean LANGUAGE sql STABLE AS
      $$ SELECT public.is_privileged(_u)
             OR EXISTS (SELECT 1 FROM public.location_managers WHERE user_id = _u AND location_id = _loc) $$;
    CREATE FUNCTION public.tg_touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

    CREATE TABLE storage.buckets (
      id text PRIMARY KEY, name text, public boolean,
      file_size_limit bigint, allowed_mime_types text[]
    );
    CREATE TABLE storage.objects (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      bucket_id text NOT NULL,
      name text NOT NULL,
      owner uuid DEFAULT auth.uid()
    );
    ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
    GRANT SELECT, INSERT, DELETE ON storage.objects TO authenticated;

    INSERT INTO auth.users VALUES ('${manager}'), ('${viewer}'), ('${stranger}'), ('${owner}'), ('${fleetMgr}');
    INSERT INTO public.vehicles VALUES
      ('${vanN}', 'Van 12', '${officeN}', false),
      ('${vanS}', 'Box truck 3', '${officeS}', false),
      ('${vanLoose}', 'New van', NULL, false);
    INSERT INTO public.location_members VALUES
      ('${manager}', '${officeN}'), ('${viewer}', '${officeN}'), ('${stranger}', '${officeS}');
    INSERT INTO public.location_managers VALUES ('${manager}', '${officeN}'), ('${stranger}', '${officeS}');
    INSERT INTO public.user_roles VALUES ('${owner}', 'owner');
    INSERT INTO public.user_perms VALUES ('${fleetMgr}', 'fleet.manage', NULL), ('${fleetMgr}', 'fleet.view', NULL);
  `);

  /* ---- The migrations, verbatim, in order ----------------------------- */
  await db.exec(migration("20260928123000_notification_type_vehicle_due.sql"));
  await db.exec(migration("20260928124000_vehicle_maintenance.sql"));
  await db.exec(migration("20261005140000_vehicle_compliance_documents.sql"));
  // Re-runnable: applying it twice must not fail or double anything.
  await db.exec(migration("20261005140000_vehicle_compliance_documents.sql"));
  check(
    (
      await db.query(`SELECT count(*)::int AS n FROM pg_constraint
                      WHERE conrelid = 'public.vehicle_due_items'::regclass AND contype = 'c'
                        AND pg_get_constraintdef(oid) ~ '\\mkind\\M'`)
    ).rows[0].n === 1,
    "exactly one kind check on vehicle_due_items after two runs",
  );

  /** Run one statement as a signed-in user; never leaves the role set. */
  const as = async (uid, sql, role = "authenticated") => {
    await db.exec(`SET ROLE ${role}; SET request.jwt.claim.sub = '${uid}'`);
    try {
      return await db.query(sql);
    } finally {
      await db.exec("RESET ROLE; SELECT set_config('request.jwt.claim.sub','',false)");
    }
  };
  const count = async (uid, table, where = "true") =>
    (await as(uid, `SELECT count(*)::int AS n FROM public.${table} WHERE ${where}`)).rows[0].n;

  /* ---- 1 & 2: due items, DOT inspection, the office boundary ---------- */
  await as(
    manager,
    `INSERT INTO public.vehicle_due_items (vehicle_id, kind, due_on, reference, provider)
                     VALUES ('${vanN}', 'insurance', current_date - 3, 'POL-1', 'Progressive'),
                            ('${vanN}', 'registration', current_date + 5, 'XJ-123', 'NJ MVC'),
                            ('${vanN}', 'dot_inspection', current_date + 200, NULL, NULL)`,
  );
  check(
    (await count(manager, "vehicle_due_items")) === 3,
    "the manager files three dates, DOT included",
  );
  check((await count(viewer, "vehicle_due_items")) === 3, "an office member sees them");
  check((await count(stranger, "vehicle_due_items")) === 0, "another office sees none of them");
  check((await count(owner, "vehicle_due_items")) === 3, "corporate sees across offices");

  await refuses(
    as(
      viewer,
      `INSERT INTO public.vehicle_due_items (vehicle_id, kind, due_on)
                VALUES ('${vanN}', 'inspection', current_date + 90)`,
    ),
    /row-level security/i,
    "a member who cannot manage the office cannot add a date",
  );
  await refuses(
    as(
      stranger,
      `INSERT INTO public.vehicle_due_items (vehicle_id, kind, due_on)
                  VALUES ('${vanN}', 'inspection', current_date + 90)`,
    ),
    /row-level security/i,
    "another office's manager cannot add a date to this van",
  );
  check(
    (await as(stranger, `UPDATE public.vehicle_due_items SET due_on = current_date + 400`))
      .affectedRows === 0,
    "another office's manager updates nothing",
  );
  check(
    (await as(viewer, `DELETE FROM public.vehicle_due_items`)).affectedRows === 0,
    "a viewer deletes nothing",
  );
  await refuses(
    as(
      manager,
      `INSERT INTO public.vehicle_due_items (vehicle_id, kind, due_on)
                 VALUES ('${vanN}', 'ifta', current_date + 90)`,
    ),
    /check constraint/i,
    "an unknown kind is still refused",
  );
  await refuses(
    as(
      manager,
      `INSERT INTO public.vehicle_maintenance_records (vehicle_id, performed_on, kind)
                 VALUES ('${vanN}', current_date, 'detailing')`,
    ),
    /check constraint/i,
    "an unknown record kind is refused",
  );

  // A van with no office: fleet.manage or corporate only.
  await as(
    fleetMgr,
    `INSERT INTO public.vehicle_due_items (vehicle_id, kind, due_on)
                      VALUES ('${vanLoose}', 'registration', current_date + 100)`,
  );
  check(
    (await count(manager, "vehicle_due_items", `vehicle_id = '${vanLoose}'`)) === 0,
    "an office manager does not see a van with no office",
  );
  check(
    (await count(owner, "vehicle_due_items", `vehicle_id = '${vanLoose}'`)) === 1,
    "the owner does",
  );

  /* ---- 3: records and documents --------------------------------------- */
  const recN = (
    await as(
      manager,
      `INSERT INTO public.vehicle_maintenance_records
                                     (vehicle_id, performed_on, kind, odometer, cost, vendor)
                                   VALUES ('${vanN}', current_date, 'dot_inspection', 41250, 89.50, 'Route 1 Truck')
                                   RETURNING id`,
    )
  ).rows[0].id;
  const recS = (
    await as(
      stranger,
      `INSERT INTO public.vehicle_maintenance_records
                                      (vehicle_id, performed_on, kind)
                                    VALUES ('${vanS}', current_date, 'brakes') RETURNING id`,
    )
  ).rows[0].id;
  check(
    Boolean(recN) && Boolean(recS),
    "each manager logs work on their own van, DOT inspection included",
  );

  const doc = (van, kind, rec, name) =>
    `INSERT INTO public.vehicle_documents (vehicle_id, due_kind, maintenance_record_id, storage_path, file_name)
     VALUES ('${van}', ${kind ? `'${kind}'` : "NULL"}, ${rec ? `'${rec}'` : "NULL"},
             '${van}/${kind ?? "receipts"}/${name}', '${name}')`;

  await as(manager, doc(vanN, "insurance", null, "1-card.pdf"));
  await as(manager, doc(vanN, null, recN, "2-receipt.jpg"));
  check(
    (await count(manager, "vehicle_documents")) === 2,
    "the manager files a card and a receipt",
  );
  check((await count(viewer, "vehicle_documents")) === 2, "an office member sees both");
  check((await count(stranger, "vehicle_documents")) === 0, "another office sees neither");
  check((await count(owner, "vehicle_documents")) === 2, "corporate sees both");
  check(
    (
      await db.query(
        `SELECT uploaded_by FROM public.vehicle_documents WHERE file_name = '1-card.pdf'`,
      )
    ).rows[0].uploaded_by === manager,
    "uploaded_by defaults to the caller",
  );

  await refuses(
    as(viewer, doc(vanN, "registration", null, "x.pdf")),
    /row-level security/i,
    "a viewer cannot attach a document",
  );
  await refuses(
    as(stranger, doc(vanN, "registration", null, "y.pdf")),
    /row-level security/i,
    "another office cannot attach to this van",
  );
  check(
    (await as(stranger, `DELETE FROM public.vehicle_documents`)).affectedRows === 0,
    "another office deletes no document",
  );
  check(
    (await as(viewer, `UPDATE public.vehicle_documents SET file_name = 'z'`)).affectedRows === 0,
    "a viewer renames nothing",
  );

  await refuses(
    as(
      manager,
      `INSERT INTO public.vehicle_documents (vehicle_id, due_kind, storage_path, file_name)
                 VALUES ('${vanN}', 'insurance', '${vanS}/insurance/steal.pdf', 'steal.pdf')`,
    ),
    /vehicle_documents_path_is_the_vehicles/,
    "a row cannot point at a file under another van",
  );
  await refuses(
    as(
      manager,
      `INSERT INTO public.vehicle_documents (vehicle_id, due_kind, maintenance_record_id, storage_path, file_name)
                 VALUES ('${vanN}', 'insurance', '${recN}', '${vanN}/insurance/both.pdf', 'both.pdf')`,
    ),
    /vehicle_documents_one_owner/,
    "a document is evidence of one thing, not two",
  );
  await refuses(
    as(
      manager,
      `INSERT INTO public.vehicle_documents (vehicle_id, storage_path, file_name)
                 VALUES ('${vanN}', '${vanN}/receipts/none.pdf', 'none.pdf')`,
    ),
    /vehicle_documents_one_owner/,
    "a document must be evidence of something",
  );
  await refuses(
    db.query(`INSERT INTO public.vehicle_documents (vehicle_id, maintenance_record_id, storage_path, file_name)
              VALUES ('${vanN}', '${recS}', '${vanN}/receipts/cross.pdf', 'cross.pdf')`),
    /vehicle_documents_record_same_vehicle/,
    "a receipt cannot point at another van's record, even past RLS",
  );

  /* ---- 4: supersede ---------------------------------------------------- */
  await as(manager, doc(vanN, "insurance", null, "3-renewed.pdf"));
  const cards = (
    await as(
      manager,
      `SELECT file_name, is_current, superseded_at IS NOT NULL AS gone
                         FROM public.vehicle_documents WHERE due_kind = 'insurance' ORDER BY file_name`,
    )
  ).rows;
  check(cards.length === 2, "the old card is kept");
  check(
    cards[0].file_name === "1-card.pdf" && !cards[0].is_current && cards[0].gone,
    "the old card is superseded, with a timestamp",
  );
  check(cards[1].file_name === "3-renewed.pdf" && cards[1].is_current, "the renewal is current");
  await refuses(
    db.query(
      `UPDATE public.vehicle_documents SET is_current = true WHERE file_name = '1-card.pdf'`,
    ),
    /vehicle_documents_one_current/,
    "two current cards for one van and kind is impossible",
  );

  // Cascades: the record takes its receipt; the van takes everything.
  await as(manager, `DELETE FROM public.vehicle_maintenance_records WHERE id = '${recN}'`);
  check(
    (
      await db.query(`SELECT count(*)::int AS n FROM public.vehicle_documents
                          WHERE file_name = '2-receipt.jpg'`)
    ).rows[0].n === 0,
    "deleting a record deletes its receipt row",
  );

  /* ---- 5: the bucket --------------------------------------------------- */
  const bucket = (
    await db.query(`SELECT public FROM storage.buckets WHERE id = 'vehicle-documents'`)
  ).rows;
  check(bucket.length === 1 && bucket[0].public === false, "the bucket exists and is private");

  const obj = (name) =>
    `INSERT INTO storage.objects (bucket_id, name) VALUES ('vehicle-documents', '${name}')`;
  await as(manager, obj(`${vanN}/insurance/3-renewed.pdf`));
  await refuses(
    as(viewer, obj(`${vanN}/insurance/v.pdf`)),
    /row-level security/i,
    "a viewer cannot upload",
  );
  await refuses(
    as(stranger, obj(`${vanN}/insurance/s.pdf`)),
    /row-level security/i,
    "another office cannot upload under this van",
  );
  await refuses(
    as(manager, obj(`not-a-uuid/insurance/m.pdf`)),
    /row-level security/i,
    "a path that does not start with a van is refused, not an error",
  );
  await as(stranger, obj(`${vanS}/receipts/brakes.pdf`));

  const visible = async (uid) =>
    (
      await as(
        uid,
        `SELECT count(*)::int AS n FROM storage.objects WHERE bucket_id = 'vehicle-documents'`,
      )
    ).rows[0].n;
  check((await visible(manager)) === 1, "the manager reads only their van's file");
  check((await visible(viewer)) === 1, "an office member reads it too");
  check((await visible(stranger)) === 1, "the other office reads only its own");
  check((await visible(owner)) === 2, "corporate reads both");
  check(
    (await as(viewer, `DELETE FROM storage.objects`)).affectedRows === 0,
    "a viewer deletes no file",
  );
  check(
    (await as(manager, `DELETE FROM storage.objects WHERE name LIKE '${vanN}/%'`)).affectedRows ===
      1,
    "the manager can remove their van's file",
  );

  /* ---- 6: portal customers -------------------------------------------- */
  const portal = (
    await db.query(`SELECT permissive FROM pg_policies
                     WHERE tablename = 'vehicle_documents' AND policyname = 'portal_customer_denied'`)
  ).rows;
  check(
    portal.length === 1 && portal[0].permissive === "RESTRICTIVE",
    "vehicle_documents carries the restrictive portal_customer_denied policy",
  );

  /* ---- 7: alerts ------------------------------------------------------- */
  await refuses(
    as(manager, `SELECT public.run_vehicle_due_alerts()`),
    /permission denied/i,
    "a signed-in user cannot run the sweep",
  );

  const sent = (await db.query(`SELECT public.run_vehicle_due_alerts() AS n`)).rows[0].n;
  check(sent > 0, "the sweep sends something");
  const notes = async (uid) =>
    (
      await db.query(`SELECT title, body, priority::text, entity_type, href FROM public.notifications
                      WHERE user_id = '${uid}' ORDER BY title`)
    ).rows;

  const mgr = await notes(manager);
  const lapsedIns = mgr.find((n) => n.title === "Van 12: Insurance has expired");
  check(
    Boolean(lapsedIns),
    "the manager is told the insurance has expired, in the credential wording",
  );
  check(lapsedIns.priority === "high", "an expired document is high priority");
  check(lapsedIns.entity_type === "vehicle_due:overdue", "deduped as the overdue stage");
  check(/\(3 days ago\)/.test(lapsedIns.body), "the body says how long ago");
  check(lapsedIns.href === `/fleet/${vanN}`, "and links to the van");
  const reg = mgr.find((n) => n.title === "Van 12: Registration expires in 5 days");
  check(
    Boolean(reg) && reg.priority === "normal" && reg.entity_type === "vehicle_due:week",
    "a registration in its last week is a normal 'expires in' alert",
  );
  check(!mgr.some((n) => /DOT/.test(n.title)), "a DOT inspection 200 days out says nothing");

  const own = await notes(owner);
  check(
    own.some((n) => n.title === "Van 12: Insurance has expired"),
    "an expired document also reaches the owner, who is in no office",
  );
  check(
    !own.some((n) => /Registration expires in 5 days/.test(n.title)),
    "but a document still in force does not",
  );
  check((await notes(viewer)).length === 0, "a member who cannot manage the office hears nothing");
  check((await notes(stranger)).length === 0, "another office hears nothing about this van");

  check(
    (await db.query(`SELECT public.run_vehicle_due_alerts() AS n`)).rows[0].n === 0,
    "a second run the same day sends nothing new",
  );

  // The kind is named properly, not initcap('dot_inspection').
  await db.query(
    `UPDATE public.vehicle_due_items SET due_on = current_date - 1 WHERE kind = 'dot_inspection'`,
  );
  await db.query(`SELECT public.run_vehicle_due_alerts()`);
  check(
    (await notes(manager)).some((n) => n.title === "Van 12: DOT inspection has expired"),
    "the DOT inspection reads 'DOT inspection'",
  );

  // Service keeps its own wording: late, not lapsed — and stays with the office.
  await db.query(`INSERT INTO public.vehicle_due_items (vehicle_id, kind, due_on)
                  VALUES ('${vanN}', 'service', current_date - 2)`);
  await db.query(`SELECT public.run_vehicle_due_alerts()`);
  check(
    (await notes(manager)).some((n) => n.title === "Van 12: Service overdue by 2 days"),
    "an overdue service reads 'overdue by'",
  );
  check(
    !(await notes(owner)).some((n) => /Service/.test(n.title)),
    "an overdue service is the office's to handle, not the owner's",
  );

  console.log(`vehicle-compliance.pglite: ${assertions} assertions passed`);
} finally {
  await db.close();
}
