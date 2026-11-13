// Offline migration regression harness; never connects to a remote database.
// node supabase/tests/calendar-intake-security.pglite.mjs
// Optional isolated dependency: set AUDIT_SQL_RUNTIME to its install directory.
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
const actor = "11111111-1111-4111-8111-111111111111";
const victim = "22222222-2222-4222-8222-222222222222";
const office = "33333333-3333-4333-8333-333333333333";
const mailbox = "44444444-4444-4444-8444-444444444444";
const event = "55555555-5555-4555-8555-555555555555";
const legacy = "66666666-6666-4666-8666-666666666666";
let checks = 0;
async function denied(sql, params = []) {
  await assert.rejects(db.query(sql, params));
  checks++;
}
async function scalar(sql, params = []) {
  return Object.values((await db.query(sql, params)).rows[0])[0];
}
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
    create table public.graph_mailboxes(id uuid primary key, upn text, user_id uuid, location_id uuid, enabled boolean, sync_calendar boolean);
    create table public.calendar_events(id uuid primary key, provider text, external_id text, mailbox_id uuid,
      organizer_email text, user_id uuid, location_id uuid, created_by uuid, sync_state text, subject text);
    create table public.intake_requests(id uuid primary key, token text unique, job_id uuid,
      location_id uuid, tradeshow_id uuid, revoked_at timestamptz, expires_at timestamptz,
      submitted_at timestamptz, multi_use boolean default false);
    create table public.intake_submissions(id uuid primary key default gen_random_uuid(), request_id uuid,
      job_id uuid, submitted_by_name text, submitted_by_email text,
      fields jsonb check (fields->>'fail' is distinct from 'true'), answers jsonb, status text,
      location_id uuid, location_auto_assigned boolean, photos jsonb);
    grant all on all tables in schema public to service_role;
    grant select, insert, update on public.calendar_events to authenticated;
    insert into public.profiles values ('${actor}',true,'approved'),('${victim}',true,'approved');
    insert into public.graph_mailboxes values ('${mailbox}','own@example.com','${actor}',null,true,true);
    insert into public.calendar_events(id,provider,external_id,mailbox_id,user_id,sync_state)
      values('${legacy}','outlook','untrusted','${mailbox}','${actor}','pending_push');
  `);
  for (const file of [
    "20260908012000_calendar_push_integrity.sql",
    "20260908012100_atomic_public_intake.sql",
  ])
    await db.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  await db.query("select set_config('test.actor', $1, false)", [actor]);
  await db.exec("set role authenticated");
  await denied(
    `insert into public.calendar_events(id,provider,external_id,user_id) values('${event}','outlook','forged','${actor}')`,
  );
  await db.query(
    `insert into public.calendar_events(id,user_id,created_by,sync_state,push_actor_id)
    values($1,$2,$3,'pending_push',$3)`,
    [event, actor, victim],
  );
  assert.equal(
    await scalar("select push_actor_id from public.calendar_events where id=$1", [event]),
    actor,
  );
  checks++;
  assert.equal(
    await scalar("select created_by from public.calendar_events where id=$1", [event]),
    actor,
  );
  checks++;
  for (const [column, value] of Object.entries({
    provider: "outlook",
    external_id: "forged",
    mailbox_id: mailbox,
    organizer_email: "boss@example.com",
    user_id: victim,
    location_id: office,
    created_by: victim,
  }))
    await denied(`update public.calendar_events set ${column}=$1 where id=$2`, [value, event]);
  await db.query(
    "update public.calendar_events set push_actor_id=$1, push_identity_verified=false where id=$2",
    [victim, event],
  );
  assert.equal(
    await scalar("select push_actor_id from public.calendar_events where id=$1", [event]),
    actor,
  );
  checks++;
  assert.equal(
    await scalar("select push_identity_verified from public.calendar_events where id=$1", [event]),
    true,
  );
  checks++;
  await db.query("update public.calendar_events set push_identity_verified=true where id=$1", [
    legacy,
  ]);
  assert.equal(
    await scalar("select push_identity_verified from public.calendar_events where id=$1", [legacy]),
    false,
  );
  checks++;
  await denied("select public.calendar_push_authorized_event($1)", [event]);
  await denied("select public.submit_public_intake_atomic('x',$1,'{}')", [event]);
  await db.exec("set role service_role");
  assert.equal(
    (await scalar("select public.calendar_push_authorized_event($1)", [event])).mailbox.id,
    mailbox,
  );
  checks++;
  await denied("select public.calendar_push_authorized_event($1)", [legacy]);
  await db.query("update public.graph_mailboxes set user_id=$1,location_id=$2 where id=$3", [
    victim,
    office,
    mailbox,
  ]);
  await db.query("update public.calendar_events set mailbox_id=$1 where id=$2", [mailbox, event]);
  await db.query("insert into public.test_managers values($1,$2)", [actor, office]);
  await denied("select public.calendar_push_authorized_event($1)", [event]);
  await db.query("update public.graph_mailboxes set user_id=null where id=$1", [mailbox]);
  assert.equal(
    (await scalar("select public.calendar_push_authorized_event($1)", [event])).mailbox.id,
    mailbox,
  );
  checks++;
  await db.query("update public.graph_mailboxes set enabled=false where id=$1", [mailbox]);
  await denied("select public.calendar_push_authorized_event($1)", [event]);
  await db.query("update public.graph_mailboxes set enabled=true where id=$1", [mailbox]);
  await db.query("update public.profiles set is_active=false where user_id=$1", [actor]);
  await denied("select public.calendar_push_authorized_event($1)", [event]);
  await db.query("update public.profiles set is_active=true where user_id=$1", [actor]);
  // Approval is checked directly, even if role/location helpers still grant
  // access. Neither revoked approval nor a missing status may authorize push.
  for (const status of ["pending", "rejected", "revoked", null]) {
    await db.query("update public.profiles set approval_status=$1 where user_id=$2", [
      status,
      actor,
    ]);
    await denied("select public.calendar_push_authorized_event($1)", [event]);
  }
  await db.query("update public.profiles set approval_status='approved' where user_id=$1", [actor]);
  assert.equal(
    (await scalar("select public.calendar_push_authorized_event($1)", [event])).mailbox.id,
    mailbox,
  );
  checks++;
  await db.exec(
    "reset role; alter table public.calendar_events disable trigger z_guard_calendar_push_identity; set role service_role",
  );
  await denied("select public.calendar_push_authorized_event($1)", [event]);
  await db.exec(
    "reset role; alter table public.calendar_events enable trigger z_guard_calendar_push_identity; set role service_role",
  );
  // A same-name, enabled trigger attached to the wrong function is not proof
  // that the identity guard is installed.
  await db.exec(`reset role;
    create function public.test_noop_guard() returns trigger language plpgsql as $$ begin return new; end $$;
    drop trigger z_guard_calendar_push_identity on public.calendar_events;
    create trigger z_guard_calendar_push_identity before insert or update on public.calendar_events
      for each row execute function public.test_noop_guard();
    set role service_role;`);
  await denied("select public.calendar_push_authorized_event($1)", [event]);
  await db.exec(`reset role;
    drop trigger z_guard_calendar_push_identity on public.calendar_events;
    create trigger z_guard_calendar_push_identity before insert or update on public.calendar_events
      for each row execute function public.guard_calendar_push_identity();
    set role service_role;`);

  const req = event;
  await db.query(
    "insert into public.intake_requests(id,token,expires_at) values($1,'one',now()+interval '1 hour')",
    [req],
  );
  const submit = (body = {}) =>
    scalar("select public.submit_public_intake_atomic('one',$1,$2)", [req, JSON.stringify(body)]);
  await assert.rejects(submit({ fields: { fail: true } }));
  checks++;
  assert.equal(
    await scalar("select submitted_at from public.intake_requests where id=$1", [req]),
    null,
  );
  checks++;
  // PGlite serializes connections. This exercises competing invocations but
  // does not replace a two-connection Postgres lock test before deployment.
  const competing = await Promise.allSettled([submit(), submit()]);
  assert.equal(competing.filter((x) => x.status === "fulfilled").length, 1);
  checks++;
  assert.equal(
    await scalar("select count(*)::int from public.intake_submissions where request_id=$1", [req]),
    1,
  );
  checks++;
  await db.query("update public.intake_requests set multi_use=true,submitted_at=null where id=$1", [
    req,
  ]);
  await submit();
  await submit();
  assert.equal(
    await scalar("select submitted_at from public.intake_requests where id=$1", [req]),
    null,
  );
  checks++;
  await db.query("update public.intake_requests set revoked_at=now() where id=$1", [req]);
  await assert.rejects(submit());
  checks++;
  await db.query(
    "update public.intake_requests set revoked_at=null,expires_at=now()-interval '1 second' where id=$1",
    [req],
  );
  await assert.rejects(submit());
  checks++;
  await db.exec("set role anon");
  await denied("select public.calendar_push_authorized_event($1)", [event]);
  await denied("select public.submit_public_intake_atomic('one',$1,'{}')", [req]);
  console.log(`PASS: ${checks} offline SQL assertions (isolated fixture, no live DB).`);
} finally {
  await db.close();
}
