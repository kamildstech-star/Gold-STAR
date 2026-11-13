// Offline regression for the Ready -> Active Outreach configuration migration.
// node supabase/tests/melly-pipeline-behavior.pglite.mjs <pglite entry>
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
const migration = readFileSync(
  new URL("../migrations/20260908183307_advance_ready_on_first_call.sql", import.meta.url),
  "utf8",
);
const projectionMigration = readFileSync(
  new URL(
    "../migrations/20260908183627_exclude_active_clients_from_pipeline_projection.sql",
    import.meta.url,
  ),
  "utf8",
);
const reversionMigration = readFileSync(
  new URL(
    "../migrations/20260908185502_move_account_back_to_pipeline_atomically.sql",
    import.meta.url,
  ),
  "utf8",
);

try {
  await db.exec(`
    create role authenticated;
    create role anon;
    create role service_role bypassrls;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create table public.profiles (
      user_id uuid primary key,
      is_active boolean not null,
      approval_status text not null,
      deactivated_at timestamptz
    );
    insert into profiles values
      ('99999999-9999-4999-8999-999999999999', true, 'approved', null),
      ('77777777-7777-4777-8777-777777777777', false, 'approved', now());
    create table public.pipelines (
      id uuid primary key,
      entity_type text not null,
      is_active boolean not null
    );
    create table public.pipeline_stages (
      id uuid primary key,
      pipeline_id uuid not null references public.pipelines(id),
      key text not null,
      name text,
      is_active boolean not null,
      is_won boolean not null default false,
      auto_advance boolean not null default false,
      advance_match text,
      advance_min_count integer,
      advance_to_stage_id uuid,
      advance_conditions jsonb
    );
    create table public.locations (
      id uuid primary key,
      code text not null,
      name text not null
    );
    create type public.account_status as enum ('prospect', 'onboarding', 'active');
    create table public.accounts (
      id uuid primary key,
      name text not null,
      location_id uuid not null references locations(id),
      stage_id uuid references pipeline_stages(id),
      status public.account_status,
      health_stage_id uuid,
      health_pipeline_id uuid,
      health_changed_at timestamptz,
      lost_reason text,
      archived_at timestamptz,
      created_by uuid,
      assigned_rep uuid
    );
    create function public.can_view_location(uuid, uuid) returns boolean
      language sql stable as $$ select false $$;
    create table public.account_stage_history (
      account_id uuid not null,
      from_stage_id uuid,
      to_stage_id uuid,
      reason text
    );
    create function public.capture_stage_history() returns trigger
      language plpgsql security definer set search_path = '' as $$
      begin
        if old.stage_id is distinct from new.stage_id then
          insert into public.account_stage_history values
            (new.id, old.stage_id, new.stage_id, new.lost_reason);
        end if;
        return new;
      end $$;
    create trigger accounts_stage_history after update on public.accounts
      for each row execute function public.capture_stage_history();
    grant select on public.pipelines, public.pipeline_stages, public.accounts to authenticated;
    grant update on public.accounts to authenticated;

    insert into pipelines values
      ('11111111-1111-4111-8111-111111111111', 'account', true),
      ('22222222-2222-4222-8222-222222222222', 'job', true);
    insert into pipeline_stages (id,pipeline_id,key,name,is_active) values
      ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1','11111111-1111-4111-8111-111111111111','ready','Ready',true),
      ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2','11111111-1111-4111-8111-111111111111','active_outreach','Active Outreach',true),
      ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1','22222222-2222-4222-8222-222222222222','ready','Ready',true),
      ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2','22222222-2222-4222-8222-222222222222','active_outreach','Active Outreach',true);
    update pipeline_stages
       set auto_advance=false
     where id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';

    insert into locations values
      ('33333333-3333-4333-8333-333333333333','NY','New York');
    insert into accounts values
      ('44444444-4444-4444-8444-444444444441','Open prospect','33333333-3333-4333-8333-333333333333','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1','prospect',null,null,null,null,null,'88888888-8888-4888-8888-888888888888','88888888-8888-4888-8888-888888888888'),
      ('44444444-4444-4444-8444-444444444442','Active on Ready','33333333-3333-4333-8333-333333333333','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1','active',null,null,null,null,null,'88888888-8888-4888-8888-888888888888','88888888-8888-4888-8888-888888888888'),
      ('44444444-4444-4444-8444-444444444443','Health client','33333333-3333-4333-8333-333333333333','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2','active','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2','11111111-1111-4111-8111-111111111111',now(),null,null,'99999999-9999-4999-8999-999999999999','99999999-9999-4999-8999-999999999999');
    insert into accounts values
      ('44444444-4444-4444-8444-444444444444','Unassigned prospect','33333333-3333-4333-8333-333333333333','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1','prospect',null,null,null,null,null,null,null);
  `);

  await db.exec(migration);
  await db.exec(migration); // idempotent

  const configured = await db.query(`
    select auto_advance, advance_match, advance_min_count,
           advance_to_stage_id::text as target,
           advance_conditions
      from pipeline_stages
     where id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
  `);
  assert.deepEqual(configured.rows[0], {
    auto_advance: true,
    advance_match: "all",
    advance_min_count: 1,
    target: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
    advance_conditions: [{ kind: "call_logged", min_count: 1 }],
  });

  const jobReady = await db.query(
    "select auto_advance from pipeline_stages where id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'",
  );
  assert.equal(jobReady.rows[0].auto_advance, false, "job pipelines are not changed");

  await db.exec(projectionMigration);
  await db.exec(reversionMigration);
  await db.exec(
    "set role authenticated; set request.jwt.claim.sub='99999999-9999-4999-8999-999999999999'",
  );
  const visible = await db.query(
    "select account_name from pipeline_cards_minimal() order by account_name",
  );
  assert.deepEqual(visible.rows, [
    { account_name: "Open prospect" },
    { account_name: "Unassigned prospect" },
  ]);
  await db.exec("set request.jwt.claim.sub='77777777-7777-4777-8777-777777777777'");
  const deactivatedVisible = await db.query("select * from pipeline_cards_minimal()");
  assert.deepEqual(deactivatedVisible.rows, [], "deactivated users cannot read the projection");
  await db.exec("set request.jwt.claim.sub='99999999-9999-4999-8999-999999999999'");
  await db.query(`select move_account_back_to_pipeline(
    '44444444-4444-4444-8444-444444444443',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    'Moved back to pipeline — Relationship reset'
  )`);
  await db.exec("reset role");
  const reverted = await db.query(`select stage_id::text, status, health_stage_id,
    health_pipeline_id, health_changed_at, lost_reason from accounts
    where id='44444444-4444-4444-8444-444444444443'`);
  assert.deepEqual(reverted.rows[0], {
    stage_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
    status: "prospect",
    health_stage_id: null,
    health_pipeline_id: null,
    health_changed_at: null,
    lost_reason: null,
  });
  const history = await db.query(`select reason from account_stage_history
    where account_id='44444444-4444-4444-8444-444444444443'`);
  assert.deepEqual(history.rows, [{ reason: "Moved back to pipeline — Relationship reset" }]);
  console.log("8 Melly pipeline behavior checks passed (in-memory fixture; not deployed).");
} finally {
  await db.close();
}
