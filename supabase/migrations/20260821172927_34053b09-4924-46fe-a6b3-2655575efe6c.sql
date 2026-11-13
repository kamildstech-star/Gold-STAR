create type public.page_review_status as enum ('unreviewed','in_review','approved');

create table public.page_reviews (
  page_key    text primary key,
  status      public.page_review_status not null default 'unreviewed',
  note        text,
  updated_by  uuid references public.profiles(user_id) on delete set null,
  updated_at  timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

grant select, insert, update, delete on public.page_reviews to authenticated;
grant all on public.page_reviews to service_role;

alter table public.page_reviews enable row level security;

create policy "Signed-in users can read page reviews"
  on public.page_reviews for select to authenticated using (true);

create policy "Privileged users can insert page reviews"
  on public.page_reviews for insert to authenticated
  with check (public.is_privileged(auth.uid()));

create policy "Privileged users can update page reviews"
  on public.page_reviews for update to authenticated
  using (public.is_privileged(auth.uid()))
  with check (public.is_privileged(auth.uid()));

create policy "Privileged users can delete page reviews"
  on public.page_reviews for delete to authenticated
  using (public.is_privileged(auth.uid()));

create trigger update_page_reviews_updated_at
  before update on public.page_reviews
  for each row execute function public.update_updated_at_column();

create or replace function public.log_page_review_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old public.page_review_status;
begin
  v_old := case when tg_op = 'UPDATE' then old.status else null end;
  if tg_op = 'UPDATE' and old.status is not distinct from new.status then
    return new;
  end if;
  insert into public.activity_log (
    module, event_type, actor_id, via, summary, detail,
    record_type, record_label
  ) values (
    'page_review',
    'status_changed',
    coalesce(new.updated_by, auth.uid()),
    'user',
    'Page "' || new.page_key || '" review status ' ||
      coalesce(v_old::text || ' → ', 'set to ') || new.status::text,
    jsonb_build_object(
      'page_key', new.page_key,
      'before', v_old,
      'after', new.status,
      'note', new.note
    ),
    'page_review',
    new.page_key
  );
  return new;
end;
$$;

create trigger log_page_review_activity_trg
  after insert or update on public.page_reviews
  for each row execute function public.log_page_review_activity();