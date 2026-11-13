-- A room's unit number.
--
-- The client works multi-unit buildings constantly — apartment complexes,
-- nursing homes, managed properties — so a job's affected areas routinely span
-- more than one unit. Mark asked for it in two messages: "add option for unit
-- number", then "then room name after unit". The unit leads, because in a
-- forty-unit block "Bedroom" identifies nothing; the unit is what tells two
-- rooms apart.
--
-- Nullable, and deliberately so. A single-family house has no unit, and every
-- room recorded before this column existed has none either. Nothing in the
-- application may require it: an unset unit is the normal case, not a gap to be
-- filled in.
--
-- Free text rather than a lookup or a number. Units are written the way the
-- building writes them — "4B", "101", "Apt 2", "Suite 300", "A1" — and forcing
-- them into an integer would lose the letter that identifies half of them. The
-- application sorts them naturally (2 before 10) rather than lexicographically.
--
-- Re-runnable: ADD COLUMN IF NOT EXISTS, and the index is IF NOT EXISTS. There
-- is no backfill and nothing is rewritten — existing rows keep a NULL unit and
-- behave exactly as they did.
--
-- Grants: job_rooms carries table-level grants (no per-column ACLs), so the new
-- column inherits SELECT/INSERT/UPDATE from the table and needs no GRANT of its
-- own. RLS is unchanged — the unit is no more sensitive than the room name it
-- sits next to.

ALTER TABLE public.job_rooms
  ADD COLUMN IF NOT EXISTS unit text;

COMMENT ON COLUMN public.job_rooms.unit IS
  'Unit/apartment designator this room is in, as written by the building ("4B", "101", "Apt 2"). NULL for a single-family property and for rooms recorded before units existed.';

-- The room list is always read per job and now grouped by unit within it.
CREATE INDEX IF NOT EXISTS job_rooms_job_unit_idx
  ON public.job_rooms(job_id, unit);
