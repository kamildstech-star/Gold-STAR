ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS reports_to_contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL;