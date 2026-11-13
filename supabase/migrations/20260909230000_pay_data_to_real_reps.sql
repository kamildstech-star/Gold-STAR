-- Point the seeded pay and commission records at real sales reps.
--
-- Every pay structure, commission plan and commission payout in the database
-- belonged to five profiles that have no role and no office: Arden Fisk, Ivo
-- Bergman, Pilar Cortez, Renata Alvarez and Sunny Kaur, all on
-- @example-demo.invalid addresses with sequential seeded ids.
--
-- director_rep_cost only reports on people who hold a sales role AND belong to
-- an office, so those five could never appear in it. The result was a Rep's
-- cost card where revenue belonged to the real reps and every pay figure
-- belonged to people the report cannot see, so the two halves described
-- completely separate groups and the cost-of-revenue ratio meant nothing.
--
-- Mark, 2026-09-09: "those 5 are leftover seed data, point them at the actual
-- reps."
--
-- The mapping pairs each seeded profile, in name order, with a rep who already
-- has revenue in the reporting window, ordered by that revenue and then by
-- name. The pairing is arbitrary because the seed data carries no real
-- association, but it is deterministic and written down, so it can be read
-- back or reversed. What matters is that pay and revenue now land on the same
-- rows and the ratio has meaning.
--
-- Scope is deliberately the pay records only. These same five profiles also
-- hold 17 accounts as assigned rep, 75 tasks, 10 goals and 9 expenses.
-- Reassigning those changes who owns work in the pipeline and who is chased
-- for it, which is a larger and more visible decision than fixing a cost
-- report, so it is left alone and raised separately.

WITH mapping(seed_id, real_id) AS (
  VALUES
    -- Arden Fisk      -> Test Sales Rep MD (Baltimore)
    ('d0000001-0000-4000-8000-000000000007'::uuid, 'd3fb44f8-5998-4371-8643-b3ddadb12009'::uuid),
    -- Ivo Bergman     -> Test Sales Rep TX (Houston)
    ('d0000001-0000-4000-8000-000000000002'::uuid, '80cf1e9c-5155-47cb-8dfc-0dfa50e65aad'::uuid),
    -- Pilar Cortez    -> Test Sales Rep CA (Los Angeles)
    ('d0000001-0000-4000-8000-000000000005'::uuid, 'bee2a035-2c59-41b0-b2bf-e598a671e040'::uuid),
    -- Renata Alvarez  -> Test Sales Rep IL (Skokie)
    ('d0000001-0000-4000-8000-000000000001'::uuid, '0658c273-497b-4658-a90d-dae925940485'::uuid),
    -- Sunny Kaur      -> Test Sales Rep NC (Garner)
    ('d0000001-0000-4000-8000-000000000003'::uuid, 'c425adee-5229-424c-bc9b-8e10e26bf4c8'::uuid)
),
moved_pay AS (
  UPDATE public.pay_structures ps SET user_id = m.real_id
  FROM mapping m WHERE ps.user_id = m.seed_id
  RETURNING 1
),
moved_plans AS (
  UPDATE public.commission_plans cp SET user_id = m.real_id
  FROM mapping m WHERE cp.user_id = m.seed_id
  RETURNING 1
),
moved_payouts AS (
  UPDATE public.commission_payouts cp SET user_id = m.real_id
  FROM mapping m WHERE cp.user_id = m.seed_id
  RETURNING 1
)
SELECT
  (SELECT count(*) FROM moved_pay)     AS pay_structures_moved,
  (SELECT count(*) FROM moved_plans)   AS commission_plans_moved,
  (SELECT count(*) FROM moved_payouts) AS commission_payouts_moved;
