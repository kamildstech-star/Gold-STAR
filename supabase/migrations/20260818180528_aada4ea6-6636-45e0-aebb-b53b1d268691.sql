ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS standing_note text,
  ADD COLUMN IF NOT EXISTS standing_note_kind text NOT NULL DEFAULT 'general';

ALTER TABLE public.accounts
  ADD CONSTRAINT accounts_standing_note_kind_check
  CHECK (standing_note_kind IN ('general','discount','billing','access'));

CREATE TABLE public.property_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  address_key text NOT NULL UNIQUE,
  address text NOT NULL,
  note text NOT NULL,
  location_id uuid REFERENCES public.locations(id) ON DELETE SET NULL,
  created_by uuid REFERENCES public.profiles(user_id) ON DELETE SET NULL,
  updated_by uuid REFERENCES public.profiles(user_id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.property_notes TO authenticated;
GRANT ALL ON public.property_notes TO service_role;

ALTER TABLE public.property_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "property_notes_select" ON public.property_notes
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "property_notes_insert" ON public.property_notes
  FOR INSERT TO authenticated WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "property_notes_update" ON public.property_notes
  FOR UPDATE TO authenticated USING (auth.uid() IS NOT NULL) WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "property_notes_delete" ON public.property_notes
  FOR DELETE TO authenticated USING (public.is_privileged(auth.uid()));

CREATE TRIGGER update_property_notes_updated_at
  BEFORE UPDATE ON public.property_notes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();