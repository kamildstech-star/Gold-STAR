-- Additive sharing capability. Apply and verify before enabling the new types.
-- No conversation membership or record RLS policy changes.
begin;
alter table public.messages drop constraint if exists messages_shared_record_type_check;
alter table public.messages add constraint messages_shared_record_type_check
  check (shared_record_type is null or shared_record_type in ('lead', 'job', 'account', 'project', 'invoice'));
create or replace function public.chat_shared_record_types()
returns text[] language sql stable security invoker set search_path = ''
as $$ select array['job', 'account', 'project', 'invoice']::text[] $$;
revoke all on function public.chat_shared_record_types() from public, anon;
grant execute on function public.chat_shared_record_types() to authenticated, service_role;
-- A picker is not an authorization boundary. Recheck the referenced row as
-- the caller at the write boundary, including direct API inserts/retargeting.
create or replace function public.guard_message_shared_record()
returns trigger language plpgsql security invoker set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and new.shared_record_type is not distinct from old.shared_record_type
     and new.shared_record_id is not distinct from old.shared_record_id then
    return new;
  end if;
  if new.shared_record_type is null and new.shared_record_id is null then
    return new;
  end if;
  if new.shared_record_type is null or new.shared_record_id is null then
    raise exception 'A shared record requires both a type and an id' using errcode = '23514';
  end if;
  if (case new.shared_record_type
    when 'job' then exists (select 1 from public.jobs where id = new.shared_record_id)
    when 'account' then exists (select 1 from public.accounts where id = new.shared_record_id)
    when 'lead' then exists (select 1 from public.accounts where id = new.shared_record_id)
    when 'project' then exists (select 1 from public.projects where id = new.shared_record_id)
    when 'invoice' then exists (select 1 from public.invoices where id = new.shared_record_id)
    else false end) then
    return new;
  end if;
  raise exception 'The shared record is not accessible' using errcode = '42501';
end;
$$;
revoke all on function public.guard_message_shared_record() from public, anon, authenticated;
drop trigger if exists trg_guard_message_shared_record on public.messages;
create trigger trg_guard_message_shared_record
  before insert or update of shared_record_type, shared_record_id on public.messages
  for each row execute function public.guard_message_shared_record();
commit;
