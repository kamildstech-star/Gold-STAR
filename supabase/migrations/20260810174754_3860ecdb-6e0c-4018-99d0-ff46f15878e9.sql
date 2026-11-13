ALTER TABLE public.incidents
  ADD COLUMN IF NOT EXISTS contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS incidents_contact_id_idx ON public.incidents(contact_id);