-- Invoices become as full as estimates: scopes + catalogue lines drive the
-- billed amount, instead of a single typed figure.
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS tax_rate numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS subtotal numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total numeric(12,2) NOT NULL DEFAULT 0,
  -- false = quick invoice (one typed amount); true = totals come from lines.
  ADD COLUMN IF NOT EXISTS line_itemized boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS title text,
  ADD COLUMN IF NOT EXISTS job_number text,
  ADD COLUMN IF NOT EXISTS customer_name text,
  ADD COLUMN IF NOT EXISTS address text,
  ADD COLUMN IF NOT EXISTS address_line2 text,
  ADD COLUMN IF NOT EXISTS locality text,
  ADD COLUMN IF NOT EXISTS region text,
  ADD COLUMN IF NOT EXISTS postal_code text,
  ADD COLUMN IF NOT EXISTS office_name text,
  ADD COLUMN IF NOT EXISTS office_phone text,
  ADD COLUMN IF NOT EXISTS office_email text,
  ADD COLUMN IF NOT EXISTS office_address text;

CREATE TABLE IF NOT EXISTS public.invoice_scopes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  name text NOT NULL,
  room_name text,
  notes text,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  scope_id uuid REFERENCES public.invoice_scopes(id) ON DELETE CASCADE,
  catalog_item_id uuid REFERENCES public.estimate_catalog_items(id) ON DELETE SET NULL,
  position integer NOT NULL DEFAULT 0,
  code text,
  name text NOT NULL,
  description text,
  uom text NOT NULL DEFAULT 'EA',
  quantity numeric NOT NULL DEFAULT 1,
  unit_cost numeric NOT NULL DEFAULT 0,
  unit_price numeric NOT NULL DEFAULT 0,
  taxable boolean NOT NULL DEFAULT true,
  is_discount boolean NOT NULL DEFAULT false,
  note text,
  subtotal numeric GENERATED ALWAYS AS (quantity * unit_price) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS invoice_scopes_invoice_idx ON public.invoice_scopes(invoice_id);
CREATE INDEX IF NOT EXISTS invoice_lines_invoice_idx ON public.invoice_lines(invoice_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.invoice_scopes TO authenticated;
GRANT ALL ON public.invoice_scopes TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.invoice_lines TO authenticated;
GRANT ALL ON public.invoice_lines TO service_role;

ALTER TABLE public.invoice_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY invoice_scopes_all ON public.invoice_scopes FOR ALL TO authenticated
USING (EXISTS (SELECT 1 FROM public.invoices i WHERE i.id = invoice_scopes.invoice_id
  AND (public.can_view_location((SELECT auth.uid()), i.location_id) OR i.created_by = (SELECT auth.uid()))))
WITH CHECK (EXISTS (SELECT 1 FROM public.invoices i WHERE i.id = invoice_scopes.invoice_id
  AND (public.can_view_location((SELECT auth.uid()), i.location_id) OR i.created_by = (SELECT auth.uid()))));

CREATE POLICY invoice_lines_all ON public.invoice_lines FOR ALL TO authenticated
USING (EXISTS (SELECT 1 FROM public.invoices i WHERE i.id = invoice_lines.invoice_id
  AND (public.can_view_location((SELECT auth.uid()), i.location_id) OR i.created_by = (SELECT auth.uid()))))
WITH CHECK (EXISTS (SELECT 1 FROM public.invoices i WHERE i.id = invoice_lines.invoice_id
  AND (public.can_view_location((SELECT auth.uid()), i.location_id) OR i.created_by = (SELECT auth.uid()))));

CREATE TRIGGER invoice_scopes_set_updated_at BEFORE UPDATE ON public.invoice_scopes
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER invoice_lines_set_updated_at BEFORE UPDATE ON public.invoice_lines
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Totals are computed in the database, never in the client: two people editing
-- the same invoice can never disagree about the number that gets billed.
CREATE OR REPLACE FUNCTION public.recalc_invoice_totals()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  iid uuid := COALESCE(NEW.invoice_id, OLD.invoice_id);
  rate numeric; sub numeric; taxable_sub numeric;
BEGIN
  SELECT tax_rate INTO rate FROM public.invoices WHERE id = iid;
  IF rate IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;
  SELECT COALESCE(SUM(subtotal), 0), COALESCE(SUM(subtotal) FILTER (WHERE taxable), 0)
    INTO sub, taxable_sub FROM public.invoice_lines WHERE invoice_id = iid;
  UPDATE public.invoices
     SET subtotal = ROUND(sub, 2),
         tax = ROUND(taxable_sub * rate, 2),
         total = ROUND(sub, 2) + ROUND(taxable_sub * rate, 2),
         line_itemized = true,
         billed_amount = ROUND(sub, 2) + ROUND(taxable_sub * rate, 2)
   WHERE id = iid;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER invoice_lines_recalc AFTER INSERT OR UPDATE OR DELETE ON public.invoice_lines
FOR EACH ROW EXECUTE FUNCTION public.recalc_invoice_totals();

CREATE OR REPLACE FUNCTION public.recalc_invoice_totals_on_rate()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE sub numeric; taxable_sub numeric;
BEGIN
  SELECT COALESCE(SUM(subtotal), 0), COALESCE(SUM(subtotal) FILTER (WHERE taxable), 0)
    INTO sub, taxable_sub FROM public.invoice_lines WHERE invoice_id = NEW.id;
  NEW.subtotal := ROUND(sub, 2);
  NEW.tax := ROUND(taxable_sub * NEW.tax_rate, 2);
  NEW.total := NEW.subtotal + NEW.tax;
  IF NEW.line_itemized THEN NEW.billed_amount := NEW.total; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER invoices_recalc_on_rate BEFORE UPDATE OF tax_rate ON public.invoices
FOR EACH ROW WHEN (OLD.tax_rate IS DISTINCT FROM NEW.tax_rate)
EXECUTE FUNCTION public.recalc_invoice_totals_on_rate();