// Run with: node supabase/tests/email-transport-retry.pglite.mjs <existing PGlite dist/index.js>
// In-memory fixtures only. The migration under test is READ FROM THE FILE.
//
// What it proves about 20261012100000:
//   1. the backfill marks exactly the rows the old seam left stuck — released
//      by the sweep, or the two named — and not a bare 'queued' row an
//      assistant write, an automation or a vendor-order draft left;
//   2. the sweep's claim takes parked, due, young, under-attempted, unclaimed,
//      unsent rows only, oldest first, bounded, once (a second claim inside
//      ten minutes gets nothing; a lapsed claim is taken again);
//   3. so David's 11 Oct invoice is claimable and the 25 Aug work
//      authorization is not — until a person's Resend names it (_only_id),
//      which also restarts its attempts and can take a 'failed' row;
//   4. a signed-in writer can neither set nor change the transport columns,
//      nor edit a parked email's recipients or body; the service role can;
//   5. email_release_kick posts for a due parked row as well as a due held
//      one, and stays quiet for a row that is only waiting;
//   6. claim, kick and guard are closed to PUBLIC, anon and authenticated.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const FILE = "20261012100000_email_transport_retry.sql";
const migration = readFileSync(new URL("../migrations/" + FILE, import.meta.url), "utf8");

let assertions = 0;
const check = (value, what) => {
  assert.equal(value, true, what);
  assertions++;
};

const INVOICE = "7144b36a-1f57-4d81-b785-3d6d5a69d126";
const WORK_AUTH = "ba41fad0-e366-4bcd-b324-0e370aea6d96";
const DAVID = "1f37c3ff-c589-4c5c-8960-31e55e110368";

const FIXTURE = `
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
  CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
    AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;

  CREATE TYPE public.email_status AS ENUM
    ('queued','sent','delivered','opened','bounced','failed','held','cancelled');
  CREATE TABLE public.email_messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    status public.email_status NOT NULL DEFAULT 'queued',
    to_emails text[] NOT NULL DEFAULT '{}',
    cc_emails text[] NOT NULL DEFAULT '{}',
    subject text NOT NULL DEFAULT 's',
    body_html text NOT NULL DEFAULT 'b',
    attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
    sent_by uuid,
    sent_at timestamptz,
    provider_id text,
    release_at timestamptz,
    released_at timestamptz,
    supply_request_id uuid,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE public.app_settings (key text PRIMARY KEY, value jsonb NOT NULL);
  CREATE FUNCTION public.cron_secret() RETURNS text LANGUAGE sql AS $$ SELECT 'test-cron-secret' $$;

  CREATE SCHEMA net;
  CREATE TABLE net.calls (url text, headers jsonb, body jsonb);
  CREATE FUNCTION net.http_post(
    url text, body jsonb DEFAULT '{}'::jsonb, params jsonb DEFAULT '{}'::jsonb,
    headers jsonb DEFAULT '{"Content-Type": "application/json"}'::jsonb,
    timeout_milliseconds integer DEFAULT 5000
  ) RETURNS bigint LANGUAGE plpgsql AS $$
  BEGIN
    INSERT INTO net.calls VALUES (url, headers, body);
    RETURN 1;
  END $$;
`;

// The rows as they stand before the migration (production, 2026-10-11, plus
// the look-alikes that must NOT be touched).
const BEFORE = `
  INSERT INTO public.email_messages (id, status, sent_by, release_at, released_at, created_at) VALUES
    ('${INVOICE}', 'queued', '${DAVID}', now() - interval '14 hours 5 minutes',
       now() - interval '14 hours', now() - interval '14 hours 10 minutes'),
    ('${WORK_AUTH}', 'queued', '${DAVID}', NULL, NULL, now() - interval '48 days');
  INSERT INTO public.email_messages (id, status, sent_by, created_at, supply_request_id, sent_at, provider_id) VALUES
    ('00000000-0000-4000-8000-0000000000a1', 'queued', '${DAVID}', now() - interval '1 day', NULL, NULL, NULL),
    ('00000000-0000-4000-8000-0000000000a2', 'queued', NULL, now() - interval '1 day', NULL, NULL, NULL),
    ('00000000-0000-4000-8000-0000000000a3', 'queued', '${DAVID}', now() - interval '1 day',
       '00000000-0000-4000-8000-00000000ffff', NULL, NULL),
    ('00000000-0000-4000-8000-0000000000a4', 'sent', '${DAVID}', now() - interval '1 day', NULL, now(), 're_1');
`;

const db = new PGlite();
const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const ids = async (sql) => (await db.query(sql)).rows.map((r) => r.id).sort();
const asUser = (uid) => db.exec(`SELECT set_config('test.uid', '${uid}', false)`);
const asService = () => db.exec(`SELECT set_config('test.uid', '', false)`);

try {
  await db.exec(FIXTURE);
  await db.exec(BEFORE);
  await db.exec(migration);
  await db.exec(migration);
  check(true, "applies twice");

  /* ---- 1. backfill ------------------------------------------------- */
  const marked = await ids(
    `SELECT id FROM public.email_messages WHERE delivery_reason = 'no_transport'`,
  );
  check(
    JSON.stringify(marked) === JSON.stringify([INVOICE, WORK_AUTH].sort()),
    `backfill marks exactly the two stuck rows (got ${marked})`,
  );
  const attempts = await one(
    `SELECT bool_and(delivery_attempts = 0) AS zero FROM public.email_messages`,
  );
  check(attempts.zero === true, "every row starts at 0 attempts");

  /* ---- constraints -------------------------------------------------- */
  for (const [col, bad] of [
    ["provider", "gmail"],
    ["delivery_reason", "because"],
  ]) {
    let refused = false;
    try {
      await db.exec(`UPDATE public.email_messages SET ${col} = '${bad}' WHERE id = '${INVOICE}'`);
    } catch {
      refused = true;
    }
    check(refused, `${col} CHECK refuses '${bad}'`);
  }

  /* ---- 2/3. the sweep's claim -------------------------------------- */
  const claim1 = await ids(`SELECT id FROM public.claim_retryable_queued_emails(25)`);
  check(
    JSON.stringify(claim1) === JSON.stringify([INVOICE]),
    `sweep claims the 11 Oct invoice and not the 25 Aug work authorization (got ${claim1})`,
  );
  const claimedAt = await one(
    `SELECT claimed_at IS NOT NULL AS c FROM public.email_messages WHERE id = '${INVOICE}'`,
  );
  check(claimedAt.c === true, "the claim is stamped");
  const claim2 = await ids(`SELECT id FROM public.claim_retryable_queued_emails(25)`);
  check(claim2.length === 0, "a second claim inside ten minutes gets nothing");

  await db.exec(
    `UPDATE public.email_messages SET claimed_at = now() - interval '11 minutes' WHERE id = '${INVOICE}'`,
  );
  const claim3 = await ids(`SELECT id FROM public.claim_retryable_queued_emails(25)`);
  check(claim3.length === 1 && claim3[0] === INVOICE, "a lapsed claim is taken again");

  // Waiting on its sender: next look in five minutes.
  await db.exec(`UPDATE public.email_messages SET claimed_at = NULL,
                   next_attempt_at = now() + interval '5 minutes' WHERE id = '${INVOICE}'`);
  check(
    (await ids(`SELECT id FROM public.claim_retryable_queued_emails(25)`)).length === 0,
    "not due yet: not claimed",
  );
  await db.exec(`UPDATE public.email_messages SET next_attempt_at = now() - interval '1 second',
                   delivery_attempts = 6 WHERE id = '${INVOICE}'`);
  check(
    (await ids(`SELECT id FROM public.claim_retryable_queued_emails(25)`)).length === 0,
    "six attempts: never claimed by the sweep",
  );
  await db.exec(`UPDATE public.email_messages SET delivery_attempts = 0, sent_at = now()
                  WHERE id = '${INVOICE}'`);
  check(
    (await ids(`SELECT id FROM public.claim_retryable_queued_emails(25)`)).length === 0,
    "a row with sent_at is never claimed",
  );
  await db.exec(`UPDATE public.email_messages SET sent_at = NULL, claimed_at = NULL,
                   next_attempt_at = NULL WHERE id = '${INVOICE}'`);

  // Unparked look-alikes are never taken, even if young.
  await db.exec(`UPDATE public.email_messages SET delivery_reason = 'no_transport'
                  WHERE id = '00000000-0000-4000-8000-0000000000a3'`);
  const vendor = await ids(`SELECT id FROM public.claim_retryable_queued_emails(25)`);
  check(
    !vendor.includes("00000000-0000-4000-8000-0000000000a3"),
    "a vendor-order draft is never claimed",
  );
  check(
    !vendor.includes("00000000-0000-4000-8000-0000000000a1"),
    "a bare 'queued' row with no reason is never claimed",
  );
  await db.exec(`UPDATE public.email_messages SET claimed_at = NULL`);

  // Bounded and oldest first.
  await db.exec(`
    INSERT INTO public.email_messages (status, sent_by, created_at)
    SELECT 'queued', '${DAVID}', now() - (g || ' minutes')::interval FROM generate_series(1, 30) g;
    UPDATE public.email_messages SET delivery_reason = 'sender_not_connected'
     WHERE delivery_reason IS NULL AND status = 'queued' AND sent_by IS NOT NULL
       AND supply_request_id IS NULL AND created_at > now() - interval '2 hours';
  `);
  const expected = await ids(`
    SELECT id FROM (
      SELECT id FROM public.email_messages
       WHERE status = 'queued' AND sent_at IS NULL AND delivery_reason IS NOT NULL
         AND supply_request_id IS NULL AND created_at > now() - interval '14 days'
       ORDER BY created_at LIMIT 5) t`);
  const batch = await ids(`SELECT id FROM public.claim_retryable_queued_emails(5)`);
  check(batch.length === 5, "the batch is bounded");
  check(
    JSON.stringify(batch) === JSON.stringify(expected) && batch.includes(INVOICE),
    "oldest first: the five oldest eligible rows, David's invoice among them",
  );

  /* ---- 3. a person's Resend ---------------------------------------- */
  await db.exec(`UPDATE public.email_messages SET delivery_attempts = 4 WHERE id = '${WORK_AUTH}'`);
  const resend = await db.query(
    `SELECT id, delivery_attempts FROM public.claim_retryable_queued_emails(1, '${WORK_AUTH}')`,
  );
  check(
    resend.rows.length === 1 && resend.rows[0].delivery_attempts === 0,
    "Resend names the 25 Aug row: claimed despite its age, attempts restarted",
  );
  check(
    (await db.query(`SELECT id FROM public.claim_retryable_queued_emails(1, '${WORK_AUTH}')`)).rows
      .length === 0,
    "a second Resend while the first holds it gets nothing",
  );
  await db.exec(`UPDATE public.email_messages SET status = 'failed', claimed_at = NULL
                  WHERE id = '${WORK_AUTH}'`);
  check(
    (await db.query(`SELECT id FROM public.claim_retryable_queued_emails(1, '${WORK_AUTH}')`)).rows
      .length === 1,
    "Resend can take a 'failed' row",
  );
  check(
    (
      await db.query(
        `SELECT id FROM public.claim_retryable_queued_emails(1, '00000000-0000-4000-8000-0000000000a4')`,
      )
    ).rows.length === 0,
    "Resend never takes a sent row",
  );
  await db.exec(`UPDATE public.email_messages SET status = 'queued', claimed_at = NULL
                  WHERE id = '${WORK_AUTH}'`);

  /* ---- 4. the guard ------------------------------------------------- */
  await asUser(DAVID);
  const ins = await one(
    `INSERT INTO public.email_messages (status, sent_by, delivery_reason, provider, delivery_attempts,
       claimed_at, next_attempt_at)
     VALUES ('queued', '${DAVID}', 'no_transport', 'outlook', 3, now(), now())
     RETURNING delivery_reason, provider, delivery_attempts, claimed_at, next_attempt_at`,
  );
  check(
    ins.delivery_reason === null &&
      ins.provider === null &&
      ins.delivery_attempts === 0 &&
      ins.claimed_at === null &&
      ins.next_attempt_at === null,
    "a signed-in insert starts with empty transport columns",
  );
  const upd = await one(
    `UPDATE public.email_messages SET delivery_reason = 'transport_error', delivery_attempts = 0,
       provider = 'resend' WHERE id = '${INVOICE}' RETURNING delivery_reason, provider`,
  );
  check(
    upd.delivery_reason === "no_transport" && upd.provider === null,
    "a signed-in update cannot change them",
  );
  let frozen = false;
  try {
    await db.exec(
      `UPDATE public.email_messages SET to_emails = '{someone@else.com}' WHERE id = '${INVOICE}'`,
    );
  } catch (e) {
    frozen = /waiting to send/.test(String(e.message));
  }
  check(frozen, "a parked email's recipients cannot be changed by a signed-in writer");
  await asService();
  const svc = await one(
    `UPDATE public.email_messages SET delivery_reason = 'transport_error', provider = 'outlook'
      WHERE id = '${INVOICE}' RETURNING delivery_reason, provider`,
  );
  check(
    svc.delivery_reason === "transport_error" && svc.provider === "outlook",
    "the service role writes them",
  );
  await db.exec(`UPDATE public.email_messages SET provider = NULL, delivery_reason = 'no_transport'
                  WHERE id = '${INVOICE}'`);

  /* ---- 5. the kick -------------------------------------------------- */
  // Everything parked waits; nothing held.
  await db.exec(`UPDATE public.email_messages SET claimed_at = NULL,
                   next_attempt_at = now() + interval '5 minutes' WHERE delivery_reason IS NOT NULL`);
  await db.exec(`DELETE FROM net.calls`);
  await db.exec(`SELECT public.email_release_kick()`);
  check(
    (await one(`SELECT count(*)::int AS n FROM net.calls`)).n === 0,
    "quiet while rows only wait",
  );

  await db.exec(`UPDATE public.email_messages SET next_attempt_at = now() - interval '1 second'
                  WHERE id = '${INVOICE}'`);
  await db.exec(`SELECT public.email_release_kick()`);
  const call = await one(`SELECT url, headers FROM net.calls`);
  check(
    call?.url ===
      "https://project--b0a4cfc7-3fd3-46ba-aa5d-90a925aaa67c.lovable.app/api/public/hooks/email-release",
    "posts to the email-release hook for a due parked row",
  );
  check(call?.headers?.["x-cron-secret"] === "test-cron-secret", "with the cron secret");

  // The 25 Aug row due but too old: still quiet.
  await db.exec(`DELETE FROM net.calls;
    UPDATE public.email_messages SET next_attempt_at = now() + interval '5 minutes'
     WHERE id = '${INVOICE}';
    UPDATE public.email_messages SET next_attempt_at = NULL WHERE id = '${WORK_AUTH}';`);
  await db.exec(`SELECT public.email_release_kick()`);
  check(
    (await one(`SELECT count(*)::int AS n FROM net.calls`)).n === 0,
    "a row past 14 days never wakes the hook",
  );

  // A due held email still does, as before.
  await db.exec(`INSERT INTO public.email_messages (status, sent_by, release_at)
                 VALUES ('held', '${DAVID}', now() - interval '1 second')`);
  await db.exec(`SELECT public.email_release_kick()`);
  check(
    (await one(`SELECT count(*)::int AS n FROM net.calls`)).n === 1,
    "a due held email still posts",
  );

  /* ---- 6. grants ---------------------------------------------------- */
  for (const fn of [
    "public.claim_retryable_queued_emails(integer, uuid)",
    "public.email_release_kick()",
    "public.tg_email_transport_guard()",
  ]) {
    for (const role of ["anon", "authenticated"]) {
      const g = await one(`SELECT has_function_privilege('${role}', '${fn}', 'EXECUTE') AS ok`);
      check(g.ok === false, `${role} cannot execute ${fn}`);
    }
  }
  for (const fn of [
    "public.claim_retryable_queued_emails(integer, uuid)",
    "public.email_release_kick()",
  ]) {
    const g = await one(`SELECT has_function_privilege('service_role', '${fn}', 'EXECUTE') AS ok`);
    check(g.ok === true, `service_role can execute ${fn}`);
  }
  const definer = await one(`
    SELECT bool_and(p.prosecdef) AS sd, bool_and(array_to_string(p.proconfig, ',') LIKE '%search_path=""%') AS sp
      FROM pg_proc p WHERE p.proname IN ('claim_retryable_queued_emails', 'email_release_kick')`);
  check(definer.sd === true, "claim and kick are SECURITY DEFINER");
  check(definer.sp === true, "with search_path pinned to ''");

  console.log(`email-transport-retry.pglite: ${assertions} assertions passed`);
} finally {
  await db.close();
}
