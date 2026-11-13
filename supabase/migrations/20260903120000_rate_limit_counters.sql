-- Rate-limit counters.
--
-- The app runs on Cloudflare Workers. Module-scope state there is per-isolate
-- and per-region, so a counter kept in memory is thrown away whenever an
-- isolate recycles and is invisible to every other isolate serving the same
-- attacker. There is no KV namespace and no Durable Object binding on this
-- worker (see .output/server/wrangler.json — the only binding is ASSETS), so
-- Postgres is the only store that actually counts. One indexed upsert per
-- limited request.
--
-- Mirrors src/lib/rate-limit.ts exactly. If one changes, change both.

create table if not exists public.rate_limit_counters (
  -- What is being limited: 'signin:email', 'signin:ip', 'hook:ip', ...
  bucket text not null,
  -- Who is being limited. Never a plaintext email or IP: the app stores a
  -- SHA-256 of it, so this table is not a second copy of who signs in from
  -- where. See identityHash() in src/lib/rate-limit.server.ts.
  identity text not null,
  window_started_at timestamptz not null default now(),
  attempts integer not null default 0,
  -- Set when the limit was breached and the identity is serving a lockout that
  -- outlasts the window.
  blocked_until timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (bucket, identity)
);

create index if not exists rate_limit_counters_last_seen_idx
  on public.rate_limit_counters (last_seen_at);

-- A limiter a user can read or clear is not a limiter. RLS is on with NO
-- policies, which denies anon and authenticated everything; only the service
-- role (which bypasses RLS, and is server-only) may touch it. The revoke is
-- belt and braces so PostgREST will not expose the table even if a policy is
-- added here by mistake later.
alter table public.rate_limit_counters enable row level security;
revoke all on public.rate_limit_counters from anon, authenticated;

comment on table public.rate_limit_counters is
  'Server-side rate-limit buckets. Service role only - deliberately unreadable and undeletable by the users being counted.';

/*
 * Records one attempt and decides in a single round trip.
 *
 * SECURITY INVOKER on purpose. These run as the service role, which bypasses
 * RLS anyway; leaving them as invoker means that if EXECUTE is ever granted to
 * `authenticated` by accident, RLS still refuses the write instead of a
 * definer function cheerfully clearing the caller's own counter.
 *
 * An identity already serving a lockout is refused without its counter moving.
 * Extending the block on every probe would let a hammering attacker hold the
 * real user out forever - which is the denial of service the limiter exists to
 * prevent.
 */
create or replace function public.consume_rate_limit(
  p_bucket text,
  p_identity text,
  p_limit integer,
  p_window_seconds integer,
  p_block_seconds integer default 0
)
returns table (allowed boolean, attempt_count integer, retry_after_seconds integer)
language plpgsql
as $$
declare
  v_now timestamptz := now();
  v_row public.rate_limit_counters%rowtype;
begin
  insert into public.rate_limit_counters as c
    (bucket, identity, window_started_at, attempts, blocked_until, first_seen_at, last_seen_at)
  values (p_bucket, p_identity, v_now, 1, null, v_now, v_now)
  on conflict (bucket, identity) do update set
    window_started_at = case
      when c.blocked_until is not null and c.blocked_until > v_now then c.window_started_at
      when c.window_started_at + make_interval(secs => p_window_seconds) <= v_now then v_now
      else c.window_started_at
    end,
    attempts = case
      when c.blocked_until is not null and c.blocked_until > v_now then c.attempts
      when c.window_started_at + make_interval(secs => p_window_seconds) <= v_now then 1
      else c.attempts + 1
    end,
    blocked_until = case
      when c.blocked_until is not null and c.blocked_until > v_now then c.blocked_until
      when p_block_seconds > 0
        and (case
               when c.window_started_at + make_interval(secs => p_window_seconds) <= v_now then 1
               else c.attempts + 1
             end) > p_limit
        then v_now + make_interval(secs => p_block_seconds)
      else null
    end,
    last_seen_at = v_now
  returning c.* into v_row;

  if v_row.blocked_until is not null and v_row.blocked_until > v_now then
    allowed := false;
    retry_after_seconds := greatest(1, ceil(extract(epoch from (v_row.blocked_until - v_now)))::integer);
  elsif v_row.attempts <= p_limit then
    allowed := true;
    retry_after_seconds := 0;
  else
    allowed := false;
    retry_after_seconds := greatest(1, ceil(extract(epoch from (
      v_row.window_started_at + make_interval(secs => p_window_seconds) - v_now
    )))::integer);
  end if;

  attempt_count := v_row.attempts;
  return next;
end;
$$;

/*
 * Reads the current verdict without spending an attempt. Used before a sign-in
 * so a locked-out person is told to wait rather than burning a Supabase Auth
 * request to be told nothing.
 */
create or replace function public.peek_rate_limit(
  p_bucket text,
  p_identity text,
  p_limit integer,
  p_window_seconds integer
)
returns table (allowed boolean, attempt_count integer, retry_after_seconds integer)
language plpgsql
stable
as $$
declare
  v_now timestamptz := now();
  v_row public.rate_limit_counters%rowtype;
begin
  select * into v_row from public.rate_limit_counters
    where bucket = p_bucket and identity = p_identity;

  if not found or v_row.window_started_at + make_interval(secs => p_window_seconds) <= v_now then
    if v_row.blocked_until is null or v_row.blocked_until <= v_now then
      allowed := true; attempt_count := 0; retry_after_seconds := 0;
      return next;
      return;
    end if;
  end if;

  if v_row.blocked_until is not null and v_row.blocked_until > v_now then
    allowed := false;
    retry_after_seconds := greatest(1, ceil(extract(epoch from (v_row.blocked_until - v_now)))::integer);
  elsif v_row.attempts < p_limit then
    allowed := true;
    retry_after_seconds := 0;
  else
    allowed := false;
    retry_after_seconds := greatest(1, ceil(extract(epoch from (
      v_row.window_started_at + make_interval(secs => p_window_seconds) - v_now
    )))::integer);
  end if;

  attempt_count := v_row.attempts;
  return next;
end;
$$;

-- Called after a sign-in succeeds. A person who finally remembers their
-- password must not stay one typo away from a lockout for the rest of the hour.
create or replace function public.reset_rate_limit(p_bucket text, p_identity text)
returns void
language sql
as $$
  delete from public.rate_limit_counters where bucket = p_bucket and identity = p_identity;
$$;

-- Cleanup. A bucket nobody has touched for a day is spent: its window closed
-- and any lockout expired long ago, so the row only carries storage.
create or replace function public.cleanup_rate_limit_counters()
returns integer
language plpgsql
as $$
declare
  v_deleted integer;
begin
  delete from public.rate_limit_counters
   where last_seen_at < now() - interval '1 day'
     and (blocked_until is null or blocked_until < now());
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

-- Postgres grants EXECUTE on new functions to PUBLIC by default, which would
-- hand every signed-in user the ability to inflate or clear a counter.
revoke all on function public.consume_rate_limit(text, text, integer, integer, integer)
  from public, anon, authenticated;
revoke all on function public.peek_rate_limit(text, text, integer, integer)
  from public, anon, authenticated;
revoke all on function public.reset_rate_limit(text, text)
  from public, anon, authenticated;
revoke all on function public.cleanup_rate_limit_counters()
  from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('cleanup-rate-limit-counters');
  end if;
exception
  when others then null; -- no such job yet; scheduling below is the point
end;
$$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'cleanup-rate-limit-counters',
      '17 4 * * *',
      $cron$select public.cleanup_rate_limit_counters();$cron$
    );
  end if;
end;
$$;

-- Security event trail.
--
-- The counters above are ephemeral by design - a bucket is gone a day after
-- its last attempt. The things worth keeping are the moments: an account that
-- got locked out, and an administrator who reset somebody's second factor.
-- Those are the two questions an IT reviewer actually asks after an incident,
-- and neither is answerable from a table that self-cleans nightly.
create table if not exists public.security_events (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default now(),
  -- 'signin_lockout' | 'mfa_reset' | 'mfa_enrolled' | 'mfa_removed'
  event_type text not null,
  -- Whoever performed the action. Null for events with no signed-in actor,
  -- such as a lockout triggered by an attacker.
  actor_id uuid references auth.users(id) on delete set null,
  -- Whose account the event is about.
  subject_id uuid references auth.users(id) on delete set null,
  subject_email text,
  details jsonb not null default '{}'::jsonb
);

create index if not exists security_events_occurred_idx
  on public.security_events (occurred_at desc);
create index if not exists security_events_subject_idx
  on public.security_events (subject_id, occurred_at desc);

alter table public.security_events enable row level security;

-- Read-only, and only for the people who run the company. Nobody writes
-- through PostgREST: rows come from server code holding the service role, so
-- the subject of an event can never edit or delete their own trail.
drop policy if exists security_events_select on public.security_events;
create policy security_events_select on public.security_events for select to authenticated
  using (public.is_privileged((select auth.uid())));
