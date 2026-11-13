CREATE TABLE public.tradeshow_attendees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tradeshow_id uuid NOT NULL REFERENCES public.tradeshows(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role_note text,
  is_demo boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tradeshow_id, user_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.tradeshow_attendees TO authenticated;
GRANT ALL ON public.tradeshow_attendees TO service_role;

ALTER TABLE public.tradeshow_attendees ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tradeshow_attendees_select" ON public.tradeshow_attendees
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.tradeshows t
     WHERE t.id = tradeshow_attendees.tradeshow_id
       AND (t.location_id IS NULL OR public.can_view_location(auth.uid(), t.location_id))
  ));

CREATE POLICY "tradeshow_attendees_write" ON public.tradeshow_attendees
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.tradeshows t
     WHERE t.id = tradeshow_attendees.tradeshow_id
       AND (public.is_sales_lead(auth.uid())
            OR (t.location_id IS NOT NULL AND public.can_manage_location(auth.uid(), t.location_id)))
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.tradeshows t
     WHERE t.id = tradeshow_attendees.tradeshow_id
       AND (public.is_sales_lead(auth.uid())
            OR (t.location_id IS NOT NULL AND public.can_manage_location(auth.uid(), t.location_id)))
  ));

CREATE TRIGGER trg_tradeshow_attendees_updated_at
  BEFORE UPDATE ON public.tradeshow_attendees
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.tradeshow_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tradeshow_id uuid NOT NULL REFERENCES public.tradeshows(id) ON DELETE CASCADE,
  body text NOT NULL,
  is_demo boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.tradeshow_notes TO authenticated;
GRANT ALL ON public.tradeshow_notes TO service_role;

ALTER TABLE public.tradeshow_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tradeshow_notes_select" ON public.tradeshow_notes
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.tradeshows t
     WHERE t.id = tradeshow_notes.tradeshow_id
       AND (t.location_id IS NULL OR public.can_view_location(auth.uid(), t.location_id))
  ));

CREATE POLICY "tradeshow_notes_insert" ON public.tradeshow_notes
  FOR INSERT TO authenticated
  WITH CHECK (
    created_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.tradeshows t
       WHERE t.id = tradeshow_notes.tradeshow_id
         AND (t.location_id IS NULL OR public.can_view_location(auth.uid(), t.location_id))
    )
  );

CREATE POLICY "tradeshow_notes_update" ON public.tradeshow_notes
  FOR UPDATE TO authenticated
  USING (created_by = auth.uid() OR public.is_sales_lead(auth.uid()))
  WITH CHECK (created_by = auth.uid() OR public.is_sales_lead(auth.uid()));

CREATE POLICY "tradeshow_notes_delete" ON public.tradeshow_notes
  FOR DELETE TO authenticated
  USING (created_by = auth.uid() OR public.is_sales_lead(auth.uid()));

CREATE TRIGGER trg_tradeshow_notes_updated_at
  BEFORE UPDATE ON public.tradeshow_notes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX idx_tradeshow_notes_show ON public.tradeshow_notes(tradeshow_id, created_at DESC);
CREATE INDEX idx_accounts_tradeshow ON public.accounts(tradeshow_id) WHERE tradeshow_id IS NOT NULL;
CREATE INDEX idx_jobs_tradeshow ON public.jobs(tradeshow_id) WHERE tradeshow_id IS NOT NULL;