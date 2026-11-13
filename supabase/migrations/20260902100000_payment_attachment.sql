-- A recorded payment can carry the photograph the office was actually sent:
-- a cheque, a remittance advice, a screenshot of an ACH confirmation. Someone
-- reconciling a short payment needs to see what the carrier sent, not only the
-- number somebody typed.
--
-- ON DELETE SET NULL, not CASCADE: the payment row is the money record and the
-- image is evidence attached to it. Deleting the picture — because it was the
-- wrong cheque, or because it should never have been filed — must never take
-- the payment, and with it the invoice's collected total, along with it.
--
-- The image is an ordinary `documents` row, so it inherits `documents_select`
-- (the job's location audience) and `documents_objects_read` for its bytes.
-- Nothing here widens that: a cheque photo shows a routing and account number
-- and must stay inside the office.

alter table public.invoice_payments
  add column if not exists document_id uuid references public.documents(id) on delete set null;

create index if not exists invoice_payments_document_idx
  on public.invoice_payments (document_id)
  where document_id is not null;
