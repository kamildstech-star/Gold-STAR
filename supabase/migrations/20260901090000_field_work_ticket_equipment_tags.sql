-- Asset tags on the field work ticket.
--
-- "Equipment Left" is seven typed counts, and a count is unverifiable: a 4
-- with nothing behind it is a claim, and the reconciliation the panel already
-- runs against equipment_placements can only ever report that two numbers
-- differ. It cannot say which machine is missing, which is the only question
-- anyone actually asks.
--
-- Scanning the plates gives the ticket the units themselves. The counts stay —
-- they are the printed form, three of the seven lines (injector, ozone,
-- hydroxyl) are for gear Gold Star does not asset-tag at all, and a crew with
-- a dead phone camera still has to be able to write a number. So tags are
-- recorded alongside the counts and, where a line has tags, they are what
-- produced the count. A count of 4 with 4 tags is checkable; a count of 4 with
-- no tags is exactly what the ticket records today, unchanged.
--
-- A text[] of tags rather than a join table on equipment(id): the ticket is
-- filled in a basement and must not depend on every plate resolving to a
-- registered unit at the time it is written. A tag that matches nothing is
-- still evidence, and a foreign key would have thrown it away.
--
-- MUST be applied after 20260831190000_field_work_tickets.sql, which creates
-- the table. Both are unapplied as of writing.

ALTER TABLE public.field_work_tickets
  ADD COLUMN IF NOT EXISTS equipment_left_tags text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.field_work_tickets.equipment_left_tags IS
  'Asset tags scanned or typed for Equipment Left. Where present these drive the equip_* counts; where empty the counts are the only record. Not a foreign key: an unrecognised tag is still evidence.';

-- The reconciliation read: given an asset tag, which tickets claim it was left
-- on site. GIN is the index type for array containment.
CREATE INDEX IF NOT EXISTS field_work_tickets_equipment_tags_idx
  ON public.field_work_tickets USING gin (equipment_left_tags);

-- No RLS change. The column sits on a table whose policies already restrict
-- every row to the audience that can view the job, and adding a column does
-- not widen that.
