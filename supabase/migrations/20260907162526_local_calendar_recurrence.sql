-- Local series only. Outlook series synchronization is deliberately not enabled.
begin;
alter table public.calendar_events
  add column if not exists recurrence jsonb,
  add column if not exists recurrence_master_id uuid references public.calendar_events(id),
  add column if not exists recurrence_index integer;
create unique index if not exists calendar_local_occurrence_idx
  on public.calendar_events(recurrence_master_id, recurrence_index);
create index if not exists calendar_local_series_idx
  on public.calendar_events(starts_at) where recurrence is not null;

create or replace function public.guard_local_calendar_series()
returns trigger language plpgsql security invoker set search_path = ''
as $$
declare
  master public.calendar_events;
  rule jsonb;
  first_date date;
  ending date;
begin
  if new.recurrence is null and new.recurrence_master_id is null then
    if new.recurrence_index is not null then
      raise exception 'A local recurring event requires a series';
    end if;
    if tg_op = 'UPDATE' and (old.recurrence is not null or old.recurrence_master_id is not null) then
      raise exception 'Recurring events cannot be converted to independent events';
    end if;
    return new;
  end if;
  if tg_op = 'UPDATE' then new.created_by := old.created_by; end if;
  if new.provider is not null or new.external_id is not null
     or new.sync_direction is distinct from 'local' or new.sync_state is distinct from 'clean'
     or coalesce(jsonb_array_length(new.attendees), 0) <> 0 then
    raise exception 'Recurring events are local only and cannot include Outlook attendees';
  end if;
  if new.starts_at is null or new.ends_at is null or new.ends_at <= new.starts_at then
    raise exception 'Recurring events require an end after the start';
  end if;
  if new.recurrence_master_id is not null then
    if new.recurrence is not null or new.recurrence_index is null
       or new.recurrence_index < 0 or new.recurrence_index >= 10000
       or new.recurrence_master_id = new.id then
      raise exception 'Invalid recurrence occurrence';
    end if;
    select * into master from public.calendar_events where id = new.recurrence_master_id;
    if not found or master.recurrence is null or master.is_cancelled
       or new.user_id is distinct from master.user_id
       or new.location_id is distinct from master.location_id
       or new.event_type is distinct from master.event_type
       or new.account_id is distinct from master.account_id
       or new.contact_id is distinct from master.contact_id
       or new.job_id is distinct from master.job_id then
      raise exception 'The recurring series is not accessible or active' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.recurrence_index is not null then raise exception 'A series cannot have an occurrence index'; end if;
  if tg_op = 'UPDATE' and old.recurrence is not null and (
    new.user_id is distinct from old.user_id or new.location_id is distinct from old.location_id
    or new.event_type is distinct from old.event_type or new.account_id is distinct from old.account_id
    or new.contact_id is distinct from old.contact_id or new.job_id is distinct from old.job_id
  ) then raise exception 'Create a new series to change its owner, office, type, or linked records'; end if;
  rule := new.recurrence;
  if jsonb_typeof(rule) <> 'object'
     or coalesce(rule->>'frequency', '') not in ('daily', 'weekly', 'monthly')
     or coalesce(rule->>'interval', '') !~ '^[0-9]+$'
     or (rule->>'interval')::integer not between 1 and 52
     or coalesce(rule->>'timeZone', '') = '' then
    raise exception 'Invalid recurrence rule';
  end if;
  -- PostgreSQL validates the timezone name, independently of browser validation.
  first_date := (new.starts_at at time zone (rule->>'timeZone'))::date;
  if (rule ? 'count') = (rule ? 'until') then raise exception 'Choose a recurrence count or end date'; end if;
  if rule ? 'count' then
    if coalesce(rule->>'count', '') !~ '^[0-9]+$'
       or (rule->>'count')::integer not between 1 and 366 then
      raise exception 'A series must contain between 1 and 366 occurrences';
    end if;
  else
    if coalesce(rule->>'until', '') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Invalid recurrence end date'; end if;
    ending := (rule->>'until')::date;
    if ending < first_date or ending > first_date + 1830 then raise exception 'Series end must be within five years of its start'; end if;
  end if;
  return new;
end;
$$;
revoke all on function public.guard_local_calendar_series() from public, anon, authenticated;
drop trigger if exists trg_guard_local_calendar_series on public.calendar_events;
create trigger trg_guard_local_calendar_series before insert or update on public.calendar_events
  for each row execute function public.guard_local_calendar_series();

create or replace function public.calendar_local_recurrence_available()
returns boolean language sql stable security invoker set search_path = '' as $$ select true $$;
revoke all on function public.calendar_local_recurrence_available() from public, anon;
grant execute on function public.calendar_local_recurrence_available() to authenticated, service_role;
commit;
