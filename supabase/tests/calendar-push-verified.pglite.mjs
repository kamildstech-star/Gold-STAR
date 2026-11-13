// Offline migration regression harness; never connects to a remote database.
// node supabase/tests/calendar-push-verified.pglite.mjs
// Optional isolated dependency: set AUDIT_SQL_RUNTIME to its install directory.
//
// Proves 20261007140000_calendar_push_verified_identity.sql on top of the
// guard it builds on (20260908012000): the backfill buckets, that a repair
// is not an edit, that it is re-runnable, and the replaced
// calendar_push_authorized_event() for each way an event is born.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const require = createRequire(
  process.env.AUDIT_SQL_RUNTIME
    ? resolve(process.env.AUDIT_SQL_RUNTIME, "package.json")
    : import.meta.url,
);
const { PGlite } = require("@electric-sql/pglite");
const db = new PGlite();

const rep = "11111111-1111-4111-8111-111111111111";
const colleague = "22222222-2222-4222-8222-222222222222";
const manager = "33333333-3333-4333-8333-333333333333";
const admin = "44444444-4444-4444-8444-444444444444";
const loner = "55555555-5555-4555-8555-555555555555";
const office = "66666666-6666-4666-8666-666666666666";
const elsewhere = "77777777-7777-4777-8777-777777777777";
const ownBox = "a1111111-1111-4111-8111-111111111111";
const colleagueBox = "a2222222-2222-4222-8222-222222222222";
const sharedBox = "a3333333-3333-4333-8333-333333333333";
const account = "b1111111-1111-4111-8111-111111111111";
const ev = {
  demo: "c0000000-0000-4000-8000-000000000001",
  defaulted: "c0000000-0000-4000-8000-000000000002",
  syncedLegacy: "c0000000-0000-4000-8000-000000000003",
  organizerOnly: "c0000000-0000-4000-8000-000000000004",
  colleagues: "c0000000-0000-4000-8000-000000000005",
  officeEvent: "c0000000-0000-4000-8000-000000000006",
  lonerEvent: "c0000000-0000-4000-8000-000000000007",
  fresh: "c0000000-0000-4000-8000-000000000008",
};

let checks = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  checks++;
};
const eq = (a, b, msg) => {
  assert.deepEqual(a, b, msg);
  checks++;
};
async function scalar(sql, params = []) {
  return Object.values((await db.query(sql, params)).rows[0])[0];
}
async function as(role, actor) {
  await db.exec("reset role");
  await db.query("select set_config('test.actor', $1, false)", [actor ?? ""]);
  if (role) await db.exec(`set role ${role}`);
}
async function authorize(id) {
  return scalar("select public.calendar_push_authorized_event($1)", [id]);
}
async function refused(id, pattern, code = "42501") {
  try {
    await authorize(id);
  } catch (e) {
    ok(e.code === code, `expected SQLSTATE ${code}, got ${e.code}: ${e.message}`);
    ok(pattern.test(e.message), `expected ${pattern}, got: ${e.message}`);
    return;
  }
  assert.fail(`event ${id} was authorised; expected a refusal matching ${pattern}`);
}
const migration = (file) => readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8");
const snapshot = async () =>
  (
    await db.query(
      `select id, provider, external_id, mailbox_id, organizer_email, push_identity_verified,
              push_actor_id, updated_at from public.calendar_events order by id`,
    )
  ).rows;

try {
  await db.exec(`
    create role authenticated; create role anon; create role service_role;
    create schema auth;
    create function auth.uid() returns uuid language sql as
      $$ select nullif(current_setting('test.actor', true), '')::uuid $$;
    grant usage on schema auth to authenticated, service_role;
    create table public.profiles(user_id uuid primary key, is_active boolean, approval_status text);
    create table public.test_roles(user_id uuid, role text);
    create table public.test_managers(user_id uuid, location_id uuid);
    create function public.has_role(u uuid, r text) returns boolean language sql as
      $$ select exists(select 1 from public.test_roles where user_id=u and role=r) $$;
    create function public.can_manage_location(u uuid, l uuid) returns boolean language sql as
      $$ select exists(select 1 from public.test_managers where user_id=u and location_id=l) $$;
    create table public.graph_mailboxes(id uuid primary key, upn text, user_id uuid,
      location_id uuid, enabled boolean, sync_calendar boolean);
    -- The live column has DEFAULT 'outlook'; that default is half of what
    -- this migration fixes.
    create table public.calendar_events(id uuid primary key default gen_random_uuid(),
      provider text default 'outlook', external_id text, mailbox_id uuid,
      organizer_email text, user_id uuid, location_id uuid, created_by uuid,
      account_id uuid, subject text, attendees jsonb default '[]',
      is_demo boolean default false, sync_direction text not null default 'local',
      sync_state text not null default 'clean', updated_at timestamptz default now(),
      unique (provider, external_id));
    -- Stand-ins for the two live triggers the repair must not fire.
    create table public.test_trigger_log(name text, event_id uuid);
    create function public.test_touch_updated_at() returns trigger language plpgsql as $$
      begin new.updated_at := now() + interval '1 day';
        insert into public.test_trigger_log values ('updated_at', new.id); return new; end $$;
    create function public.test_stage_advance() returns trigger language plpgsql as $$
      begin insert into public.test_trigger_log values ('stage_advance', new.id); return null; end $$;
    create trigger calendar_events_updated_at before update on public.calendar_events
      for each row execute function public.test_touch_updated_at();
    create trigger trg_stage_advance_calendar after insert or update on public.calendar_events
      for each row execute function public.test_stage_advance();
    grant all on all tables in schema public to service_role;
    grant select, insert, update on public.calendar_events to authenticated;
    grant insert on public.test_trigger_log to authenticated, service_role;
    insert into public.profiles values
      ('${rep}',true,'approved'),('${colleague}',true,'approved'),('${manager}',true,'approved'),
      ('${admin}',true,'approved'),('${loner}',true,'approved');
    insert into public.test_roles values ('${admin}','admin');
    insert into public.test_managers values ('${manager}','${office}');
    insert into public.graph_mailboxes values
      ('${ownBox}','rep@example.com','${rep}',null,true,true),
      ('${colleagueBox}','colleague@example.com','${colleague}',null,true,true),
      ('${sharedBox}','office@example.com',null,'${office}',true,true);
  `);
  await db.exec(migration("20260908012000_calendar_push_integrity.sql"));

  // Rows as they stand on live before this migration, written as the server.
  await db.exec(`
    insert into public.calendar_events(id,provider,external_id,user_id,is_demo,sync_direction)
      values ('${ev.demo}','outlook','demo-1','${rep}',true,'inbound');
    insert into public.calendar_events(id,created_by,user_id,account_id,sync_direction,sync_state,
        attendees, updated_at)
      values ('${ev.defaulted}','${rep}','${rep}','${account}','outbound','pending_push',
        '[{"email":"client@example.com"}]', '2026-09-08T07:20:35Z');
    insert into public.calendar_events(id,provider,external_id,mailbox_id,user_id,sync_direction,sync_state)
      values ('${ev.syncedLegacy}','outlook','AAMk-legacy','${ownBox}','${rep}','two_way','pending_push');
    insert into public.calendar_events(id,provider,organizer_email,user_id)
      values ('${ev.organizerOnly}','outlook','boss@example.com','${rep}');
    delete from public.test_trigger_log;
  `);
  eq(
    await scalar("select provider from public.calendar_events where id=$1", [ev.defaulted]),
    "outlook",
    "fixture: a local row picks up provider from the column default",
  );

  // The live bug: a CRM insert that does not mention provider is refused.
  await as("authenticated", rep);
  await assert.rejects(
    db.query(
      `insert into public.calendar_events(user_id,subject,sync_direction,sync_state)
       values ($1,'New inspection','outbound','pending_push')`,
      [rep],
    ),
    /Provider identities are server managed/,
  );
  checks++;

  await as(null);
  await db.exec(migration("20261007140000_calendar_push_verified_identity.sql"));

  /* ---------------- backfill buckets ---------------- */
  const row = async (id) =>
    (await db.query("select * from public.calendar_events where id=$1", [id])).rows[0];
  const defaulted = await row(ev.defaulted);
  eq(defaulted.provider, null, "a default-tagged local row loses its provider");
  eq(defaulted.push_identity_verified, true, "a row with no provider identity is verified");
  eq(defaulted.push_actor_id, null, "pre-guard created_by is not taken as the actor");
  eq(
    defaulted.updated_at.toISOString(),
    "2026-09-08T07:20:35.000Z",
    "the repair does not bump updated_at (queue order)",
  );
  eq(
    Number(await scalar("select count(*) from public.test_trigger_log")),
    0,
    "the repair fires neither updated_at nor stage auto-advance",
  );
  for (const [id, label] of [
    [ev.demo, "demo row with an external id and no mailbox"],
    [ev.syncedLegacy, "legacy synced row (waits for re-ingest)"],
    [ev.organizerOnly, "row with an organiser but no external id"],
  ]) {
    const r = await row(id);
    eq(r.push_identity_verified, false, `${label} stays unverified`);
    eq(r.provider, "outlook", `${label} keeps its provider`);
  }
  eq(
    await scalar(
      `select column_default from information_schema.columns
       where table_schema='public' and table_name='calendar_events' and column_name='provider'`,
    ),
    null,
    "provider has no default",
  );
  eq(
    (
      await db.query(
        `select tgname, tgenabled from pg_trigger
         where tgrelid='public.calendar_events'::regclass and not tgisinternal order by tgname`,
      )
    ).rows.map((t) => `${t.tgname}:${t.tgenabled}`),
    [
      "calendar_events_updated_at:O",
      "trg_stage_advance_calendar:O",
      "z_guard_calendar_push_identity:O",
    ],
    "every trigger is enabled again after the repair",
  );

  /* ---------------- re-runnable ---------------- */
  const before = await snapshot();
  await db.exec(migration("20261007140000_calendar_push_verified_identity.sql"));
  eq(await snapshot(), before, "applying it twice changes nothing");
  eq(Number(await scalar("select count(*) from public.test_trigger_log")), 0, "nor fires triggers");

  /* ---------------- grants ---------------- */
  eq(
    await scalar(`select proacl::text from pg_proc where proname='calendar_push_authorized_event'`),
    "{postgres=X/postgres,service_role=X/postgres}",
    "EXECUTE stays service_role only",
  );
  eq(
    await scalar(
      `select proconfig::text from pg_proc where proname='calendar_push_authorized_event'`,
    ),
    '{"search_path=\\"\\""}',
    "search_path stays pinned",
  );
  for (const role of ["anon", "authenticated"]) {
    await as(role, rep);
    await assert.rejects(authorize(ev.defaulted), /permission denied/);
    checks++;
  }

  /* ---------------- origin: created in the CRM calendar ---------------- */
  await as("authenticated", rep);
  await db.query(
    `insert into public.calendar_events(id,provider,user_id,location_id,subject,sync_direction,sync_state)
     values ($1,null,$2,$3,'New inspection','outbound','pending_push')`,
    [ev.fresh, rep, office],
  );
  const fresh = await row(ev.fresh);
  eq(
    [fresh.push_identity_verified, fresh.push_actor_id, fresh.created_by],
    [true, rep, rep],
    "a CRM insert is verified and acts as the session user",
  );
  await as("service_role");
  eq((await authorize(ev.fresh)).mailbox.id, ownBox, "verified, own mailbox: allowed");

  // The backfilled row: verified but no actor until someone signed in edits it.
  await refused(ev.defaulted, /nobody signed in has edited it/);
  await as("authenticated", rep);
  await db.query(
    "update public.calendar_events set subject='Moved', sync_state='pending_push' where id=$1",
    [ev.defaulted],
  );
  await as("service_role");
  eq((await authorize(ev.defaulted)).mailbox.id, ownBox, "after an edit it pushes as its editor");

  // Office mailbox: the person has none of their own.
  await as("authenticated", manager);
  await db.query(
    `insert into public.calendar_events(id,provider,user_id,location_id,sync_direction,sync_state)
     values ($1,null,$2,$3,'outbound','pending_push')`,
    [ev.officeEvent, manager, office],
  );
  await as("service_role");
  eq(
    (await authorize(ev.officeEvent)).mailbox.id,
    sharedBox,
    "verified, office mailbox the actor manages: allowed",
  );
  await db.query("delete from public.test_managers where user_id=$1", [manager]);
  await refused(ev.officeEvent, /cannot act as this mailbox/);
  await db.query("insert into public.test_managers values ($1,$2)", [manager, office]);

  // Nobody has a mailbox for it: a distinct answer, so it can stay local.
  await as("authenticated", loner);
  await db.query(
    `insert into public.calendar_events(id,provider,user_id,location_id,sync_direction,sync_state)
     values ($1,null,$2,$3,'outbound','pending_push')`,
    [ev.lonerEvent, loner, elsewhere],
  );
  await as("service_role");
  await refused(ev.lonerEvent, /No connected mailbox/, "P0002");

  /* ---------------- origin: synced from Outlook ---------------- */
  // Unverified (legacy) refused even when its owner is the one editing.
  await as("authenticated", rep);
  await db.query("update public.calendar_events set subject='x' where id=$1", [ev.syncedLegacy]);
  await as("service_role");
  await refused(ev.syncedLegacy, /never confirmed by a sync/);
  // The sync reads it again: the upsert ingestEvents sends marks it verified.
  await db.query(
    `insert into public.calendar_events(provider,external_id,mailbox_id,user_id,push_identity_verified)
     values ('outlook','AAMk-legacy',$1,$2,true)
     on conflict (provider,external_id) do update
       set mailbox_id=excluded.mailbox_id, user_id=excluded.user_id,
           push_identity_verified=excluded.push_identity_verified`,
    [ownBox, rep],
  );
  eq((await authorize(ev.syncedLegacy)).mailbox.id, ownBox, "re-ingested, owner's edit: allowed");

  // A colleague's personal mailbox.
  await db.query(
    `insert into public.calendar_events(id,provider,external_id,mailbox_id,user_id,push_identity_verified,
       sync_direction)
     values ($1,'outlook','AAMk-colleague',$2,$3,true,'two_way')`,
    [ev.colleagues, colleagueBox, colleague],
  );
  await as("authenticated", rep);
  await db.query(
    "update public.calendar_events set subject='Hijack', sync_state='pending_push' where id=$1",
    [ev.colleagues],
  );
  await as("service_role");
  await refused(ev.colleagues, /cannot act as this mailbox/);
  await as("authenticated", colleague);
  await db.query("update public.calendar_events set subject='Mine' where id=$1", [ev.colleagues]);
  await as("service_role");
  eq((await authorize(ev.colleagues)).mailbox.id, colleagueBox, "the mailbox's owner: allowed");
  await as("authenticated", admin);
  await db.query("update public.calendar_events set subject='Admin' where id=$1", [ev.colleagues]);
  await as("service_role");
  eq((await authorize(ev.colleagues)).mailbox.id, colleagueBox, "owner/admin/dev: allowed");

  // Its own mailbox switched off: refused, and never redirected elsewhere.
  await db.query("update public.graph_mailboxes set sync_calendar=false where id=$1", [
    colleagueBox,
  ]);
  await refused(ev.colleagues, /disabled or has calendar sync off/);
  await db.query("update public.graph_mailboxes set sync_calendar=true where id=$1", [
    colleagueBox,
  ]);
  await db.query("delete from public.graph_mailboxes where id=$1", [colleagueBox]);
  await refused(ev.colleagues, /no longer connected/);

  // A client still cannot attest anything itself.
  await as("authenticated", rep);
  await assert.rejects(
    db.query(
      `insert into public.calendar_events(provider,external_id,mailbox_id,user_id)
       values ('outlook','forged',$1,$2)`,
      [ownBox, rep],
    ),
    /server managed/,
  );
  checks++;
  await db.query("update public.calendar_events set push_identity_verified=true where id=$1", [
    ev.demo,
  ]);
  await as(null);
  eq(
    await scalar("select push_identity_verified from public.calendar_events where id=$1", [
      ev.demo,
    ]),
    false,
    "a signed-in update cannot verify a row",
  );

  console.log(`PASS: ${checks} offline SQL assertions (isolated fixture, no live DB).`);
} finally {
  await db.close();
}
