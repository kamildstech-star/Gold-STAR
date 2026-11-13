// Run with: node supabase/tests/invoice-followups.pglite.mjs <PGlite dist/index.js>
// In-memory fixtures only — never the project's database.
//
// Runs the REAL 20261022160000_invoice_followups.sql against stand-in tables
// and proves:
//   1. it seeds the default rule (7 → 14 days) and the two templates, once;
//   2. a step can be recorded once per invoice and rule — never twice;
//   3. an invoice turning PAID cancels its held and queued reminders (and
//      their audit rows), and leaves every other email alone;
//   4. switching follow-ups OFF on the invoice does the same;
//   5. the file runs a second time without error or duplication.
import { readFileSync, readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const MIGRATIONS = new URL("../migrations/", import.meta.url);
const name = readdirSync(MIGRATIONS).find((f) => f.startsWith("20261022160000"));
const SQL = readFileSync(new URL(name, MIGRATIONS), "utf8");

let assertions = 0;
const eq = (actual, expected, what) => {
  assert.deepEqual(actual, expected, what);
  assertions++;
};

const db = new PGlite();
await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
  CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
  CREATE FUNCTION public.is_privileged(_u uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;

  CREATE TYPE public.invoice_status AS ENUM ('draft','sent','partial','paid','disputed','written_off');
  CREATE TYPE public.email_status AS ENUM ('queued','sent','delivered','opened','bounced','failed','held','cancelled');
  CREATE TYPE public.email_category AS ENUM ('estimate','invoice','follow_up','seasonal','work_authorization','reminder','notification','payment_receipt');

  CREATE TABLE public.locations (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
  CREATE TABLE public.accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);
  CREATE TABLE public.tasks (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
  CREATE TABLE public.invoices (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    status public.invoice_status NOT NULL DEFAULT 'draft'
  );
  CREATE TABLE public.email_messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id uuid, template_key text, status public.email_status NOT NULL DEFAULT 'queued',
    error text
  );
  CREATE TABLE public.email_templates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    key text, name text, category public.email_category, subject text, body text,
    is_active boolean DEFAULT true, location_id uuid
  );
  -- As in production: NULL offices are distinct, so the seed must not rely on ON CONFLICT.
  CREATE UNIQUE INDEX email_templates_key_loc ON public.email_templates (key, location_id);
`);

await db.exec(SQL);
await db.exec(SQL); // re-runnable

const rows = async (q) => (await db.query(q)).rows;
const one = async (q) => (await rows(q))[0];

// 1. Seeds, once
const rules = await rows(`SELECT name, steps FROM public.invoice_followup_rules`);
eq(rules.length, 1, "one default rule, even after two runs");
eq(
  rules[0].steps.map((s) => s.days),
  [7, 14],
  "7 then 14 days",
);
eq(
  (await rows(`SELECT key FROM public.email_templates ORDER BY key`)).map((r) => r.key),
  ["invoice_followup_1", "invoice_followup_2"],
  "two templates, once",
);

// Fixtures
const inv = (await one(`INSERT INTO public.invoices (status) VALUES ('sent') RETURNING id`)).id;
const inv2 = (await one(`INSERT INTO public.invoices (status) VALUES ('sent') RETURNING id`)).id;
const rule = (await one(`SELECT id FROM public.invoice_followup_rules`)).id;
const mail = async (invoice, key, status) =>
  (
    await one(`INSERT INTO public.email_messages (invoice_id, template_key, status)
               VALUES ('${invoice}', ${key ? `'${key}'` : "NULL"}, '${status}') RETURNING id`)
  ).id;
const held = await mail(inv, "invoice_followup_1", "held");
const queued = await mail(inv, "invoice_followup_2", "queued");
const sent = await mail(inv, "invoice_followup_1", "sent");
const theInvoiceItself = await mail(inv, "invoice_send", "held");
await db.exec(`
  INSERT INTO public.invoice_followups (invoice_id, rule_id, rule_key, step_index, days, template_key, outcome, email_message_id)
  VALUES ('${inv}', '${rule}', '${rule}', 0, 7, 'invoice_followup_1', 'emailed', '${held}'),
         ('${inv}', '${rule}', '${rule}', 1, 14, 'invoice_followup_2', 'emailed', '${queued}');
`);

// 2. Once per step
let dup = false;
try {
  await db.exec(`INSERT INTO public.invoice_followups (invoice_id, rule_key, step_index, days, template_key, outcome)
                 VALUES ('${inv}', '${rule}', 0, 7, 'invoice_followup_1', 'emailed')`);
} catch (e) {
  dup = /duplicate key|unique/i.test(String(e.message));
}
eq(dup, true, "the same step cannot be recorded twice");

// 3. Paid cancels what is waiting
await db.exec(`UPDATE public.invoices SET status = 'paid' WHERE id = '${inv}'`);
const status = async (id) => (await one(`SELECT status::text AS s FROM public.email_messages WHERE id = '${id}'`)).s;
eq(await status(held), "cancelled", "held reminder cancelled on payment");
eq(await status(queued), "cancelled", "queued reminder cancelled on payment");
eq(await status(sent), "sent", "a reminder already sent is history, untouched");
eq(await status(theInvoiceItself), "held", "the invoice's own email is not a reminder — untouched");
eq(
  (await rows(`SELECT outcome, cancel_reason FROM public.invoice_followups WHERE invoice_id = '${inv}' ORDER BY step_index`)).map(
    (r) => `${r.outcome}:${r.cancel_reason}`,
  ),
  ["cancelled:Invoice paid", "cancelled:Invoice paid"],
  "the audit rows say why",
);

// 4. Off on the invoice cancels too
const held2 = await mail(inv2, "invoice_followup_1", "held");
await db.exec(`UPDATE public.invoices SET followup_mode = 'off' WHERE id = '${inv2}'`);
eq(await status(held2), "cancelled", "switching off cancels the waiting reminder");

// The mode is constrained.
let bad = false;
try {
  await db.exec(`UPDATE public.invoices SET followup_mode = 'sometimes' WHERE id = '${inv2}'`);
} catch {
  bad = true;
}
eq(bad, true, "followup_mode is auto, off or rule");

// The client exemption column exists and defaults off.
eq(
  (await one(`INSERT INTO public.accounts (name) VALUES ('Acme') RETURNING no_auto_followups`)).no_auto_followups,
  false,
  "clients are not exempt by default",
);

console.log(`invoice follow-ups: ${assertions} assertions passed`);
