-- ============================================================
-- Billing: estimates, invoices, payments
-- ============================================================

CREATE TYPE public.quote_status AS ENUM ('draft','internal_review','submitted','approved','rejected','superseded');
CREATE TYPE public.quote_category AS ENUM ('labor','equipment','materials','disposal','mitigation','reconstruction','other');
CREATE TYPE public.invoice_status AS ENUM ('draft','sent','partial','paid','disputed','written_off');
CREATE TYPE public.document_type AS ENUM ('work_authorization','contract','coi','w9','carrier_correspondence','estimate','invoice','certificate','photo_report','other');
CREATE TYPE public.document_status AS ENUM ('draft','pending_signature','signed','active','expired','void');
CREATE TYPE public.signature_provider AS ENUM ('native','docuseal','opensign');

-- Jobs gain the carrier-approved figure so the estimated -> billed -> approved
-- -> collected chain is complete at job level.
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS approved_amount numeric(12,2);

-- ---------------- quotes ----------------
CREATE TABLE public.quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES public.locations(id),
  version integer NOT NULL DEFAULT 1,
  status public.quote_status NOT NULL DEFAULT 'draft',
  title text,
  xactimate_reference text,
  notes text,
  subtotal numeric(12,2) NOT NULL DEFAULT 0,
  tax numeric(12,2) NOT NULL DEFAULT 0,
  total numeric(12,2) NOT NULL DEFAULT 0,
  submitted_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, version)
);
CREATE INDEX quotes_job_idx ON public.quotes (job_id, version DESC);
CREATE INDEX quotes_location_idx ON public.quotes (location_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.quotes TO authenticated;
GRANT ALL ON public.quotes TO service_role;
ALTER TABLE public.quotes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "quotes_select" ON public.quotes FOR SELECT TO authenticated
  USING (public.can_view_location(auth.uid(), location_id) OR created_by = auth.uid());
CREATE POLICY "quotes_insert" ON public.quotes FOR INSERT TO authenticated
  WITH CHECK (public.can_view_location(auth.uid(), location_id) AND created_by = auth.uid());
CREATE POLICY "quotes_update" ON public.quotes FOR UPDATE TO authenticated
  USING (public.can_manage_location(auth.uid(), location_id) OR created_by = auth.uid());
CREATE POLICY "quotes_delete" ON public.quotes FOR DELETE TO authenticated
  USING (public.can_manage_location(auth.uid(), location_id));

CREATE TRIGGER quotes_set_updated_at BEFORE UPDATE ON public.quotes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------- quote line items ----------------
CREATE TABLE public.quote_line_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id uuid NOT NULL REFERENCES public.quotes(id) ON DELETE CASCADE,
  position integer NOT NULL DEFAULT 0,
  description text NOT NULL,
  category public.quote_category NOT NULL DEFAULT 'other',
  quantity numeric(12,2) NOT NULL DEFAULT 1,
  unit text NOT NULL DEFAULT 'ea',
  unit_price numeric(12,2) NOT NULL DEFAULT 0,
  line_total numeric(14,2) GENERATED ALWAYS AS (quantity * unit_price) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX quote_line_items_quote_idx ON public.quote_line_items (quote_id, position);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.quote_line_items TO authenticated;
GRANT ALL ON public.quote_line_items TO service_role;
ALTER TABLE public.quote_line_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "quote_items_select" ON public.quote_line_items FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.quotes q WHERE q.id = quote_id
                 AND (public.can_view_location(auth.uid(), q.location_id) OR q.created_by = auth.uid())));
CREATE POLICY "quote_items_write" ON public.quote_line_items FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.quotes q WHERE q.id = quote_id
                 AND (public.can_manage_location(auth.uid(), q.location_id) OR q.created_by = auth.uid())))
  WITH CHECK (EXISTS (SELECT 1 FROM public.quotes q WHERE q.id = quote_id
                 AND (public.can_manage_location(auth.uid(), q.location_id) OR q.created_by = auth.uid())));

CREATE TRIGGER quote_line_items_set_updated_at BEFORE UPDATE ON public.quote_line_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Totals always derive from the line items; nobody hand-edits a total.
CREATE OR REPLACE FUNCTION public.tg_quote_recalc()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _quote uuid := COALESCE(NEW.quote_id, OLD.quote_id);
  _sub numeric(12,2);
BEGIN
  SELECT COALESCE(SUM(line_total), 0) INTO _sub
  FROM public.quote_line_items WHERE quote_id = _quote;
  UPDATE public.quotes
     SET subtotal = _sub,
         total = _sub + COALESCE(tax, 0)
   WHERE id = _quote;
  RETURN NULL;
END;
$$;

CREATE TRIGGER quote_line_items_recalc
AFTER INSERT OR UPDATE OR DELETE ON public.quote_line_items
FOR EACH ROW EXECUTE FUNCTION public.tg_quote_recalc();

-- ---------------- invoices ----------------
CREATE SEQUENCE public.invoice_number_seq;

CREATE TABLE public.invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number text NOT NULL UNIQUE,
  job_id uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
  account_id uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  location_id uuid NOT NULL REFERENCES public.locations(id),
  carrier text,
  claim_number text,
  adjuster_name text,
  adjuster_email text,
  issue_date date NOT NULL DEFAULT CURRENT_DATE,
  due_date date,
  billed_amount numeric(12,2) NOT NULL DEFAULT 0,
  approved_amount numeric(12,2),
  collected_amount numeric(12,2) NOT NULL DEFAULT 0,
  -- The two numbers leadership has never been able to measure.
  carrier_shortfall numeric(14,2) GENERATED ALWAYS AS (billed_amount - COALESCE(approved_amount, billed_amount)) STORED,
  uncollected numeric(14,2) GENERATED ALWAYS AS (billed_amount - collected_amount) STORED,
  status public.invoice_status NOT NULL DEFAULT 'draft',
  sent_at timestamptz,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invoices_job_idx ON public.invoices (job_id);
CREATE INDEX invoices_location_idx ON public.invoices (location_id);
CREATE INDEX invoices_carrier_idx ON public.invoices (carrier);
CREATE INDEX invoices_status_idx ON public.invoices (status, due_date);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.invoices TO authenticated;
GRANT ALL ON public.invoices TO service_role;
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "invoices_select" ON public.invoices FOR SELECT TO authenticated
  USING (public.can_view_location(auth.uid(), location_id) OR created_by = auth.uid());
CREATE POLICY "invoices_insert" ON public.invoices FOR INSERT TO authenticated
  WITH CHECK (public.can_view_location(auth.uid(), location_id) AND created_by = auth.uid());
CREATE POLICY "invoices_update" ON public.invoices FOR UPDATE TO authenticated
  USING (public.can_manage_location(auth.uid(), location_id) OR created_by = auth.uid());
CREATE POLICY "invoices_delete" ON public.invoices FOR DELETE TO authenticated
  USING (public.can_manage_location(auth.uid(), location_id));

CREATE TRIGGER invoices_set_updated_at BEFORE UPDATE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE FUNCTION public.tg_invoice_number()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.invoice_number IS NULL OR NEW.invoice_number = '' THEN
    NEW.invoice_number := 'GS-INV-' || to_char(now(), 'YYYY') || '-' ||
      lpad(nextval('public.invoice_number_seq')::text, 5, '0');
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER invoices_number BEFORE INSERT ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.tg_invoice_number();

-- ---------------- invoice payments ----------------
CREATE TABLE public.invoice_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  amount numeric(12,2) NOT NULL,
  received_at date NOT NULL DEFAULT CURRENT_DATE,
  method text,
  reference text,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invoice_payments_invoice_idx ON public.invoice_payments (invoice_id, received_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.invoice_payments TO authenticated;
GRANT ALL ON public.invoice_payments TO service_role;
ALTER TABLE public.invoice_payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "invoice_payments_select" ON public.invoice_payments FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.invoices i WHERE i.id = invoice_id
                 AND (public.can_view_location(auth.uid(), i.location_id) OR i.created_by = auth.uid())));
CREATE POLICY "invoice_payments_write" ON public.invoice_payments FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.invoices i WHERE i.id = invoice_id
                 AND (public.can_manage_location(auth.uid(), i.location_id) OR i.created_by = auth.uid())))
  WITH CHECK (EXISTS (SELECT 1 FROM public.invoices i WHERE i.id = invoice_id
                 AND (public.can_manage_location(auth.uid(), i.location_id) OR i.created_by = auth.uid())));

-- Collected total and status always follow the payment records.
CREATE OR REPLACE FUNCTION public.tg_invoice_payment_rollup()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _inv uuid := COALESCE(NEW.invoice_id, OLD.invoice_id);
  _sum numeric(12,2);
  _billed numeric(12,2);
  _status public.invoice_status;
BEGIN
  SELECT COALESCE(SUM(amount), 0) INTO _sum
  FROM public.invoice_payments WHERE invoice_id = _inv;
  SELECT billed_amount, status INTO _billed, _status
  FROM public.invoices WHERE id = _inv;

  UPDATE public.invoices
     SET collected_amount = _sum,
         status = CASE
           WHEN _status IN ('disputed','written_off') THEN _status
           WHEN _sum <= 0 THEN CASE WHEN _status = 'draft' THEN 'draft' ELSE 'sent' END
           WHEN _sum < _billed THEN 'partial'
           ELSE 'paid'
         END
   WHERE id = _inv;
  RETURN NULL;
END;
$$;

CREATE TRIGGER invoice_payments_rollup
AFTER INSERT OR UPDATE OR DELETE ON public.invoice_payments
FOR EACH ROW EXECUTE FUNCTION public.tg_invoice_payment_rollup();

-- ============================================================
-- Documents and signatures
-- ============================================================

CREATE TABLE public.documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES public.locations(id),
  job_id uuid REFERENCES public.jobs(id) ON DELETE CASCADE,
  account_id uuid REFERENCES public.accounts(id) ON DELETE CASCADE,
  project_id uuid REFERENCES public.projects(id) ON DELETE CASCADE,
  incident_id uuid REFERENCES public.incidents(id) ON DELETE SET NULL,
  doc_type public.document_type NOT NULL DEFAULT 'other',
  name text NOT NULL,
  description text,
  status public.document_status NOT NULL DEFAULT 'draft',
  storage_bucket text,
  storage_path text,
  mime text,
  size_bytes bigint,
  expiry_date date,
  provider public.signature_provider,
  provider_ref text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX documents_job_idx ON public.documents (job_id);
CREATE INDEX documents_account_idx ON public.documents (account_id);
CREATE INDEX documents_project_idx ON public.documents (project_id);
CREATE INDEX documents_location_idx ON public.documents (location_id, doc_type);
CREATE INDEX documents_expiry_idx ON public.documents (expiry_date) WHERE expiry_date IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.documents TO authenticated;
GRANT ALL ON public.documents TO service_role;
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "documents_select" ON public.documents FOR SELECT TO authenticated
  USING (public.can_view_location(auth.uid(), location_id) OR created_by = auth.uid());
CREATE POLICY "documents_insert" ON public.documents FOR INSERT TO authenticated
  WITH CHECK (public.can_view_location(auth.uid(), location_id) AND created_by = auth.uid());
-- A signed document is evidence: once signed nobody edits or deletes it.
CREATE POLICY "documents_update" ON public.documents FOR UPDATE TO authenticated
  USING (status <> 'signed'
         AND (public.can_manage_location(auth.uid(), location_id) OR created_by = auth.uid()));
CREATE POLICY "documents_delete" ON public.documents FOR DELETE TO authenticated
  USING (status <> 'signed' AND public.can_manage_location(auth.uid(), location_id));

CREATE TRIGGER documents_set_updated_at BEFORE UPDATE ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.document_signatures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  signer_name text NOT NULL,
  signer_role text,
  signer_email text,
  signer_phone text,
  signed_at timestamptz NOT NULL DEFAULT now(),
  lat double precision,
  lon double precision,
  signature_path text,
  provider public.signature_provider NOT NULL DEFAULT 'native',
  provider_ref text,
  captured_by uuid,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX document_signatures_doc_idx ON public.document_signatures (document_id, signed_at DESC);

GRANT SELECT, INSERT ON public.document_signatures TO authenticated;
GRANT ALL ON public.document_signatures TO service_role;
ALTER TABLE public.document_signatures ENABLE ROW LEVEL SECURITY;

CREATE POLICY "document_signatures_select" ON public.document_signatures FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.documents d WHERE d.id = document_id
                 AND (public.can_view_location(auth.uid(), d.location_id) OR d.created_by = auth.uid())));
CREATE POLICY "document_signatures_insert" ON public.document_signatures FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.documents d WHERE d.id = document_id
                 AND (public.can_view_location(auth.uid(), d.location_id) OR d.created_by = auth.uid())));

-- Signing a document locks it. The signature row is the trigger for that.
CREATE OR REPLACE FUNCTION public.tg_document_signed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.documents
     SET status = 'signed'
   WHERE id = NEW.document_id
     AND status <> 'signed';
  RETURN NEW;
END;
$$;

CREATE TRIGGER document_signatures_lock
AFTER INSERT ON public.document_signatures
FOR EACH ROW EXECUTE FUNCTION public.tg_document_signed();