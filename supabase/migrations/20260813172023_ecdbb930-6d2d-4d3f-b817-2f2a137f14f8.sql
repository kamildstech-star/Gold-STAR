-- ============ enums ============
CREATE TYPE public.estimate_status AS ENUM ('draft','sent','approved','declined');

-- ============ catalog headers ============
CREATE TABLE public.estimate_headers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.estimate_headers TO authenticated;
GRANT ALL ON public.estimate_headers TO service_role;
ALTER TABLE public.estimate_headers ENABLE ROW LEVEL SECURITY;
CREATE POLICY estimate_headers_select ON public.estimate_headers FOR SELECT TO authenticated USING (true);
CREATE POLICY estimate_headers_write ON public.estimate_headers TO authenticated
  USING (public.is_privileged((SELECT auth.uid()))) WITH CHECK (public.is_privileged((SELECT auth.uid())));
CREATE TRIGGER estimate_headers_set_updated_at BEFORE UPDATE ON public.estimate_headers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============ catalog items ============
CREATE TABLE public.estimate_catalog_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  header_id uuid REFERENCES public.estimate_headers(id) ON DELETE SET NULL,
  code text NOT NULL,
  name text NOT NULL,
  description text,
  uom text NOT NULL DEFAULT 'EA',
  default_unit_price numeric(12,2) NOT NULL DEFAULT 0,
  default_cost numeric(12,2) NOT NULL DEFAULT 0,
  taxable boolean NOT NULL DEFAULT true,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (code)
);
CREATE INDEX estimate_catalog_items_header_idx ON public.estimate_catalog_items(header_id, sort_order);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.estimate_catalog_items TO authenticated;
GRANT ALL ON public.estimate_catalog_items TO service_role;
ALTER TABLE public.estimate_catalog_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY estimate_catalog_items_select ON public.estimate_catalog_items FOR SELECT TO authenticated USING (true);
CREATE POLICY estimate_catalog_items_write ON public.estimate_catalog_items TO authenticated
  USING (public.is_privileged((SELECT auth.uid()))) WITH CHECK (public.is_privileged((SELECT auth.uid())));
CREATE TRIGGER estimate_catalog_items_set_updated_at BEFORE UPDATE ON public.estimate_catalog_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============ estimates ============
CREATE TABLE public.estimates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES public.locations(id),
  seq integer NOT NULL,
  status public.estimate_status NOT NULL DEFAULT 'draft',
  title text,
  call_date date,
  estimate_date date NOT NULL DEFAULT current_date,
  -- snapshots taken at creation so a printed estimate never changes under the customer
  job_number text,
  customer_name text,
  account_id uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  address text,
  address_line2 text,
  locality text,
  region text,
  postal_code text,
  office_name text,
  office_phone text,
  office_email text,
  office_address text,
  tax_rate numeric(6,4) NOT NULL DEFAULT 0,
  notes text,
  subtotal numeric(14,2) NOT NULL DEFAULT 0,
  tax numeric(14,2) NOT NULL DEFAULT 0,
  total numeric(14,2) NOT NULL DEFAULT 0,
  sent_at timestamptz,
  decided_at timestamptz,
  created_by uuid REFERENCES public.profiles(user_id) ON DELETE SET NULL,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, seq)
);
CREATE INDEX estimates_job_idx ON public.estimates(job_id, seq DESC);
CREATE INDEX estimates_location_idx ON public.estimates(location_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.estimates TO authenticated;
GRANT ALL ON public.estimates TO service_role;
ALTER TABLE public.estimates ENABLE ROW LEVEL SECURITY;
CREATE POLICY estimates_select ON public.estimates FOR SELECT TO authenticated
  USING (public.can_view_location((SELECT auth.uid()), location_id) OR created_by = (SELECT auth.uid()));
CREATE POLICY estimates_insert ON public.estimates FOR INSERT TO authenticated
  WITH CHECK (public.can_view_location((SELECT auth.uid()), location_id) AND created_by = (SELECT auth.uid()));
CREATE POLICY estimates_update ON public.estimates FOR UPDATE TO authenticated
  USING (public.can_manage_location((SELECT auth.uid()), location_id) OR created_by = (SELECT auth.uid()))
  WITH CHECK (public.can_manage_location((SELECT auth.uid()), location_id) OR created_by = (SELECT auth.uid()));
CREATE POLICY estimates_delete ON public.estimates FOR DELETE TO authenticated
  USING (public.can_manage_location((SELECT auth.uid()), location_id) OR created_by = (SELECT auth.uid()));
CREATE TRIGGER estimates_set_updated_at BEFORE UPDATE ON public.estimates
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- per-job sequence: ESTIMATE-1, ESTIMATE-2 ...
CREATE OR REPLACE FUNCTION public.assign_estimate_seq()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.seq IS NULL OR NEW.seq = 0 THEN
    SELECT COALESCE(MAX(seq), 0) + 1 INTO NEW.seq FROM public.estimates WHERE job_id = NEW.job_id;
  END IF;
  RETURN NEW;
END;
$$;
ALTER TABLE public.estimates ALTER COLUMN seq DROP NOT NULL;
CREATE TRIGGER estimates_assign_seq BEFORE INSERT ON public.estimates
  FOR EACH ROW EXECUTE FUNCTION public.assign_estimate_seq();

-- ============ scopes ============
CREATE TABLE public.estimate_scopes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  estimate_id uuid NOT NULL REFERENCES public.estimates(id) ON DELETE CASCADE,
  name text NOT NULL,
  room_name text,
  notes text,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX estimate_scopes_estimate_idx ON public.estimate_scopes(estimate_id, position);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.estimate_scopes TO authenticated;
GRANT ALL ON public.estimate_scopes TO service_role;
ALTER TABLE public.estimate_scopes ENABLE ROW LEVEL SECURITY;
CREATE POLICY estimate_scopes_all ON public.estimate_scopes TO authenticated
  USING (EXISTS (SELECT 1 FROM public.estimates e WHERE e.id = estimate_id
    AND (public.can_view_location((SELECT auth.uid()), e.location_id) OR e.created_by = (SELECT auth.uid()))))
  WITH CHECK (EXISTS (SELECT 1 FROM public.estimates e WHERE e.id = estimate_id
    AND (public.can_view_location((SELECT auth.uid()), e.location_id) OR e.created_by = (SELECT auth.uid()))));
CREATE TRIGGER estimate_scopes_set_updated_at BEFORE UPDATE ON public.estimate_scopes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============ lines ============
CREATE TABLE public.estimate_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  estimate_id uuid NOT NULL REFERENCES public.estimates(id) ON DELETE CASCADE,
  scope_id uuid REFERENCES public.estimate_scopes(id) ON DELETE CASCADE,
  catalog_item_id uuid REFERENCES public.estimate_catalog_items(id) ON DELETE SET NULL,
  position integer NOT NULL DEFAULT 0,
  code text,
  name text NOT NULL,
  description text,
  uom text NOT NULL DEFAULT 'EA',
  quantity numeric(12,2) NOT NULL DEFAULT 1,
  unit_cost numeric(12,2) NOT NULL DEFAULT 0,
  unit_price numeric(12,2) NOT NULL DEFAULT 0,
  taxable boolean NOT NULL DEFAULT true,
  -- discount lines carry a negative unit price and require a note
  is_discount boolean NOT NULL DEFAULT false,
  note text,
  subtotal numeric(14,2) GENERATED ALWAYS AS (quantity * unit_price) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX estimate_lines_estimate_idx ON public.estimate_lines(estimate_id, position);
CREATE INDEX estimate_lines_scope_idx ON public.estimate_lines(scope_id, position);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.estimate_lines TO authenticated;
GRANT ALL ON public.estimate_lines TO service_role;
ALTER TABLE public.estimate_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY estimate_lines_all ON public.estimate_lines TO authenticated
  USING (EXISTS (SELECT 1 FROM public.estimates e WHERE e.id = estimate_id
    AND (public.can_view_location((SELECT auth.uid()), e.location_id) OR e.created_by = (SELECT auth.uid()))))
  WITH CHECK (EXISTS (SELECT 1 FROM public.estimates e WHERE e.id = estimate_id
    AND (public.can_view_location((SELECT auth.uid()), e.location_id) OR e.created_by = (SELECT auth.uid()))));
CREATE TRIGGER estimate_lines_set_updated_at BEFORE UPDATE ON public.estimate_lines
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- keep estimate totals in step with its lines; tax only on taxable lines
CREATE OR REPLACE FUNCTION public.recalc_estimate_totals()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  eid uuid := COALESCE(NEW.estimate_id, OLD.estimate_id);
  rate numeric;
  sub numeric;
  taxable_sub numeric;
BEGIN
  SELECT tax_rate INTO rate FROM public.estimates WHERE id = eid;
  IF rate IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;
  SELECT COALESCE(SUM(subtotal), 0),
         COALESCE(SUM(subtotal) FILTER (WHERE taxable), 0)
    INTO sub, taxable_sub
    FROM public.estimate_lines WHERE estimate_id = eid;
  UPDATE public.estimates
     SET subtotal = ROUND(sub, 2),
         tax = ROUND(taxable_sub * rate, 2),
         total = ROUND(sub, 2) + ROUND(taxable_sub * rate, 2)
   WHERE id = eid;
  RETURN COALESCE(NEW, OLD);
END;
$$;
CREATE TRIGGER estimate_lines_recalc AFTER INSERT OR UPDATE OR DELETE ON public.estimate_lines
  FOR EACH ROW EXECUTE FUNCTION public.recalc_estimate_totals();

CREATE OR REPLACE FUNCTION public.recalc_estimate_totals_on_rate()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE sub numeric; taxable_sub numeric;
BEGIN
  SELECT COALESCE(SUM(subtotal), 0), COALESCE(SUM(subtotal) FILTER (WHERE taxable), 0)
    INTO sub, taxable_sub FROM public.estimate_lines WHERE estimate_id = NEW.id;
  NEW.subtotal := ROUND(sub, 2);
  NEW.tax := ROUND(taxable_sub * NEW.tax_rate, 2);
  NEW.total := NEW.subtotal + NEW.tax;
  RETURN NEW;
END;
$$;
CREATE TRIGGER estimates_recalc_on_rate BEFORE UPDATE OF tax_rate ON public.estimates
  FOR EACH ROW WHEN (OLD.tax_rate IS DISTINCT FROM NEW.tax_rate)
  EXECUTE FUNCTION public.recalc_estimate_totals_on_rate();

-- ============ scope templates ============
CREATE TABLE public.estimate_scope_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  location_id uuid REFERENCES public.locations(id) ON DELETE CASCADE,
  created_by uuid REFERENCES public.profiles(user_id) ON DELETE SET NULL,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.estimate_scope_templates TO authenticated;
GRANT ALL ON public.estimate_scope_templates TO service_role;
ALTER TABLE public.estimate_scope_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY estimate_scope_templates_select ON public.estimate_scope_templates FOR SELECT TO authenticated
  USING (location_id IS NULL OR public.can_view_location((SELECT auth.uid()), location_id));
CREATE POLICY estimate_scope_templates_insert ON public.estimate_scope_templates FOR INSERT TO authenticated
  WITH CHECK (created_by = (SELECT auth.uid())
    AND (location_id IS NULL OR public.can_view_location((SELECT auth.uid()), location_id)));
CREATE POLICY estimate_scope_templates_update ON public.estimate_scope_templates FOR UPDATE TO authenticated
  USING (created_by = (SELECT auth.uid()) OR public.is_privileged((SELECT auth.uid())))
  WITH CHECK (created_by = (SELECT auth.uid()) OR public.is_privileged((SELECT auth.uid())));
CREATE POLICY estimate_scope_templates_delete ON public.estimate_scope_templates FOR DELETE TO authenticated
  USING (created_by = (SELECT auth.uid()) OR public.is_privileged((SELECT auth.uid())));
CREATE TRIGGER estimate_scope_templates_set_updated_at BEFORE UPDATE ON public.estimate_scope_templates
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.estimate_scope_template_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES public.estimate_scope_templates(id) ON DELETE CASCADE,
  catalog_item_id uuid REFERENCES public.estimate_catalog_items(id) ON DELETE SET NULL,
  position integer NOT NULL DEFAULT 0,
  code text,
  name text NOT NULL,
  description text,
  uom text NOT NULL DEFAULT 'EA',
  quantity numeric(12,2) NOT NULL DEFAULT 1,
  unit_cost numeric(12,2) NOT NULL DEFAULT 0,
  unit_price numeric(12,2) NOT NULL DEFAULT 0,
  taxable boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX estimate_scope_template_lines_tpl_idx ON public.estimate_scope_template_lines(template_id, position);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.estimate_scope_template_lines TO authenticated;
GRANT ALL ON public.estimate_scope_template_lines TO service_role;
ALTER TABLE public.estimate_scope_template_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY estimate_scope_template_lines_all ON public.estimate_scope_template_lines TO authenticated
  USING (EXISTS (SELECT 1 FROM public.estimate_scope_templates t WHERE t.id = template_id
    AND (t.location_id IS NULL OR public.can_view_location((SELECT auth.uid()), t.location_id))))
  WITH CHECK (EXISTS (SELECT 1 FROM public.estimate_scope_templates t WHERE t.id = template_id
    AND (t.created_by = (SELECT auth.uid()) OR public.is_privileged((SELECT auth.uid())))));

-- default tax rate lives with the other admin settings
INSERT INTO public.app_settings (key, value)
VALUES ('estimates', '{"tax_rate": 0.08875}'::jsonb)
ON CONFLICT (key) DO NOTHING;