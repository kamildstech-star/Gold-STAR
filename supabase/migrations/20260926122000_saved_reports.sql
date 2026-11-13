-- Saved custom reports.
--
-- David, 22 Sep: "How do we create a new report? If I want to just randomly go
-- in there and create different filters and different stuff to run a new
-- report... maybe add another section here, custom report."
--
-- A saved report is the CHOICES only — data area, date field, statuses, text
-- filters, columns, chart view (src/lib/custom-reports.ts). Never rows, never
-- a query: running it reads the source tables again under the viewer's own
-- RLS, with the office and period chosen on the page at that moment.
--
-- Scope, like the rest of Insights: yours, or shared with the office it was
-- saved in. A shared report is visible to whoever can see that office; one
-- shared with no office (saved in "all offices") only to privileged users.
-- Only its owner edits or deletes it.

CREATE TABLE IF NOT EXISTS public.saved_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  location_id uuid REFERENCES public.locations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  shared boolean NOT NULL DEFAULT false,
  definition jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saved_reports_owner_name UNIQUE (user_id, name)
);

CREATE INDEX IF NOT EXISTS saved_reports_shared_idx
  ON public.saved_reports (location_id) WHERE shared;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.saved_reports TO authenticated;
GRANT ALL ON public.saved_reports TO service_role;
ALTER TABLE public.saved_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "saved_reports_read" ON public.saved_reports;
CREATE POLICY "saved_reports_read" ON public.saved_reports FOR SELECT TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    OR (
      shared AND CASE
        WHEN location_id IS NULL THEN public.is_privileged((SELECT auth.uid()))
        ELSE public.can_view_location((SELECT auth.uid()), location_id)
      END
    )
  );

DROP POLICY IF EXISTS "saved_reports_own" ON public.saved_reports;
CREATE POLICY "saved_reports_own" ON public.saved_reports FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

DROP TRIGGER IF EXISTS trg_saved_reports_updated_at ON public.saved_reports;
CREATE TRIGGER trg_saved_reports_updated_at BEFORE UPDATE ON public.saved_reports
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
