ALTER TABLE public.contacts ALTER COLUMN account_id DROP NOT NULL;

ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS location_id uuid REFERENCES public.locations(id);

UPDATE public.contacts c
SET location_id = a.location_id
FROM public.accounts a
WHERE c.account_id = a.id AND c.location_id IS NULL;

UPDATE public.contacts
SET location_id = (SELECT id FROM public.locations ORDER BY created_at LIMIT 1)
WHERE location_id IS NULL;

ALTER TABLE public.contacts ALTER COLUMN location_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS contacts_location_id_idx ON public.contacts(location_id);

DROP POLICY IF EXISTS contacts_select ON public.contacts;
DROP POLICY IF EXISTS contacts_write ON public.contacts;

CREATE POLICY contacts_select ON public.contacts
FOR SELECT TO authenticated
USING (
  public.can_view_location(auth.uid(), location_id)
  OR EXISTS (
    SELECT 1 FROM public.accounts a
    WHERE a.id = contacts.account_id
      AND (public.can_view_location(auth.uid(), a.location_id) OR a.assigned_rep = auth.uid())
  )
);

CREATE POLICY contacts_write ON public.contacts
FOR ALL TO authenticated
USING (
  public.can_manage_location(auth.uid(), location_id)
  OR EXISTS (
    SELECT 1 FROM public.accounts a
    WHERE a.id = contacts.account_id
      AND (public.can_manage_location(auth.uid(), a.location_id) OR a.assigned_rep = auth.uid())
  )
)
WITH CHECK (
  public.can_manage_location(auth.uid(), location_id)
  OR EXISTS (
    SELECT 1 FROM public.accounts a
    WHERE a.id = contacts.account_id
      AND (public.can_manage_location(auth.uid(), a.location_id) OR a.assigned_rep = auth.uid())
  )
);