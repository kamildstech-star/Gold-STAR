
do $$
declare u uuid; ids uuid[]; off int := 0;
begin
  for u in select user_id from profiles where coalesce(is_demo,false)=false
           and email in ('mark@falconmarketing.com','mark+salesrep@falconmarketing.com','mark+salesmgr@falconmarketing.com','mark+owner@falconmarketing.com')
  loop
    select array_agg(id) into ids from (
      select id from accounts where coalesce(is_demo,false)=true order by created_at offset off limit 6
    ) s;
    if ids is not null then
      update accounts set assigned_rep = u where id = any(ids);
    end if;
    off := off + 6;
  end loop;
end $$;

update touchpoints t
set lat = 40.6782 + (random()-0.5)*0.18,
    lon = -73.9442 + (random()-0.5)*0.22,
    place_label = coalesce(a.name, 'Field visit')
from accounts a
where t.account_id = a.id
  and t.lat is null
  and t.occurred_at > now() - interval '21 days';

insert into tradeshows (location_id, name, city, state, starts_on, ends_on, cost, leads_captured, notes, is_demo)
select l.id, v.name, v.city, v.state, v.starts_on, v.ends_on, v.cost, v.leads, v.notes, true
from (select id from locations order by created_at limit 1) l,
(values
  ('Restoration Industry Association Convention','Orlando','FL',current_date - 45,current_date - 42,18500,64,'Booth 214 — strong adjuster traffic.'),
  ('PLRB Claims Conference','Indianapolis','IN',current_date - 18,current_date - 15,24000,91,'Carrier-heavy. Best ROI this year.'),
  ('IICRC Restoration Expo','Las Vegas','NV',current_date + 26,current_date + 29,21000,0,'Booked, materials pending.'),
  ('Property Managers Northeast Summit','Brooklyn','NY',current_date + 61,current_date + 62,7800,0,'Local — walkable for the whole NY team.')
) as v(name,city,state,starts_on,ends_on,cost,leads,notes)
where not exists (select 1 from tradeshows where coalesce(is_demo,false)=true);

update incidents set lifecycle = 'live', status = 'new', reported_at = now() - (random()*interval '6 hours'),
  accepted_by = null, accepted_at = null, arrived_at = null, outcome = null
where id in (select id from incidents where coalesce(is_demo,false)=true order by reported_at desc limit 4);
