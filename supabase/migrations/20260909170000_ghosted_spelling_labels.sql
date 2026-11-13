-- Mark's report: the stage is spelled "Ghosted", not "GOASTED".
--
-- Display names only. The stage KEY stays 'goasted' — pipeline_ghost_sweep,
-- pipeline_ghost_manual and tg_account_ghost_log all match on that literal, and
-- accounts.stage / account_stage_history / account_fire_rollup hold it as data.
-- Renaming the key is a separate, much larger job; see the note on
-- accounts.goasted_at.
--
-- Re-runnable: both statements are guarded and idempotent.

update public.pipeline_stages
   set name = 'Ghosted'
 where key = 'goasted'
   and name is distinct from 'Ghosted';

update public.leaderboard_achievements
   set description = 'Won back a Ghosted account.'
 where rule_key = 'goasted_recovered'
   and description is distinct from 'Won back a Ghosted account.';
