create or replace function public.dispatch_incident_to_chaser(
  _incident_id uuid,
  _user_id uuid,
  _eta_minutes integer default null,
  _reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  i public.incidents;
  nm text;
begin
  select * into i from public.incidents where id = _incident_id;
  if not found then
    raise exception 'Incident not found';
  end if;

  if not (
    public.is_privileged(auth.uid())
    or (i.location_id is not null and public.can_manage_location(auth.uid(), i.location_id))
  ) then
    raise exception 'Not allowed to dispatch this incident';
  end if;

  insert into public.incident_dispatches (incident_id, user_id, tier, notified_at, response)
  values (_incident_id, _user_id, 1, now(), 'pending')
  on conflict (incident_id, user_id)
  do update set notified_at = now(), response = 'pending', responded_at = null;

  update public.incidents
     set status = case when status = 'new' then 'dispatched'::incident_status else status end,
         dispatched_at = coalesce(dispatched_at, now()),
         updated_at = now()
   where id = _incident_id;

  insert into public.incident_events (incident_id, event_type, actor_id, payload, occurred_at)
  values (
    _incident_id,
    'dispatched',
    auth.uid(),
    jsonb_build_object('assigned_to', _user_id, 'eta_minutes', _eta_minutes, 'reason', _reason),
    now()
  );

  select full_name into nm from public.profiles where user_id = _user_id;

  insert into public.notifications (user_id, type, title, body, entity_type, entity_id, href, priority)
  values (
    _user_id,
    'incident_new',
    'New assignment · ' || initcap(i.incident_type::text),
    coalesce(i.address, 'Incident') || coalesce(', ' || i.locality, '')
      || case when _eta_minutes is not null then ' · ETA ' || _eta_minutes || ' min' else '' end,
    'incident',
    _incident_id,
    '/chase',
    'urgent'
  );

  return jsonb_build_object('ok', true, 'chaser', nm);
end;
$$;

revoke all on function public.dispatch_incident_to_chaser(uuid, uuid, integer, text) from public, anon;
grant execute on function public.dispatch_incident_to_chaser(uuid, uuid, integer, text) to authenticated;