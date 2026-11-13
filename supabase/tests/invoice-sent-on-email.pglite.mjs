// Run with: node supabase/tests/invoice-sent-on-email.pglite.mjs <existing PGlite dist/index.js>
// In-memory fixtures only. No connection string, network access or live writes.
//
// Migration 20261109130000 (READ FROM THE FILE): an email that reaches 'sent'
// moves its Draft invoice to Sent with a sent date; a failed or held email
// changes nothing, and no other status is downgraded.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
const sql = readFileSync(
  new URL("../migrations/20261109130000_invoice_sent_on_email.sql", import.meta.url),
  "utf8",
);

await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated;
  CREATE TYPE public.invoice_status AS ENUM ('draft','sent','partial','paid','disputed','written_off');
  CREATE TABLE public.invoices (
    id text PRIMARY KEY, status public.invoice_status NOT NULL DEFAULT 'draft', sent_at timestamptz
  );
  CREATE TABLE public.email_messages (
    id serial PRIMARY KEY, invoice_id text, status text NOT NULL, sent_at timestamptz
  );
  INSERT INTO public.invoices (id, status) VALUES
    ('draft_ok', 'draft'), ('draft_fail', 'draft'), ('draft_held', 'draft'),
    ('paid', 'paid'), ('partial', 'partial'), ('direct', 'draft');
`);
await db.exec(sql);

const inv = async (id) =>
  (await db.query(`SELECT status::text AS status, sent_at FROM invoices WHERE id = $1`, [id]))
    .rows[0];

// Held, then released and sent.
await db.exec(`INSERT INTO email_messages (invoice_id, status) VALUES ('draft_ok', 'held')`);
assert.equal((await inv("draft_ok")).status, "draft");
await db.exec(
  `UPDATE email_messages SET status = 'sent', sent_at = '2026-11-05T10:00:00Z' WHERE invoice_id = 'draft_ok'`,
);
const ok = await inv("draft_ok");
assert.equal(ok.status, "sent");
assert.equal(new Date(ok.sent_at).toISOString(), "2026-11-05T10:00:00.000Z");

// A failed send leaves it a draft.
await db.exec(`INSERT INTO email_messages (invoice_id, status) VALUES ('draft_fail', 'queued')`);
await db.exec(`UPDATE email_messages SET status = 'failed' WHERE invoice_id = 'draft_fail'`);
assert.equal((await inv("draft_fail")).status, "draft");
assert.equal((await inv("draft_fail")).sent_at, null);

// Still held: nothing yet.
await db.exec(`INSERT INTO email_messages (invoice_id, status) VALUES ('draft_held', 'held')`);
assert.equal((await inv("draft_held")).status, "draft");

// Sent straight away (no hold window).
await db.exec(
  `INSERT INTO email_messages (invoice_id, status, sent_at) VALUES ('direct', 'sent', now())`,
);
assert.equal((await inv("direct")).status, "sent");

// Never downgrades.
await db.exec(
  `INSERT INTO email_messages (invoice_id, status) VALUES ('paid', 'sent'), ('partial', 'sent')`,
);
assert.equal((await inv("paid")).status, "paid");
assert.equal((await inv("partial")).status, "partial");

await db.exec(sql); // re-runnable
console.log("invoice-sent-on-email: ok");
