-- Fix: CASE branches returned text, not the enum type.
CREATE OR REPLACE FUNCTION public.tg_equipment_placement_status()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  IF NEW.retrieved_at IS NULL THEN
    UPDATE public.equipment SET status = 'on_job'::public.equipment_status
     WHERE id = NEW.equipment_id AND status IN ('available','in_transit');
  ELSE
    UPDATE public.equipment
      SET status = (CASE WHEN NEW.return_condition = 'missing' THEN 'lost'
                         WHEN NEW.return_condition IN ('damaged','needs_service') THEN 'maintenance'
                         ELSE 'available' END)::public.equipment_status
      WHERE id = NEW.equipment_id AND status = 'on_job';
  END IF;
  RETURN NEW;
END; $function$;

CREATE OR REPLACE FUNCTION public.tg_invoice_payment_rollup()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
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
         status = (CASE
           WHEN _status IN ('disputed','written_off') THEN _status::text
           WHEN _sum <= 0 THEN CASE WHEN _status = 'draft' THEN 'draft' ELSE 'sent' END
           WHEN _sum < COALESCE(_billed, 0) THEN 'partial'
           ELSE 'paid'
         END)::public.invoice_status
   WHERE id = _inv;
  RETURN NULL;
END;
$function$;

ALTER TABLE public.vendor_documents ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS vendor_documents_is_demo_idx ON public.vendor_documents (is_demo) WHERE is_demo;
ALTER TABLE public.contact_attempts ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS contact_attempts_is_demo_idx ON public.contact_attempts (is_demo) WHERE is_demo;
ALTER TABLE public.lead_notes ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS lead_notes_is_demo_idx ON public.lead_notes (is_demo) WHERE is_demo;

CREATE OR REPLACE FUNCTION public.demo_tables()
RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path TO 'public' AS $function$
  -- Child-first ordering: purge walks this array in order.
  SELECT ARRAY[
    'feature_request_status_history','feature_request_comments','feature_request_votes','feature_requests',
    'gift_campaign_recipients','gift_sends','gift_campaigns','gift_catalog',
    'automation_events','automation_rules',
    'incident_events','incidents',
    'money_events','invoice_payments','invoices',
    'quote_line_items','quotes',
    'documents','vendor_documents',
    'equipment_placements','equipment',
    'time_entries','shifts',
    'tasks','notifications',
    'job_assignments','job_contacts','job_notes','job_status_history','jobs',
    'captured_communications','touchpoints','account_notes','account_stage_history','contacts',
    'goals','expense_requests','expenses',
    'accounts',
    'contact_attempts','lead_notes',
    'location_members','user_roles','profiles'
  ]::text[];
$function$;