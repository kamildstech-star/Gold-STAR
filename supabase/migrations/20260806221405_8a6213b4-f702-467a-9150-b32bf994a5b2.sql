CREATE TABLE public.contact_methods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'phone',
  label text,
  value text NOT NULL,
  extension text,
  is_preferred boolean NOT NULL DEFAULT false,
  is_demo boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES public.profiles(user_id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contact_methods_kind_check CHECK (kind = ANY (ARRAY['phone','email']))
);

CREATE INDEX contact_methods_contact_idx ON public.contact_methods (contact_id);
CREATE INDEX contact_methods_is_demo_idx ON public.contact_methods (is_demo) WHERE is_demo;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.contact_methods TO authenticated;
GRANT ALL ON public.contact_methods TO service_role;

ALTER TABLE public.contact_methods ENABLE ROW LEVEL SECURITY;

CREATE POLICY contact_methods_select ON public.contact_methods FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.contacts c JOIN public.accounts a ON a.id = c.account_id
  WHERE c.id = contact_methods.contact_id
    AND (public.can_view_location(auth.uid(), a.location_id) OR a.assigned_rep = auth.uid())
));

CREATE POLICY contact_methods_write ON public.contact_methods TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.contacts c JOIN public.accounts a ON a.id = c.account_id
  WHERE c.id = contact_methods.contact_id
    AND (public.can_manage_location(auth.uid(), a.location_id) OR a.assigned_rep = auth.uid())
))
WITH CHECK (EXISTS (
  SELECT 1 FROM public.contacts c JOIN public.accounts a ON a.id = c.account_id
  WHERE c.id = contact_methods.contact_id
    AND (public.can_manage_location(auth.uid(), a.location_id) OR a.assigned_rep = auth.uid())
));

CREATE TRIGGER trg_contact_methods_updated_at BEFORE UPDATE ON public.contact_methods
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Carry each contact's existing single phone across as a labelled Work number,
-- so the sidebar renders real data rather than an empty phone block.
INSERT INTO public.contact_methods (contact_id, kind, label, value, is_preferred, is_demo)
SELECT c.id, 'phone', 'Work', c.phone, true, c.is_demo
FROM public.contacts c
WHERE c.phone IS NOT NULL AND btrim(c.phone) <> '';