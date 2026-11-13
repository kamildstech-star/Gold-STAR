-- ---------------------------------------------------------------------------
-- Remove the "Proposal sent" pipeline stage (5 Nov: "proposal sent should not
-- be there, they said").
--
-- 20261012200000 added `proposal_sent` to both account pipelines, right after
-- Conversation established / Meeting held. It goes again:
--   1. every account (and job) on it moves back to the stage just before it --
--      the one it was inserted after -- since stage_id is ON DELETE RESTRICT;
--      the accounts trigger keeps `accounts.stage` in step with stage_id;
--   2. a health_stage_id pointing at it is cleared;
--   3. the stage is deleted (history rows and rule targets SET NULL, stage
--      windows CASCADE) and the later stages close the 10-point gap.
--
-- Sending a proposal no longer moves the card: tg_account_proposal_advance
-- already handles a pipeline without the stage ("Not moved: this pipeline has
-- no Proposal sent stage.") and signing still makes the account an Active
-- Client. Nothing re-creates the stage.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  ps record;
  prev public.pipeline_stages%ROWTYPE;
  moved int;
BEGIN
  FOR ps IN SELECT * FROM public.pipeline_stages WHERE key = 'proposal_sent' LOOP
    SELECT * INTO prev FROM public.pipeline_stages s
     WHERE s.pipeline_id = ps.pipeline_id
       AND s.sort_order < ps.sort_order
       AND NOT s.is_won AND NOT s.is_lost
     ORDER BY s.sort_order DESC
     LIMIT 1;
    IF prev.id IS NULL THEN
      RAISE EXCEPTION 'Pipeline % has no stage before Proposal sent to move its cards to.',
        ps.pipeline_id;
    END IF;

    UPDATE public.accounts SET stage_id = prev.id WHERE stage_id = ps.id;
    GET DIAGNOSTICS moved = ROW_COUNT;
    RAISE NOTICE 'Pipeline %: % account(s) moved from Proposal sent to %.',
      ps.pipeline_id, moved, prev.name;

    UPDATE public.jobs SET stage_id = prev.id WHERE stage_id = ps.id;
    UPDATE public.accounts SET health_stage_id = NULL WHERE health_stage_id = ps.id;

    DELETE FROM public.pipeline_stages WHERE id = ps.id;

    UPDATE public.pipeline_stages s
       SET sort_order = s.sort_order - 10
     WHERE s.pipeline_id = ps.pipeline_id AND s.sort_order > ps.sort_order;

    prev := NULL;
  END LOOP;
END $$;

-- VERIFY:
--   SELECT count(*) FROM public.pipeline_stages WHERE key = 'proposal_sent';  -- 0
--
-- ROLLBACK: re-run section 6 of 20261012200000_account_proposals.sql (it adds
-- the stage back after the same anchor); cards stay where they were moved.
