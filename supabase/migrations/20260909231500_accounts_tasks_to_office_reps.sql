-- Give the seeded profiles' accounts and tasks to a real rep in the same office.
--
-- Seven profiles carry no role and no office membership, on
-- @example-demo.invalid addresses with sequential seeded ids: Arden Fisk,
-- Boone Whitaker, Dallas Pryor, Ivo Bergman, Pilar Cortez, Renata Alvarez and
-- Sunny Kaur. Their pay records were moved in 20260909230000; this moves the
-- work they were holding.
--
-- Between them they were the assigned rep on 24 accounts and the assignee on
-- 93 tasks. Because none of them holds a role or an office, none of that work
-- reached anybody: no real person saw those accounts under "Mine", nothing was
-- attributed to an office, and nobody was chased for the tasks.
--
-- Mark, 2026-09-09: "yes do the accounts and tasks by office."
--
-- An account goes to a rep in the account's OWN office, never to whoever
-- inherited the seeded profile's pay records. Sending a Baltimore account to a
-- Houston rep would put it outside its office's reporting and outside the
-- rules that decide who may see it.
--
-- Where an office has more than one candidate, someone selling is preferred
-- over a manager or a director, then by name, so the choice is deterministic
-- rather than incidental. Every office involved resolves to exactly one
-- salesperson under that rule.
--
-- Tasks follow their account rather than being routed separately, which keeps
-- a task and the account it concerns with the same person. 52 of the 93 follow
-- an account being reassigned here; the other 41 sit on accounts a real rep
-- already owned and simply join that owner. All 93 carry an account_id, so
-- none is left unresolved and none is set to nobody.
--
-- Only `assigned_rep` and `assignee` change. Every trigger on these tables
-- that does more than stamp a timestamp is guarded on a stage or status
-- change, so no stage history is written, no ghost snooze is cleared and no
-- automation fires.

WITH seed AS (
  SELECT p.user_id
  FROM public.profiles p
  WHERE p.email LIKE '%example-demo.invalid'
    AND NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.user_id)
    AND NOT EXISTS (SELECT 1 FROM public.location_members lm WHERE lm.user_id = p.user_id)
),
ranked AS (
  SELECT lm.location_id, p.user_id,
         row_number() OVER (
           PARTITION BY lm.location_id
           ORDER BY CASE WHEN EXISTS (
                      SELECT 1 FROM public.user_roles ur
                       WHERE ur.user_id = p.user_id
                         AND ur.role IN ('sales_person','sales_rep','outside_sales_rep','cold_caller')
                    ) THEN 0 ELSE 1 END,
                    p.full_name
         ) AS rn
  FROM public.location_members lm
  JOIN public.profiles p ON p.user_id = lm.user_id
  WHERE EXISTS (
      SELECT 1 FROM public.user_roles ur
       WHERE ur.user_id = p.user_id
         AND ur.role IN ('sales_person','sales_rep','outside_sales_rep','cold_caller','sales_manager','sales_head'))
    AND COALESCE(p.is_active, true)
    AND p.user_id NOT IN (SELECT user_id FROM seed)
),
office_rep AS (SELECT location_id, user_id FROM ranked WHERE rn = 1)
UPDATE public.accounts a
   SET assigned_rep = orp.user_id
  FROM office_rep orp
 WHERE a.location_id = orp.location_id
   AND a.assigned_rep IN (SELECT user_id FROM seed);

-- Second, so it reads the owners just written above.
WITH seed AS (
  SELECT p.user_id
  FROM public.profiles p
  WHERE p.email LIKE '%example-demo.invalid'
    AND NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.user_id)
    AND NOT EXISTS (SELECT 1 FROM public.location_members lm WHERE lm.user_id = p.user_id)
)
UPDATE public.tasks t
   SET assignee = a.assigned_rep
  FROM public.accounts a
 WHERE a.id = t.account_id
   AND t.assignee IN (SELECT user_id FROM seed)
   AND a.assigned_rep IS NOT NULL
   AND a.assigned_rep NOT IN (SELECT user_id FROM seed);
