// Run with: node supabase/tests/followup-proof.pglite.mjs <PGlite dist/index.js>
// In-memory fixtures only. No connection string, network access or live writes.
//
// What counts as a follow-up (20261110190000). Melly: a hand-logged touch
// counts "only if the rep attaches something"; without it, it is an attempt;
// out-of-office auto-replies never count; answered calls count at two
// minutes; and everything logged before the rule keeps the old rule, so
// history does not flip and open a wave of Critical episodes.
//
// The migration is READ FROM THE FILE. The tables around it are the smallest
// stubs that let it run.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
const migration = readFileSync(
  new URL("../migrations/20261110190000_followup_proof_rule.sql", import.meta.url),
  "utf8",
);

let assertions = 0;
const check = (value, what) => {
  assert.equal(value, true, what);
  assertions++;
};
const one = async (sql) => (await db.query(sql)).rows[0];
const as = async (uid) =>
  db.exec(`SELECT set_config('request.jwt.claim.sub', '${uid ?? ""}', false)`);
const refused = async (sql) => {
  try {
    await db.exec(sql);
    return "ALLOWED";
  } catch (e) {
    return `REFUSED:${e.code ?? e.message}`;
  }
};

const rep = "11111111-1111-4111-8111-111111111111";
const rep2 = "22222222-2222-4222-8222-222222222222";
const manager = "33333333-3333-4333-8333-333333333333";
const office = "66666666-6666-4666-8666-666666666666";
const acct = (n) => `bbbbbbbb-bbbb-4bbb-8bbb-00000000000${n}`;
const touch = (n) => `cccccccc-cccc-4ccc-8ccc-0000000000${String(n).padStart(2, "0")}`;

try {
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE SCHEMA storage;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean,
      file_size_limit bigint, allowed_mime_types text[]);
    CREATE TABLE storage.objects (bucket_id text, name text);

    CREATE TABLE public.app_settings (key text PRIMARY KEY, value jsonb);
    CREATE FUNCTION public.can_view_location(_uid uuid, _loc uuid) RETURNS boolean
      LANGUAGE sql STABLE AS $$ SELECT _uid = '${manager}'::uuid $$;
    CREATE FUNCTION public.is_sales_manager(_uid uuid) RETURNS boolean
      LANGUAGE sql STABLE AS $$ SELECT _uid = '${manager}'::uuid $$;
    CREATE FUNCTION public.account_is_house_account(_id uuid) RETURNS boolean
      LANGUAGE sql STABLE AS $$ SELECT false $$;
    CREATE FUNCTION public.list_business_reps()
      RETURNS TABLE(user_id uuid, full_name text) LANGUAGE sql STABLE AS
      $$ VALUES ('${rep}'::uuid, 'Rep One'), ('${rep2}'::uuid, 'Rep Two') $$;
    CREATE FUNCTION public.pipeline_rule_settings() RETURNS jsonb LANGUAGE sql STABLE AS
      $$ SELECT '{"window_days": 30, "day_timezone": "America/New_York"}'::jsonb $$;
    CREATE FUNCTION public.touchpoint_method(_type text) RETURNS text LANGUAGE sql IMMUTABLE AS
      $$ SELECT _type $$;
    CREATE TABLE public.tasks (account_id uuid, status text, completed_at timestamptz);

    CREATE TABLE public.accounts (
      id uuid PRIMARY KEY, assigned_rep uuid, location_id uuid, status text DEFAULT 'active',
      health_stage_id uuid, stage text DEFAULT 'active_client', archived_at timestamptz
    );
    INSERT INTO public.accounts (id, assigned_rep, location_id) VALUES
      ('${acct(1)}', '${rep}', '${office}'),
      ('${acct(2)}', '${rep}', '${office}'),
      ('${acct(3)}', '${rep2}', '${office}');

    CREATE TABLE public.touchpoints (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id uuid NOT NULL, contact_id uuid, type text NOT NULL,
      direction text NOT NULL DEFAULT 'outbound', capture_source text NOT NULL DEFAULT 'manual',
      occurred_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(),
      created_by uuid, duration_seconds int, meeting_held boolean, replied_at timestamptz,
      notes text, counts_toward_cadence boolean NOT NULL DEFAULT false,
      is_self_reported boolean NOT NULL DEFAULT false
    );
  `);

  await db.exec(migration);
  await db.exec(`
    CREATE TRIGGER trg_touchpoint_cadence BEFORE INSERT OR UPDATE ON public.touchpoints
      FOR EACH ROW EXECUTE FUNCTION public.tg_touchpoint_cadence();
  `);
  const starts = (await one(`SELECT starts_at FROM public.followup_rule_settings()`)).starts_at;
  check(starts instanceof Date, "the rule start is stored and readable");
  check((await one(`SELECT call_min_seconds FROM public.followup_rule_settings()`)).call_min_seconds === 120,
    "answered calls count at two minutes");

  const counts = async (id) =>
    (await one(`SELECT counts_toward_cadence AS c FROM public.touchpoints WHERE id = '${id}'`)).c;

  /* ---- 1. history keeps the old rule ---------------------------------- */
  await as(rep);
  await db.exec(`
    INSERT INTO public.touchpoints (id, account_id, type, created_by, created_at, occurred_at)
    VALUES ('${touch(1)}', '${acct(1)}', 'meeting_in_person', '${rep}', now() - interval '30 days', now() - interval '30 days');
    INSERT INTO public.touchpoints (id, account_id, type, capture_source, duration_seconds, created_by, created_at)
    VALUES ('${touch(2)}', '${acct(1)}', 'call', 'dialer', 60, '${rep}', now() - interval '30 days');`);
  check(await counts(touch(1)), "a hand-logged meeting from before the rule still counts");
  check(await counts(touch(2)), "a 60-second call from before the rule still counts");
  await db.exec(`UPDATE public.touchpoints SET notes = 'edited' WHERE id IN ('${touch(1)}', '${touch(2)}')`);
  check((await counts(touch(1))) && (await counts(touch(2))), "editing an old touch never re-judges it");

  /* ---- 2. a button click with nothing attached is an attempt ---------- */
  await db.exec(`INSERT INTO public.touchpoints (id, account_id, type, created_by, replied_at)
                 VALUES ('${touch(3)}', '${acct(1)}', 'gift', '${rep}', now())`);
  check((await counts(touch(3))) === false, "a hand-logged gift with no proof does not count, even marked replied");
  check((await one(`SELECT is_self_reported AS s FROM public.touchpoints WHERE id = '${touch(3)}'`)).s,
    "and it is recorded as self-reported");
  await db.exec(`INSERT INTO public.touchpoints (id, account_id, type, created_by)
                 VALUES ('${touch(4)}', '${acct(1)}', 'meeting_in_person', '${rep}')`);
  check((await counts(touch(4))) === false, "a hand-logged meeting with no proof does not count");

  /* ---- 3. proof makes it count ---------------------------------------- */
  const path = `${acct(1)}/gift-photo.jpg`;
  check((await refused(`UPDATE public.touchpoints SET proof_kind = 'photo', proof_path = '${path}' WHERE id = '${touch(3)}'`))
    === "REFUSED:22023", "proof that was never uploaded is refused");
  await db.exec(`INSERT INTO storage.objects VALUES ('touchpoint-proof', '${path}')`);
  await db.exec(`UPDATE public.touchpoints SET proof_kind = 'photo', proof_path = '${path}' WHERE id = '${touch(3)}'`);
  const t3 = await one(`SELECT counts_toward_cadence AS c, proof_added_at FROM public.touchpoints WHERE id = '${touch(3)}'`);
  check(t3.c === true, "with the photo attached the gift counts");
  check(t3.proof_added_at !== null, "and the moment proof was added is stamped");

  const otherPath = `${acct(2)}/notes.pdf`;
  await db.exec(`INSERT INTO storage.objects VALUES ('touchpoint-proof', '${otherPath}')`);
  check((await refused(`UPDATE public.touchpoints SET proof_kind = 'file', proof_path = '${otherPath}' WHERE id = '${touch(4)}'`))
    === "REFUSED:22023", "another account's file cannot be borrowed as proof");

  await db.exec(`INSERT INTO storage.objects VALUES ('touchpoint-proof', '${acct(1)}/not-held.jpg')`);
  await db.exec(`INSERT INTO public.touchpoints (id, account_id, type, created_by, meeting_held, proof_kind, proof_path)
                 VALUES ('${touch(5)}', '${acct(1)}', 'meeting_in_person', '${rep}', false, 'photo', '${acct(1)}/not-held.jpg')`);
  check((await counts(touch(5))) === false, "a meeting marked not held does not count, proof or not");

  /* ---- 4. 'form' proof is the server's to give ------------------------ */
  check((await refused(`INSERT INTO public.touchpoints (account_id, type, direction, created_by, proof_kind)
                        VALUES ('${acct(1)}', 'meeting_in_person', 'inbound', '${rep}', 'form')`))
    === "REFUSED:42501", "a signed-in rep cannot claim form proof");
  await as(null);
  await db.exec(`INSERT INTO public.touchpoints (id, account_id, type, direction, created_by, proof_kind)
                 VALUES ('${touch(6)}', '${acct(1)}', 'meeting_in_person', 'inbound', '${rep}', 'form')`);
  check(await counts(touch(6)), "a booth form the client filled in counts");

  /* ---- 5. auto-replies and two-minute calls --------------------------- */
  await db.exec(`
    INSERT INTO public.touchpoints (id, account_id, type, direction, capture_source, created_by, is_auto_reply)
    VALUES ('${touch(7)}', '${acct(2)}', 'email', 'inbound', 'mailbox', '${rep}', true),
           ('${touch(8)}', '${acct(2)}', 'email', 'inbound', 'mailbox', '${rep}', false);
    INSERT INTO public.touchpoints (id, account_id, type, capture_source, duration_seconds, created_by)
    VALUES ('${touch(9)}', '${acct(2)}', 'call', 'dialer', 60, '${rep}'),
           ('${touch(10)}', '${acct(2)}', 'call', 'dialer', 130, '${rep}');`);
  check((await counts(touch(7))) === false, "an out-of-office reply does not count");
  check((await counts(touch(8))) === true, "a real inbound email counts");
  check((await counts(touch(9))) === false, "a one-minute call does not count");
  check((await counts(touch(10))) === true, "a call over two minutes counts");

  /* ---- 6. the pipeline still hears the rep's "They responded" --------- */
  await db.exec(`DELETE FROM public.touchpoints WHERE account_id = '${acct(3)}'`);
  await db.exec(`INSERT INTO public.touchpoints (account_id, type, direction, capture_source, created_by, is_auto_reply)
                 VALUES ('${acct(3)}', 'email', 'inbound', 'mailbox', '${rep2}', true)`);
  let s = await one(`SELECT replied FROM public.pipeline_outreach_stats('${acct(3)}', now() - interval '1 day')`);
  check(s.replied === false, "an auto-reply is not a response to the pipeline either");
  await as(rep2);
  await db.exec(`INSERT INTO public.touchpoints (account_id, type, created_by, replied_at)
                 VALUES ('${acct(3)}', 'text', '${rep2}', now())`);
  s = await one(`SELECT replied FROM public.pipeline_outreach_stats('${acct(3)}', now() - interval '1 day')`);
  check(s.replied === true, "a hand-logged reply with no proof still moves the pipeline");

  /* ---- 7. the manager's one number ------------------------------------ */
  // acct(1): latest counting touch is the booth form (self-reported, proofed).
  // acct(2): latest counting touch is the two-minute call (system).
  // acct(3): no counting touch.
  await as(manager);
  const rows = (await db.query(`SELECT * FROM public.rep_self_cleared_shares() ORDER BY full_name`)).rows;
  const r1 = rows.find((r) => r.user_id === rep);
  const r2 = rows.find((r) => r.user_id === rep2);
  check(r1.cleared === 2 && r1.self_cleared === 1, "rep one: two cleared clients, one by their own word");
  check(r2.cleared === 0 && r2.self_cleared === 0, "rep two: nothing cleared");
  await as(rep);
  check((await db.query(`SELECT * FROM public.rep_self_cleared_shares()`)).rows.length === 0,
    "a rep cannot read the managers' number");

  /* ---- re-runnable ---------------------------------------------------- */
  await as(null);
  const before = (await one(`SELECT value FROM public.app_settings WHERE key = 'followup_rules'`)).value;
  await db.exec(migration);
  const after = (await one(`SELECT value FROM public.app_settings WHERE key = 'followup_rules'`)).value;
  check(JSON.stringify(before) === JSON.stringify(after), "replaying the migration never moves the rule's start");
  check(await counts(touch(1)), "and history still holds");

  console.log(`followup-proof.pglite: ${assertions} assertions passed`);
} finally {
  await db.close();
}
