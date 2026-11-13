insert into public.job_assignments (job_id, user_id, role, is_demo)
select j.id, 'd46260d7-d2fc-4b43-ba4a-c023346b1869', 'account_rep'::job_assignment_role, true
from public.jobs j
where j.is_demo = true
order by j.created_at desc
limit 8
on conflict do nothing;