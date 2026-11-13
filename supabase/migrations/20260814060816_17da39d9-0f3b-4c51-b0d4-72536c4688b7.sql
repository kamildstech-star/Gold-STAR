CREATE TABLE public.incident_notes (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references public.incidents(id) on delete cascade,
  author_id uuid,
  body text not null,
  is_demo boolean not null default false,
  created_at timestamptz not null default now()
);
CREATE INDEX incident_notes_incident_idx ON public.incident_notes (incident_id, created_at desc);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.incident_notes TO authenticated;
GRANT ALL ON public.incident_notes TO service_role;

ALTER TABLE public.incident_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY incident_notes_select ON public.incident_notes FOR SELECT TO authenticated
USING (
  author_id = (select auth.uid())
  OR public.is_privileged((select auth.uid()))
  OR EXISTS (
    SELECT 1 FROM public.incidents i
    WHERE i.id = incident_notes.incident_id
      AND public.incident_market_allowed((select auth.uid()), i.market_id)
      AND (i.accepted_by = (select auth.uid())
        OR i.created_by = (select auth.uid())
        OR (i.location_id IS NOT NULL AND public.can_view_location((select auth.uid()), i.location_id)))
  )
);

CREATE POLICY incident_notes_insert ON public.incident_notes FOR INSERT TO authenticated
WITH CHECK (author_id = (select auth.uid()) OR public.is_privileged((select auth.uid())));

CREATE POLICY incident_notes_manage ON public.incident_notes FOR ALL TO authenticated
USING (public.is_privileged((select auth.uid())))
WITH CHECK (public.is_privileged((select auth.uid())));