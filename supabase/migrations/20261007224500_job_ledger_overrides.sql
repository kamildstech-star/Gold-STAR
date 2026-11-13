-- Job ledger: cells you can type into.
--
-- WRITTEN, NOT APPLIED. Two new tables, three functions, two triggers.
-- Nothing existing is altered, dropped or re-granted, and no existing row
-- changes. The app works before this is applied: the ledger strip reads
-- job_ledger_overrides, and a missing table leaves every cell read-only with
-- a "not available yet" note (src/lib/job-ledger-overrides.ts).
--
-- Mark, of the pinned Job ledger strip (#317): "can we make each box
-- editable".
--
-- WHAT A ROW IS. One figure typed into one cell of one job's ledger, keyed
-- (job_id, cell_key). Two kinds of cell share the table:
--   * ENTRIES — Garbage, Truck Fee, Misc Fees. Nothing in the system records
--     these per job; until now they showed a dash. The row IS the figure.
--   * OVERRIDES — Days, Guys, Hours, Supplies, Equipment, Sub Fees, Labor,
--     Billed, Paid. Each has a calculated source (field tickets, the running
--     cost engine, invoices). The row replaces the figure ON THE LEDGER ONLY
--     and is kept apart from the source on purpose: an override of Billed or
--     Paid never creates, alters or deletes an invoice or a payment, and an
--     override of Equipment never touches a placement. Deleting the row is
--     "Back to calculated".
-- NOT here: Referral and Commission (set on the Commissions card), and the
-- two totals (worked out from their parts, so typing one would contradict
-- them). The cell_key CHECK is the list; src/lib/job-ledger.ts
-- LEDGER_EDITABLE_KEYS mirrors it and a test holds the two together.
--
-- WHY A TABLE AND NOT COLUMNS ON jobs. jobs is readable by crew, and these
-- are money; a column on jobs would need a column-grant carve-out (the
-- job_calculations pattern) and would still be one more thing every jobs
-- select has to remember. A table keyed by job is closed by default.
--
-- WHO READS. Exactly who reads the ledger today:
--   * Days / Guys / Hours (effort, not money): anyone who can see the job.
--   * Every other cell: can see the job AND can_view_finance (the gate inside
--     job_running_cost, where the money cells come from) AND job.view_costs
--     on the job's office (the gate the strip and invoices_select use). The
--     intersection, so an override is never visible to someone who could not
--     already see the figure it replaces.
--
-- WHO WRITES. Exactly who may write job money today: the rule on
-- job_cost_lines ("Finance roles write job cost lines", 20260807220752) —
-- owner, admin, sales_head — and only on a cell they can read. Mirrored by
-- canEditLedger in src/lib/job-ledger.ts.
--
-- AUDIT. Every set, change and clear is a row in job_ledger_override_changes
-- (who, when, old, new), written by a trigger so every path — app, Lovable,
-- SQL — is covered. Clients can read it (same rule as the cell) and write
-- nothing. Money is outside record_history by convention (AGENT-BRIEF), so
-- this is its own small trail rather than a record_history branch.
--
-- Re-runnable: IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS.

-- ---------------------------------------------------------------------------
-- 1. The figures
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.job_ledger_overrides (
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  cell_key text NOT NULL CHECK (cell_key IN (
    'days', 'guys', 'hours',
    'garbage', 'supplies', 'truck_fee', 'misc_fees', 'equipment', 'sub_fees', 'labor',
    'billed', 'paid')),
  value numeric(14,2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid DEFAULT auth.uid(),
  PRIMARY KEY (job_id, cell_key),
  -- A credit can make a money cell negative; a negative day count is a typo.
  CONSTRAINT job_ledger_overrides_effort_not_negative
    CHECK (cell_key NOT IN ('days', 'guys', 'hours') OR value >= 0)
);

-- Who and when come from the session, never from the browser; the key of a
-- row never moves (a different cell is a different row).
CREATE OR REPLACE FUNCTION public.tg_job_ledger_overrides_stamp()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
    NEW.created_by := auth.uid();
  ELSE
    NEW.job_id := OLD.job_id;
    NEW.cell_key := OLD.cell_key;
    NEW.created_at := OLD.created_at;
    NEW.created_by := OLD.created_by;
  END IF;
  NEW.updated_at := now();
  NEW.updated_by := auth.uid();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_job_ledger_overrides_stamp() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS job_ledger_overrides_stamp ON public.job_ledger_overrides;
CREATE TRIGGER job_ledger_overrides_stamp BEFORE INSERT OR UPDATE ON public.job_ledger_overrides
  FOR EACH ROW EXECUTE FUNCTION public.tg_job_ledger_overrides_stamp();

-- ---------------------------------------------------------------------------
-- 2. The trail
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.job_ledger_override_changes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  cell_key text NOT NULL,
  -- NULL old = the cell was calculated (or empty) before; NULL new = put back
  -- to calculated.
  old_value numeric(14,2),
  new_value numeric(14,2),
  changed_by uuid,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS job_ledger_override_changes_job_idx
  ON public.job_ledger_override_changes (job_id, changed_at DESC);

-- SECURITY DEFINER because clients hold no INSERT on the trail — that is the
-- point of it. It writes only what the statement that fired it did.
CREATE OR REPLACE FUNCTION public.tg_job_ledger_overrides_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.job_ledger_override_changes (job_id, cell_key, old_value, new_value, changed_by)
    VALUES (NEW.job_id, NEW.cell_key, NULL, NEW.value, auth.uid());
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.value IS DISTINCT FROM OLD.value THEN
      INSERT INTO public.job_ledger_override_changes (job_id, cell_key, old_value, new_value, changed_by)
      VALUES (NEW.job_id, NEW.cell_key, OLD.value, NEW.value, auth.uid());
    END IF;
    RETURN NEW;
  ELSE
    -- A job being deleted takes its overrides with it (cascade); that is not
    -- a ledger edit, and the trail goes with the job too.
    IF EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = OLD.job_id) THEN
      INSERT INTO public.job_ledger_override_changes (job_id, cell_key, old_value, new_value, changed_by)
      VALUES (OLD.job_id, OLD.cell_key, OLD.value, NULL, auth.uid());
    END IF;
    RETURN OLD;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_job_ledger_overrides_audit() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS job_ledger_overrides_audit ON public.job_ledger_overrides;
CREATE TRIGGER job_ledger_overrides_audit AFTER INSERT OR UPDATE OR DELETE ON public.job_ledger_overrides
  FOR EACH ROW EXECUTE FUNCTION public.tg_job_ledger_overrides_audit();

-- ---------------------------------------------------------------------------
-- 3. Who reads, who writes
-- ---------------------------------------------------------------------------
-- No user id parameter: a definer function that answers "could user X read
-- this?" for any X would be an oracle about other people's access. It asks
-- only about the caller.
CREATE OR REPLACE FUNCTION public.job_ledger_cell_readable(_job_id uuid, _cell_key text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.jobs j
     WHERE j.id = _job_id
       AND public.can_view_job(auth.uid(), j.id)
       AND (
         _cell_key IN ('days', 'guys', 'hours')
         OR (public.can_view_finance(auth.uid())
             AND public.has_permission(auth.uid(), 'job.view_costs', j.location_id))
       )
  );
$$;
REVOKE ALL ON FUNCTION public.job_ledger_cell_readable(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.job_ledger_cell_readable(uuid, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.job_ledger_cell_writable(_job_id uuid, _cell_key text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public.has_any_role_text(auth.uid(), ARRAY['owner', 'admin', 'sales_head'])
     AND public.job_ledger_cell_readable(_job_id, _cell_key);
$$;
REVOKE ALL ON FUNCTION public.job_ledger_cell_writable(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.job_ledger_cell_writable(uuid, text) TO authenticated, service_role;

-- Supabase grants every new public table to anon and authenticated by
-- default; take that back and give exactly what is needed.
REVOKE ALL ON public.job_ledger_overrides FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.job_ledger_override_changes FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.job_ledger_overrides TO authenticated;
GRANT SELECT ON public.job_ledger_override_changes TO authenticated;
GRANT ALL ON public.job_ledger_overrides TO service_role;
GRANT ALL ON public.job_ledger_override_changes TO service_role;

ALTER TABLE public.job_ledger_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_ledger_override_changes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS job_ledger_overrides_select ON public.job_ledger_overrides;
CREATE POLICY job_ledger_overrides_select ON public.job_ledger_overrides
  FOR SELECT TO authenticated
  USING (public.job_ledger_cell_readable(job_id, cell_key));
DROP POLICY IF EXISTS job_ledger_overrides_insert ON public.job_ledger_overrides;
CREATE POLICY job_ledger_overrides_insert ON public.job_ledger_overrides
  FOR INSERT TO authenticated
  WITH CHECK (public.job_ledger_cell_writable(job_id, cell_key));
DROP POLICY IF EXISTS job_ledger_overrides_update ON public.job_ledger_overrides;
CREATE POLICY job_ledger_overrides_update ON public.job_ledger_overrides
  FOR UPDATE TO authenticated
  USING (public.job_ledger_cell_writable(job_id, cell_key))
  WITH CHECK (public.job_ledger_cell_writable(job_id, cell_key));
DROP POLICY IF EXISTS job_ledger_overrides_delete ON public.job_ledger_overrides;
CREATE POLICY job_ledger_overrides_delete ON public.job_ledger_overrides
  FOR DELETE TO authenticated
  USING (public.job_ledger_cell_writable(job_id, cell_key));

DROP POLICY IF EXISTS job_ledger_override_changes_select ON public.job_ledger_override_changes;
CREATE POLICY job_ledger_override_changes_select ON public.job_ledger_override_changes
  FOR SELECT TO authenticated
  USING (public.job_ledger_cell_readable(job_id, cell_key));

-- The house restrictive guards (20260929121000), installed here rather than
-- waiting for that sweep to be re-run.
DROP POLICY IF EXISTS active_profile_required ON public.job_ledger_overrides;
CREATE POLICY active_profile_required ON public.job_ledger_overrides
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT goldstar_private.profile_is_active(auth.uid())))
  WITH CHECK ((SELECT goldstar_private.profile_is_active(auth.uid())));
DROP POLICY IF EXISTS active_profile_required ON public.job_ledger_override_changes;
CREATE POLICY active_profile_required ON public.job_ledger_override_changes
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT goldstar_private.profile_is_active(auth.uid())))
  WITH CHECK ((SELECT goldstar_private.profile_is_active(auth.uid())));
DROP POLICY IF EXISTS anonymous_business_access_denied ON public.job_ledger_overrides;
CREATE POLICY anonymous_business_access_denied ON public.job_ledger_overrides
  AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS anonymous_business_access_denied ON public.job_ledger_override_changes;
CREATE POLICY anonymous_business_access_denied ON public.job_ledger_override_changes
  AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'portal_customer') THEN
    REVOKE ALL ON public.job_ledger_overrides FROM portal_customer;
    REVOKE ALL ON public.job_ledger_override_changes FROM portal_customer;
    REVOKE ALL ON FUNCTION public.job_ledger_cell_readable(uuid, text) FROM portal_customer;
    REVOKE ALL ON FUNCTION public.job_ledger_cell_writable(uuid, text) FROM portal_customer;
    DROP POLICY IF EXISTS portal_customer_denied ON public.job_ledger_overrides;
    CREATE POLICY portal_customer_denied ON public.job_ledger_overrides
      AS RESTRICTIVE FOR ALL TO portal_customer USING (false) WITH CHECK (false);
    DROP POLICY IF EXISTS portal_customer_denied ON public.job_ledger_override_changes;
    CREATE POLICY portal_customer_denied ON public.job_ledger_override_changes
      AS RESTRICTIVE FOR ALL TO portal_customer USING (false) WITH CHECK (false);
  END IF;
END $$;

COMMENT ON TABLE public.job_ledger_overrides IS
  'Figures typed into the Job ledger strip, one row per (job, cell). Garbage / Truck Fee / Misc Fees are entries (no other source); the rest override a calculated figure on the ledger only — never an invoice, payment, placement or time entry. Delete = back to calculated. Trail: job_ledger_override_changes.';
COMMENT ON TABLE public.job_ledger_override_changes IS
  'Who set, changed or cleared a Job ledger cell, when, old and new. Written by trigger only.';
