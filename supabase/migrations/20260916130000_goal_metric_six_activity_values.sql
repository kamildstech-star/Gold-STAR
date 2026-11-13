-- APPLIED to production on 2026-09-16 and ledgered as 20260916130000; verified live afterwards.
-- The paragraph below was written before it ran and is kept as the record of what
-- was weighed.
--
-- 
-- =====================================================================
-- NOT APPLIED. Written in the goal-metrics worktree and left for the main
-- session to apply, per the standing rule that agents do not run migrations.
--
-- Six new goal metrics. Mark, 16 Sep 2026, verbatim:
--
--   "add fires chased, cold leak converted, cold calls, new deals worked on,
--    active client reach out (code it to understand this is acctive client
--    messaging, emails, texts, calls, etc), cold email outreach"
--
-- ("cold leak" is cold lead.) `goals.metric` is the `goal_metric` enum, so a
-- target cannot be saved for any of them until the enum knows the name. This
-- file adds ONLY the enum values — Postgres will not let a new enum value be
-- used in the transaction that created it, so everything that computes the
-- actuals is in 20260916130100_goal_activity_actuals.sql, the same split
-- 20260909120000 / 20260909120100 used for the touchpoint methods.
--
-- The keys match GOAL_METRICS in src/lib/goals.ts, which carries the rule
-- for each one. Rename there, rename here.
-- =====================================================================

ALTER TYPE public.goal_metric ADD VALUE IF NOT EXISTS 'cold_calls';
ALTER TYPE public.goal_metric ADD VALUE IF NOT EXISTS 'cold_emails';
ALTER TYPE public.goal_metric ADD VALUE IF NOT EXISTS 'new_deals_worked';
ALTER TYPE public.goal_metric ADD VALUE IF NOT EXISTS 'cold_leads_converted';
ALTER TYPE public.goal_metric ADD VALUE IF NOT EXISTS 'active_client_reach_outs';
ALTER TYPE public.goal_metric ADD VALUE IF NOT EXISTS 'fires_chased';
