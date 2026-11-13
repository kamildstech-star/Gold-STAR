CREATE TABLE public.record_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('estimate','invoice')),
  record_id uuid NOT NULL,
  location_id uuid REFERENCES public.locations(id) ON DELETE SET NULL,
  version integer NOT NULL,
  total numeric(12,2) NOT NULL DEFAULT 0,
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  change_summary text,
  frozen boolean NOT NULL DEFAULT false,
  frozen_at timestamptz,
  document_id uuid REFERENCES public.documents(id) ON DELETE SET NULL,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, record_id, version)
);
CREATE INDEX record_revisions_record_idx ON public.record_revisions (kind, record_id, version DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.record_revisions TO authenticated;
GRANT ALL ON public.record_revisions TO service_role;
ALTER TABLE public.record_revisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY record_revisions_select ON public.record_revisions FOR SELECT TO authenticated
  USING (public.can_view_location(auth.uid(), location_id) OR created_by = auth.uid());
CREATE POLICY record_revisions_insert ON public.record_revisions FOR INSERT TO authenticated
  WITH CHECK (public.can_view_location(auth.uid(), location_id) AND created_by = auth.uid());
CREATE POLICY record_revisions_update ON public.record_revisions FOR UPDATE TO authenticated
  USING (public.can_view_location(auth.uid(), location_id) OR created_by = auth.uid())
  WITH CHECK (public.can_view_location(auth.uid(), location_id) OR created_by = auth.uid());
CREATE POLICY record_revisions_delete ON public.record_revisions FOR DELETE TO authenticated
  USING (public.can_manage_location(auth.uid(), location_id) OR created_by = auth.uid());

CREATE TABLE public.record_revision_sends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revision_id uuid NOT NULL REFERENCES public.record_revisions(id) ON DELETE CASCADE,
  recipient text,
  channel text NOT NULL DEFAULT 'email',
  note text,
  sent_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  sent_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX record_revision_sends_revision_idx ON public.record_revision_sends (revision_id, sent_at DESC);

GRANT SELECT, INSERT ON public.record_revision_sends TO authenticated;
GRANT ALL ON public.record_revision_sends TO service_role;
ALTER TABLE public.record_revision_sends ENABLE ROW LEVEL SECURITY;

CREATE POLICY record_revision_sends_select ON public.record_revision_sends FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.record_revisions r WHERE r.id = revision_id
    AND (public.can_view_location(auth.uid(), r.location_id) OR r.created_by = auth.uid())));
CREATE POLICY record_revision_sends_insert ON public.record_revision_sends FOR INSERT TO authenticated
  WITH CHECK (sent_by = auth.uid() AND EXISTS (SELECT 1 FROM public.record_revisions r WHERE r.id = revision_id
    AND (public.can_view_location(auth.uid(), r.location_id) OR r.created_by = auth.uid())));

-- A version that has gone out to a carrier or customer is evidence: freeze it.
CREATE OR REPLACE FUNCTION public.guard_frozen_revision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.frozen THEN
      RAISE EXCEPTION 'This version has already been sent and cannot be deleted. Create a new version instead.';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.frozen THEN
    IF NEW.snapshot IS DISTINCT FROM OLD.snapshot
      OR NEW.total IS DISTINCT FROM OLD.total
      OR NEW.version IS DISTINCT FROM OLD.version
      OR NEW.frozen = false THEN
      RAISE EXCEPTION 'This version has already been sent and cannot be changed. Create a new version instead.';
    END IF;
  END IF;
  NEW.updated_at := now();
  IF NEW.frozen AND NOT OLD.frozen AND NEW.frozen_at IS NULL THEN
    NEW.frozen_at := now();
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_frozen_revision_upd BEFORE UPDATE ON public.record_revisions
  FOR EACH ROW EXECUTE FUNCTION public.guard_frozen_revision();
CREATE TRIGGER guard_frozen_revision_del BEFORE DELETE ON public.record_revisions
  FOR EACH ROW EXECUTE FUNCTION public.guard_frozen_revision();

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS current_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS source_estimate_version integer;
ALTER TABLE public.estimates
  ADD COLUMN IF NOT EXISTS current_version integer NOT NULL DEFAULT 1;