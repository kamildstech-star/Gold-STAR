-- Managed category list -----------------------------------------------------
INSERT INTO public.option_lists (key, label, description)
VALUES ('relationship_note_category', 'Relationship note category',
        'Categories the AI dump box parses a rep''s free text into.')
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.option_list_values (list_id, key, label, sort_order)
SELECT l.id, v.key, v.label, v.sort
FROM public.option_lists l,
     (VALUES ('birthday','Birthday',10),
             ('interests','Interests',20),
             ('family','Family',30),
             ('contact_timing','Contact timing',40),
             ('preferences','Preferences',50),
             ('avoid','Avoid',60)) AS v(key,label,sort)
WHERE l.key = 'relationship_note_category'
ON CONFLICT DO NOTHING;

-- Raw dumps -------------------------------------------------------------------
CREATE TABLE public.contact_note_dumps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  body text NOT NULL,
  source text NOT NULL DEFAULT 'typed',
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contact_note_dumps_contact_idx ON public.contact_note_dumps (contact_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.contact_note_dumps TO authenticated;
GRANT ALL ON public.contact_note_dumps TO service_role;
ALTER TABLE public.contact_note_dumps ENABLE ROW LEVEL SECURITY;

CREATE POLICY contact_note_dumps_select ON public.contact_note_dumps
FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.contacts c WHERE c.id = contact_id));

CREATE POLICY contact_note_dumps_insert ON public.contact_note_dumps
FOR INSERT TO authenticated
WITH CHECK (created_by = (SELECT auth.uid())
            AND EXISTS (SELECT 1 FROM public.contacts c WHERE c.id = contact_id));

CREATE POLICY contact_note_dumps_delete ON public.contact_note_dumps
FOR DELETE TO authenticated
USING (created_by = (SELECT auth.uid()) OR public.is_privileged((SELECT auth.uid())));

-- Parsed facts ----------------------------------------------------------------
CREATE TABLE public.contact_relationship_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  category_key text NOT NULL,
  value text NOT NULL,
  source text NOT NULL DEFAULT 'ai',
  dump_id uuid REFERENCES public.contact_note_dumps(id) ON DELETE SET NULL,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contact_id, category_key)
);
CREATE INDEX contact_relationship_facts_contact_idx ON public.contact_relationship_facts (contact_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.contact_relationship_facts TO authenticated;
GRANT ALL ON public.contact_relationship_facts TO service_role;
ALTER TABLE public.contact_relationship_facts ENABLE ROW LEVEL SECURITY;

CREATE POLICY contact_relationship_facts_select ON public.contact_relationship_facts
FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.contacts c WHERE c.id = contact_id));

CREATE POLICY contact_relationship_facts_write ON public.contact_relationship_facts
FOR ALL TO authenticated
USING (EXISTS (SELECT 1 FROM public.contacts c WHERE c.id = contact_id))
WITH CHECK (EXISTS (SELECT 1 FROM public.contacts c WHERE c.id = contact_id));

CREATE TRIGGER trg_contact_relationship_facts_updated_at
BEFORE UPDATE ON public.contact_relationship_facts
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();