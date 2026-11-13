-- A day's field work ticket reaches the money, and can be accepted.
--
-- David, 16 Sep: he filled a daily field form — eight hours, a crew of two,
-- water extraction, one dehumidifier and three air movers — saved it, and
-- nothing appeared in the job's running costs.
--
-- The costing engine was never at fault. public.job_running_cost() takes labour
-- from time_entries and equipment from equipment_placements, and the ticket
-- writes neither. It records the crew's day in field_work_tickets and stops.
--
-- The app now files each ticket as one job_cost_lines row — the engine's
-- existing manual-cost leg, which total_cost already sums. Two things are
-- needed here for that to be safe:
--
--   1. a link column, so re-saving a ticket CORRECTS its cost line instead of
--      adding a second one. Without the unique index the upsert has nothing to
--      conflict on and every edit would inflate the job;
--   2. somewhere to record that a supervisor has accepted the ticket, which is
--      the approval step David asked for. Tickets had no such state at all.
--
-- Deliberately NOT done here: writing time_entries or equipment_placements from
-- a ticket. A ticket says "two people, eight hours" without saying which two,
-- so invented time entries would double-count against the time clock; and it
-- counts machines by type without asset tags, so invented placements would
-- corrupt the equipment register.

-- 1 ------------------------------------------------------------------------
ALTER TABLE public.job_cost_lines
  ADD COLUMN IF NOT EXISTS field_work_ticket_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'job_cost_lines_field_work_ticket_id_fkey'
  ) THEN
    ALTER TABLE public.job_cost_lines
      ADD CONSTRAINT job_cost_lines_field_work_ticket_id_fkey
      FOREIGN KEY (field_work_ticket_id)
      REFERENCES public.field_work_tickets(id) ON DELETE CASCADE;
  END IF;
END $$;

-- One cost line per ticket. Partial, so the many hand-entered cost lines that
-- carry no ticket are untouched by it.
CREATE UNIQUE INDEX IF NOT EXISTS job_cost_lines_field_work_ticket_id_key
  ON public.job_cost_lines(field_work_ticket_id)
  WHERE field_work_ticket_id IS NOT NULL;

-- 2 ------------------------------------------------------------------------
ALTER TABLE public.field_work_tickets
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_by uuid;

COMMENT ON COLUMN public.field_work_tickets.approved_at IS
  'When a supervisor accepted the ticket''s entries. Null = still to review.';
COMMENT ON COLUMN public.field_work_tickets.approved_by IS
  'Who accepted it. Set together with approved_at.';

-- Finding the day's unreviewed tickets is the only query this adds.
CREATE INDEX IF NOT EXISTS field_work_tickets_awaiting_approval_idx
  ON public.field_work_tickets(job_id)
  WHERE approved_at IS NULL;