create or replace view public.account_fire_rollup
with (security_invoker = on) as
select
  a.id            as account_id,
  a.name,
  a.status,
  a.stage,
  a.account_type,
  a.location_id,
  a.assigned_rep,
  a.notes,
  a.updated_at,
  coalesce(l.lead_count, 0)    as lead_count,
  coalesce(l.open_count, 0)    as open_count,
  l.last_loss_date,
  coalesce(l.units_vacated, 0) as units_vacated,
  l.mailing_address,
  c.primary_contact_id,
  c.primary_contact_name,
  c.primary_contact_email,
  c.primary_contact_phone,
  c.primary_contact_gift_policy,
  t.last_touch_at,
  t.last_in_person_at,
  coalesce(t.touch_count, 0)   as touch_count
from public.accounts a
left join lateral (
  select
    count(*)                                                              as lead_count,
    count(*) filter (where fl.status = 'open' and fl.rescind_date is null) as open_count,
    max(fl.incident_date)                                                  as last_loss_date,
    coalesce(sum(fl.units_vacated), 0)                                     as units_vacated,
    (array_remove(array_agg(fl.owner_mailing_address order by fl.incident_date desc nulls last), null))[1] as mailing_address
  from public.fire_leads fl
  where fl.account_id = a.id
) l on true
left join lateral (
  select
    ct.id           as primary_contact_id,
    ct.full_name    as primary_contact_name,
    ct.email        as primary_contact_email,
    ct.phone        as primary_contact_phone,
    ct.gift_policy  as primary_contact_gift_policy
  from public.contacts ct
  where ct.account_id = a.id
  order by ct.is_primary desc, ct.created_at asc
  limit 1
) c on true
left join lateral (
  select
    max(tp.occurred_at)                                                as last_touch_at,
    max(tp.occurred_at) filter (where tp.type = 'meeting_in_person')   as last_in_person_at,
    count(*)                                                           as touch_count
  from public.touchpoints tp
  where tp.account_id = a.id
) t on true;

grant select on public.account_fire_rollup to authenticated;
grant select on public.account_fire_rollup to service_role;