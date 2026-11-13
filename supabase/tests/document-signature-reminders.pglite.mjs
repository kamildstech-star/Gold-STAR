// Run with: node supabase/tests/document-signature-reminders.pglite.mjs <existing PGlite dist/index.js>
// In-memory fixtures only. No connection string, network access or live writes.
//
// run_document_signature_reminders(): 20261007091000 records the body live
// runs (someone fixed it in the Lovable SQL editor) and takes EXECUTE away
// from authenticated. Both migrations are READ FROM THEIR FILES: the function
// and its grants as 20260818183217 wrote them, then the capture.
//
// What it proves:
//   1. the file version is broken -- it calls public.notify_user(), which no
//      migration creates -- so a replay without the capture fails on the
//      first due packet (the drift is real, not cosmetic);
//   2. after the capture, a due packet notifies its sender through the real
//      notifications columns (type 'record_stalled', href), with live's
//      wording, and its reminder clock moves;
//   3. packets that are signed, revoked, unsent, expired or reminded recently
//      are left alone, and a packet with no sender is still stamped;
//   4. a second run straight after reminds nobody;
//   5. authenticated, anon and PUBLIC cannot EXECUTE it; service_role can;
//      it stays SECURITY DEFINER with search_path pinned;
//   6. the capture runs twice without error.
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

const CAPTURE = "20261007091000_document_signature_reminders_live_body.sql";
const sender = "11111111-1111-4111-8111-111111111111";
const crew = "22222222-2222-4222-8222-222222222222";
const office = "33333333-3333-4333-8333-333333333333";
const job = "44444444-4444-4444-8444-444444444444";
const p = (n) => `00000000-0000-4000-8000-00000000000${n}`;

try {
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

    CREATE TYPE public.notification_type AS ENUM ('task_overdue', 'record_stalled', 'export_alert');
    CREATE TYPE public.notification_priority AS ENUM ('low', 'normal', 'high');
    -- notifications as live has it (information_schema, 2026-10-07).
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
      read_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      is_demo boolean NOT NULL DEFAULT false
    );
    CREATE TABLE public.jobs (id uuid PRIMARY KEY, job_number text);
    CREATE TABLE public.document_send_packets (
      id uuid PRIMARY KEY,
      location_id uuid NOT NULL,
      job_id uuid,
      recipient_email text,
      recipient_name text,
      reminder_days integer NOT NULL DEFAULT 3,
      last_reminder_at timestamptz,
      reminder_count integer NOT NULL DEFAULT 0,
      sent_at timestamptz,
      completed_at timestamptz,
      revoked_at timestamptz,
      expires_at timestamptz NOT NULL DEFAULT now() + interval '30 days',
      created_by uuid
    );
    INSERT INTO public.jobs VALUES ('${job}', '2026-0412');
  `);

  // 20260818183217's function and its two grant lines, exactly as written.
  const original = migration("20260818183217_0a6f0351-91c1-4a8a-933c-8c436fcfcf53.sql");
  const fileVersion =
    /CREATE OR REPLACE FUNCTION public\.run_document_signature_reminders\(\)[\s\S]*?FROM anon, PUBLIC;/.exec(
      original,
    )?.[0];
  assert.ok(fileVersion?.includes("notify_user"), "sliced the file version");
  await db.exec(fileVersion);

  const seed = async () => {
    await db.exec(`
      TRUNCATE public.notifications, public.document_send_packets;
      INSERT INTO public.document_send_packets
        (id, location_id, job_id, recipient_email, recipient_name, sent_at, last_reminder_at,
         completed_at, revoked_at, expires_at, created_by) VALUES
        -- due, on a job
        ('${p(1)}', '${office}', '${job}', 'pat@example.com', 'Pat Owner',
         now() - interval '4 days', NULL, NULL, NULL, now() + interval '20 days', '${sender}'),
        -- due, no job, no name
        ('${p(2)}', '${office}', NULL, 'lee@example.com', NULL,
         now() - interval '10 days', now() - interval '5 days', NULL, NULL, now() + interval '20 days', '${sender}'),
        -- due, nobody to tell
        ('${p(3)}', '${office}', NULL, 'x@example.com', NULL,
         now() - interval '4 days', NULL, NULL, NULL, now() + interval '20 days', NULL),
        -- signed
        ('${p(4)}', '${office}', NULL, 'a@example.com', NULL,
         now() - interval '4 days', NULL, now(), NULL, now() + interval '20 days', '${sender}'),
        -- revoked
        ('${p(5)}', '${office}', NULL, 'b@example.com', NULL,
         now() - interval '4 days', NULL, NULL, now(), now() + interval '20 days', '${sender}'),
        -- never sent
        ('${p(6)}', '${office}', NULL, 'c@example.com', NULL,
         NULL, NULL, NULL, NULL, now() + interval '20 days', '${sender}'),
        -- expired
        ('${p(7)}', '${office}', NULL, 'd@example.com', NULL,
         now() - interval '40 days', NULL, NULL, NULL, now() - interval '1 day', '${sender}'),
        -- reminded yesterday
        ('${p(8)}', '${office}', NULL, 'e@example.com', NULL,
         now() - interval '10 days', now() - interval '1 day', NULL, NULL, now() + interval '20 days', '${sender}');
    `);
  };

  /* 1: the file version cannot run */
  await seed();
  await refuses(
    db.query(`SELECT public.run_document_signature_reminders() AS n`),
    /notify_user/,
    "the version in 20260818183217 fails on the first due packet: notify_user does not exist",
  );

  /* 6: the capture, twice */
  await db.exec(migration(CAPTURE));
  await db.exec(migration(CAPTURE));
  check(true, "the capture runs twice without error");

  /* 2-3: behaviour */
  await seed();
  const n = (await db.query(`SELECT public.run_document_signature_reminders() AS n`)).rows[0].n;
  check(n === 3, "three packets were due");

  const notes = (
    await db.query(
      `SELECT user_id, type::text, title, body, entity_type, entity_id, href, priority::text
         FROM public.notifications ORDER BY entity_id`,
    )
  ).rows;
  check(notes.length === 2, "two notifications: the packet with no sender tells nobody");
  assert.deepEqual(notes[0], {
    user_id: sender,
    type: "record_stalled",
    title: "Unsigned documents",
    body: "Pat Owner has not signed job 2026-0412 yet. Send a reminder or call them.",
    entity_type: "document",
    entity_id: p(1),
    href: `/jobs/${job}`,
    priority: "normal",
  });
  assertions++;
  check(
    notes[1].body ===
      "lee@example.com has not signed the documents sent yet. Send a reminder or call them." &&
      notes[1].href === "/documents",
    "no job and no name: the email and /documents",
  );

  const clocks = (
    await db.query(
      `SELECT id, reminder_count, last_reminder_at > now() - interval '1 minute' AS stamped
         FROM public.document_send_packets ORDER BY id`,
    )
  ).rows;
  const stamped = clocks.filter((c) => c.stamped).map((c) => c.id);
  assert.deepEqual(stamped, [p(1), p(2), p(3)]);
  assertions++;
  check(
    clocks.filter((c) => c.reminder_count === 1).length === 3,
    "exactly the due packets have their reminder_count bumped",
  );

  /* 4: idempotent within the interval */
  const again = (await db.query(`SELECT public.run_document_signature_reminders() AS n`)).rows[0].n;
  check(again === 0, "a second run straight after reminds nobody");

  /* 5: who can run it */
  const priv = (
    await db.query(`
      SELECT has_function_privilege('authenticated', 'public.run_document_signature_reminders()', 'EXECUTE') AS auth,
             has_function_privilege('anon', 'public.run_document_signature_reminders()', 'EXECUTE') AS anon,
             has_function_privilege('service_role', 'public.run_document_signature_reminders()', 'EXECUTE') AS service,
             (SELECT proacl::text FROM pg_proc WHERE proname = 'run_document_signature_reminders') AS acl,
             (SELECT prosecdef FROM pg_proc WHERE proname = 'run_document_signature_reminders') AS definer,
             (SELECT proconfig::text FROM pg_proc WHERE proname = 'run_document_signature_reminders') AS config
    `)
  ).rows[0];
  check(!priv.auth, "authenticated cannot EXECUTE it (the flagged fix)");
  check(!priv.anon, "anon cannot EXECUTE it");
  check(!/(^|[{,])=X/.test(priv.acl), "PUBLIC cannot EXECUTE it");
  check(priv.service, "service_role keeps EXECUTE");
  check(
    priv.definer && priv.config === "{search_path=public}",
    "SECURITY DEFINER, search_path pinned",
  );

  await db.exec(
    `SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', '${crew}', false);`,
  );
  await refuses(
    db.query(`SELECT public.run_document_signature_reminders()`),
    /permission denied/,
    "a signed-in crew member cannot trigger the nightly sweep",
  );
  await db.exec(`RESET ROLE;`);

  console.log(`document-signature-reminders.pglite: ${assertions} assertions passed`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
