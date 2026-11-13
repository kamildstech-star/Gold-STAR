ALTER TABLE public.commission_payouts DROP CONSTRAINT IF EXISTS commission_payouts_status_check;
UPDATE public.commission_payouts SET status = 'paid' WHERE status = 'issued';
ALTER TABLE public.commission_payouts
  ADD CONSTRAINT commission_payouts_status_check
  CHECK (status = ANY (ARRAY['pending'::text, 'approved'::text, 'paid'::text, 'void'::text]));