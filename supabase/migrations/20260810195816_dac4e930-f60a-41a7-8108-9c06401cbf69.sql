insert into public.option_lists (key, label, description, allow_location_scope)
values ('activity_type', 'Activity type', 'Kinds of activity a rep can schedule on a record.', false)
on conflict (key) do nothing;

insert into public.option_list_values (list_id, key, label, sort_order, is_default, metadata)
select l.id, v.key, v.label, v.sort_order, v.is_default, jsonb_build_object('icon', v.icon)
from public.option_lists l,
  (values
    ('call','Call',10,true,'phone'),
    ('meeting','Meeting',20,false,'users'),
    ('deadline','Deadline',30,false,'flag'),
    ('email','Email',40,false,'mail'),
    ('task','Task',50,false,'check'),
    ('site_visit','Site visit',60,false,'map-pin')
  ) as v(key,label,sort_order,is_default,icon)
where l.key = 'activity_type'
on conflict do nothing;

alter table public.tasks
  add column if not exists activity_type_id uuid references public.option_list_values(id) on delete set null;