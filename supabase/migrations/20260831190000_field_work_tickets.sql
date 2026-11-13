-- Gold Star's paper field work ticket, as a record.
--
-- Two ways a ticket gets here and one table for both: a crew fills it on a
-- phone on site (source 'digital'), or the office photographs a hand-filled
-- sheet (source 'scanned', image attached as a document). A scan carries only
-- the handful of fields the office types in — date, crew chief, completion —
-- so the paper ones are still countable in a report instead of being an
-- opaque JPEG nobody can query.
--
-- The checkbox groups are text[] of stable slugs rather than boolean columns:
-- the paper form's lists change when Gold Star reprints it, and a slug list
-- absorbs that without a migration per checkbox. Equipment Left is the
-- exception — it is a count per type, and counts belong in integer columns
-- where `sum()` can reach them.
--
-- RECONCILIATION NOTE (2026-09-03)
-- --------------------------------
-- This file was never recorded in supabase_migrations.schema_migrations, but
-- the table EXISTS in production: Lovable created it directly, to clear a
-- typecheck failure, in a shape that differs from the original CREATE TABLE:
--
--   * job_start_time / job_end_time are `text` ("HH:MM", straight from the
--     panel's <input type="time">), not `time`. src/integrations/supabase/
--     types.ts and src/lib/ticket-crew-hours.ts already treat them as strings,
--     so text is now the canonical type here as well, and
--     20260902200500_field_ticket_crew_hours parses it defensively.
--   * captured_at is nullable (types.ts: `string | null`).
--   * none of the CHECK constraints exist; location_id has no ON DELETE
--     CASCADE; the location and more-work indexes are missing; the policies
--     carry slightly different logic; and the more-work flag is raised by a
--     Lovable-written trigger (field_work_tickets_more_work).
--
-- So this file CONVERGES the live table instead of recreating it. CREATE
-- TABLE IF NOT EXISTS builds it from scratch on an empty database and is a
-- no-op on production; every column the app reads or writes is then ADD
-- COLUMN IF NOT EXISTS; CHECK constraints are added NOT VALID so no row that
-- already exists can fail them; policies are DROP-then-CREATE; the duplicate
-- flag trigger is replaced by this file's. Nothing is taken away from the
-- data: no column is dropped and no column type is changed.

CREATE TABLE IF NOT EXISTS public.field_work_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  -- Denormalised from the job so RLS and location reporting have a local
  -- anchor, exactly as public.documents does.
  location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,

  -- Header, as printed on the paper
  job_address text,
  unit_number text,
  work_date date NOT NULL DEFAULT current_date,
  -- "HH:MM" as the phone's time input emits it. Text, not `time`, so the
  -- offline queue can store exactly what the crew typed and the value round-
  -- trips through the generated types unchanged. Parsed where hours are
  -- needed (field_ticket_crew_minutes), never assumed valid.
  job_start_time text,
  job_end_time text,
  -- Free text, not a profile reference: the paper is signed by whoever ran the
  -- crew that day, including temps who have no login.
  crew_chief_name text,
  gsr_crew_size integer,
  temp_crew_size integer,

  job_types text[] NOT NULL DEFAULT '{}',
  scope_completed text[] NOT NULL DEFAULT '{}',
  materials_used text[] NOT NULL DEFAULT '{}',

  -- NULL means the crew left the box blank; 0 means they wrote a zero.
  equip_dehumidifier integer,
  equip_air_mover integer,
  equip_scrubber integer,
  equip_injector integer,
  equip_ozone integer,
  equip_hydroxyl integer,
  equip_generator integer,

  work_notes text,
  trash_disposition text,
  job_completed boolean NOT NULL DEFAULT false,
  more_work_needed boolean NOT NULL DEFAULT false,

  source text NOT NULL DEFAULT 'digital',
  -- The photograph of the paper. SET NULL, never CASCADE: deleting the image
  -- must not delete the typed fields that make the ticket findable.
  document_id uuid REFERENCES public.documents(id) ON DELETE SET NULL,

  -- When the crew pressed save on their phone, which is not when it reached
  -- the server — a ticket written in a basement syncs hours later.
  captured_at timestamptz DEFAULT now(),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Convergence: every column the app touches, added where missing.
-- src/lib/field-work-ticket.ts, src/components/field-work-ticket-panel.tsx and
-- src/lib/ticket-crew-hours.ts read or write exactly this set (plus
-- equipment_left_tags, which 20260901090000 adds). Columns Lovable added that
-- the app does not use are left in place.
-- ---------------------------------------------------------------------------
ALTER TABLE public.field_work_tickets
  ADD COLUMN IF NOT EXISTS job_address text,
  ADD COLUMN IF NOT EXISTS unit_number text,
  ADD COLUMN IF NOT EXISTS work_date date NOT NULL DEFAULT current_date,
  ADD COLUMN IF NOT EXISTS job_start_time text,
  ADD COLUMN IF NOT EXISTS job_end_time text,
  ADD COLUMN IF NOT EXISTS crew_chief_name text,
  ADD COLUMN IF NOT EXISTS gsr_crew_size integer,
  ADD COLUMN IF NOT EXISTS temp_crew_size integer,
  ADD COLUMN IF NOT EXISTS job_types text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS scope_completed text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS materials_used text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS equip_dehumidifier integer,
  ADD COLUMN IF NOT EXISTS equip_air_mover integer,
  ADD COLUMN IF NOT EXISTS equip_scrubber integer,
  ADD COLUMN IF NOT EXISTS equip_injector integer,
  ADD COLUMN IF NOT EXISTS equip_ozone integer,
  ADD COLUMN IF NOT EXISTS equip_hydroxyl integer,
  ADD COLUMN IF NOT EXISTS equip_generator integer,
  ADD COLUMN IF NOT EXISTS work_notes text,
  ADD COLUMN IF NOT EXISTS trash_disposition text,
  ADD COLUMN IF NOT EXISTS job_completed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS more_work_needed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'digital',
  ADD COLUMN IF NOT EXISTS document_id uuid REFERENCES public.documents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS captured_at timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS created_by uuid,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- The paper form's vocabulary, enforced. NOT VALID: new and changed rows are
-- checked, rows that pre-date the constraint are not, so applying this to a
-- table that already has tickets cannot fail. Once the two existing rows have
-- been eyeballed, `ALTER TABLE ... VALIDATE CONSTRAINT <name>` finishes the
-- job; nothing depends on that happening.
DO $$
BEGIN
  BEGIN
    ALTER TABLE public.field_work_tickets ADD CONSTRAINT field_work_tickets_gsr_crew_size_check
      CHECK (gsr_crew_size IS NULL OR gsr_crew_size >= 0) NOT VALID;
  EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN
    ALTER TABLE public.field_work_tickets ADD CONSTRAINT field_work_tickets_temp_crew_size_check
      CHECK (temp_crew_size IS NULL OR temp_crew_size >= 0) NOT VALID;
  EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN
    ALTER TABLE public.field_work_tickets ADD CONSTRAINT field_work_tickets_equip_counts_check
      CHECK (
        (equip_dehumidifier IS NULL OR equip_dehumidifier >= 0)
        AND (equip_air_mover IS NULL OR equip_air_mover >= 0)
        AND (equip_scrubber IS NULL OR equip_scrubber >= 0)
        AND (equip_injector IS NULL OR equip_injector >= 0)
        AND (equip_ozone IS NULL OR equip_ozone >= 0)
        AND (equip_hydroxyl IS NULL OR equip_hydroxyl >= 0)
        AND (equip_generator IS NULL OR equip_generator >= 0)
      ) NOT VALID;
  EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN
    ALTER TABLE public.field_work_tickets ADD CONSTRAINT field_work_tickets_trash_disposition_check
      CHECK (
        trash_disposition IS NULL
        OR trash_disposition IN ('none', 'shop', 'job_site_dumpster', 'gsr_dumpster')
      ) NOT VALID;
  EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN
    ALTER TABLE public.field_work_tickets ADD CONSTRAINT field_work_tickets_source_check
      CHECK (source IN ('digital', 'scanned')) NOT VALID;
  EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN
    ALTER TABLE public.field_work_tickets ADD CONSTRAINT field_work_tickets_job_types_valid
      CHECK (
        job_types <@ ARRAY['water','fire','mold','sewage','bio','vandalism','air_sample']::text[]
      ) NOT VALID;
  EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN
    ALTER TABLE public.field_work_tickets ADD CONSTRAINT field_work_tickets_scope_valid
      CHECK (
        scope_completed <@ ARRAY[
          'extraction','pump_out','mop_floor','smoke_clean','wipe_down','demo',
          'clean_sanitize','board_up','fogging','sketch','write_up','dry_log'
        ]::text[]
      ) NOT VALID;
  EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN
    ALTER TABLE public.field_work_tickets ADD CONSTRAINT field_work_tickets_materials_valid
      CHECK (
        materials_used <@ ARRAY[
          'containment','zipper','ram_board','degreaser','antimicrobial','ppe','rags',
          'trash_bags','filters','tarp','boxes','truck_mount','encapsulation_paint',
          'lay_flat_ducting'
        ]::text[]
      ) NOT VALID;
  EXCEPTION WHEN duplicate_object THEN NULL; END;
  -- A ticket cannot both close the job and ask for another visit.
  BEGIN
    ALTER TABLE public.field_work_tickets ADD CONSTRAINT field_work_tickets_completion_exclusive
      CHECK (NOT (job_completed AND more_work_needed)) NOT VALID;
  EXCEPTION WHEN duplicate_object THEN NULL; END;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.field_work_tickets TO authenticated;
GRANT ALL ON public.field_work_tickets TO service_role;
ALTER TABLE public.field_work_tickets ENABLE ROW LEVEL SECURITY;

-- Exactly the jobs_select audience, via can_view_job: privileged users, anyone
-- who can view the job's location, the crew chief, and assigned crew. A ticket
-- is never visible to someone who cannot see the job it belongs to.
-- Policies are dropped first so this file can be re-run; the live policies
-- Lovable wrote carry the same names and are replaced by these.
DROP POLICY IF EXISTS "field_work_tickets_select" ON public.field_work_tickets;
CREATE POLICY "field_work_tickets_select" ON public.field_work_tickets FOR SELECT TO authenticated
  USING (public.can_view_job(auth.uid(), job_id));
-- Anyone who can see the job can file a ticket for it — the crew on site is
-- often assigned rather than managing. created_by is pinned to the author the
-- way documents_insert pins it.
DROP POLICY IF EXISTS "field_work_tickets_insert" ON public.field_work_tickets;
CREATE POLICY "field_work_tickets_insert" ON public.field_work_tickets FOR INSERT TO authenticated
  WITH CHECK (public.can_view_job(auth.uid(), job_id) AND created_by = auth.uid());
DROP POLICY IF EXISTS "field_work_tickets_update" ON public.field_work_tickets;
CREATE POLICY "field_work_tickets_update" ON public.field_work_tickets FOR UPDATE TO authenticated
  USING (created_by = auth.uid() OR public.can_manage_job(auth.uid(), job_id))
  WITH CHECK (created_by = auth.uid() OR public.can_manage_job(auth.uid(), job_id));
DROP POLICY IF EXISTS "field_work_tickets_delete" ON public.field_work_tickets;
CREATE POLICY "field_work_tickets_delete" ON public.field_work_tickets FOR DELETE TO authenticated
  USING (public.is_privileged(auth.uid()));

CREATE INDEX IF NOT EXISTS field_work_tickets_job_idx
  ON public.field_work_tickets (job_id, work_date DESC);
CREATE INDEX IF NOT EXISTS field_work_tickets_location_idx
  ON public.field_work_tickets (location_id, work_date DESC);
-- The operationally important read: which jobs have a crew asking to come back.
CREATE INDEX IF NOT EXISTS field_work_tickets_more_work_idx
  ON public.field_work_tickets (location_id, work_date DESC) WHERE more_work_needed;

-- updated_at. Production already stamps it through a Lovable trigger named
-- field_work_tickets_updated_at; a second trigger would do the same work
-- twice, so this one is created only where no such trigger exists.
DROP TRIGGER IF EXISTS field_work_tickets_set_updated_at ON public.field_work_tickets;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.field_work_tickets'::regclass
      AND tgname = 'field_work_tickets_updated_at'
  ) THEN
    CREATE TRIGGER field_work_tickets_set_updated_at BEFORE UPDATE ON public.field_work_tickets
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END $$;

-- A ticket that says "more work needed" has to reach the job record, or it is
-- read once by whoever opened the ticket and never again. jobs.additional_work_pending
-- already exists and already drives the job list's attention tone, so it is
-- raised here rather than being shadowed by a second flag.
--
-- Raised only, never cleared: the office decides when outstanding work is
-- actually done, and a later ticket for a different room must not silently
-- retract an earlier crew's request.
CREATE OR REPLACE FUNCTION public.field_work_ticket_flags_job()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- OLD is unassigned on INSERT, so it is only touched on the UPDATE path.
  IF NEW.more_work_needed AND (TG_OP = 'INSERT' OR NOT OLD.more_work_needed) THEN
    UPDATE public.jobs SET additional_work_pending = true
    WHERE id = NEW.job_id AND additional_work_pending = false;
  END IF;
  RETURN NEW;
END $$;

-- Production carries Lovable's copy of this trigger (field_work_tickets_more_work
-- -> field_work_ticket_flag_more_work()). Two AFTER triggers raising the same
-- flag would be harmless but confusing, so that trigger is removed and this
-- file's is the one kept. The function it called is left in place: nothing
-- another object might reference is dropped here.
DROP TRIGGER IF EXISTS field_work_tickets_more_work ON public.field_work_tickets;
DROP TRIGGER IF EXISTS trg_field_work_ticket_flags_job ON public.field_work_tickets;
CREATE TRIGGER trg_field_work_ticket_flags_job
AFTER INSERT OR UPDATE OF more_work_needed ON public.field_work_tickets
FOR EACH ROW EXECUTE FUNCTION public.field_work_ticket_flags_job();
