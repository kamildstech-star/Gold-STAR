-- Consumable supply requests: gloves, bags, tape, masks. Small module, but it
-- follows the same shape as expenses: request -> manager decision -> fulfilment.

ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'supply_request';
ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'supply_status';

CREATE TYPE public.supply_request_status AS ENUM
  ('requested', 'approved', 'ordered', 'delivered', 'denied');

-- Catalog ------------------------------------------------------------------
CREATE TABLE public.supply_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  unit text NOT NULL DEFAULT 'each',
  category text,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 100,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX supply_items_name_key ON public.supply_items (lower(name));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.supply_items TO authenticated;
GRANT ALL ON public.supply_items TO service_role;
ALTER TABLE public.supply_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "supply_items_read" ON public.supply_items FOR SELECT TO authenticated
  USING (true);
CREATE POLICY "supply_items_manage" ON public.supply_items FOR ALL TO authenticated
  USING (public.is_privileged(auth.uid()))
  WITH CHECK (public.is_privileged(auth.uid()));

-- Requests -----------------------------------------------------------------
CREATE TABLE public.supply_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE RESTRICT,
  job_id uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
  note text,
  needed_by date,
  status public.supply_request_status NOT NULL DEFAULT 'requested',
  denial_reason text,
  decided_by uuid REFERENCES auth.users(id),
  decided_at timestamptz,
  ordered_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX supply_requests_location_idx ON public.supply_requests (location_id, status);
CREATE INDEX supply_requests_requester_idx ON public.supply_requests (requester_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.supply_requests TO authenticated;
GRANT ALL ON public.supply_requests TO service_role;
ALTER TABLE public.supply_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "supply_requests_select" ON public.supply_requests FOR SELECT TO authenticated
  USING (requester_id = auth.uid() OR public.can_manage_location(auth.uid(), location_id));
CREATE POLICY "supply_requests_insert" ON public.supply_requests FOR INSERT TO authenticated
  WITH CHECK (requester_id = auth.uid());
CREATE POLICY "supply_requests_update_own" ON public.supply_requests FOR UPDATE TO authenticated
  USING (requester_id = auth.uid() AND status = 'requested')
  WITH CHECK (requester_id = auth.uid());
CREATE POLICY "supply_requests_update_mgr" ON public.supply_requests FOR UPDATE TO authenticated
  USING (public.can_manage_location(auth.uid(), location_id))
  WITH CHECK (public.can_manage_location(auth.uid(), location_id));
CREATE POLICY "supply_requests_delete_own" ON public.supply_requests FOR DELETE TO authenticated
  USING (requester_id = auth.uid() AND status = 'requested');

-- Lines --------------------------------------------------------------------
CREATE TABLE public.supply_request_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.supply_requests(id) ON DELETE CASCADE,
  item_id uuid REFERENCES public.supply_items(id) ON DELETE SET NULL,
  -- "Other" free text, per the standing rule that a dropdown never dead-ends.
  other_label text,
  quantity numeric(10,2) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supply_line_named CHECK (item_id IS NOT NULL OR nullif(btrim(coalesce(other_label,'')),'') IS NOT NULL)
);
CREATE INDEX supply_request_lines_request_idx ON public.supply_request_lines (request_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.supply_request_lines TO authenticated;
GRANT ALL ON public.supply_request_lines TO service_role;
ALTER TABLE public.supply_request_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY "supply_lines_select" ON public.supply_request_lines FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.supply_requests r WHERE r.id = request_id
    AND (r.requester_id = auth.uid() OR public.can_manage_location(auth.uid(), r.location_id))));
CREATE POLICY "supply_lines_write" ON public.supply_request_lines FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.supply_requests r WHERE r.id = request_id
    AND r.requester_id = auth.uid() AND r.status = 'requested'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.supply_requests r WHERE r.id = request_id
    AND r.requester_id = auth.uid() AND r.status = 'requested'));

CREATE TRIGGER supply_items_updated_at BEFORE UPDATE ON public.supply_items
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER supply_requests_updated_at BEFORE UPDATE ON public.supply_requests
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Starter catalog so the first request is pick-and-go, not type-everything.
INSERT INTO public.supply_items (name, unit, category, sort_order) VALUES
  ('Nitrile gloves', 'box', 'PPE', 10),
  ('N95 masks', 'box', 'PPE', 20),
  ('Tyvek suits', 'each', 'PPE', 30),
  ('Safety glasses', 'each', 'PPE', 40),
  ('Contractor garbage bags', 'roll', 'Site', 50),
  ('6 mil poly sheeting', 'roll', 'Site', 60),
  ('Blue painters tape', 'roll', 'Site', 70),
  ('Duct tape', 'roll', 'Site', 80),
  ('Zipper door kit', 'each', 'Containment', 90),
  ('Shop towels', 'pack', 'Cleaning', 100),
  ('Disinfectant', 'gallon', 'Cleaning', 110),
  ('Air scrubber filters', 'each', 'Equipment consumables', 120);
