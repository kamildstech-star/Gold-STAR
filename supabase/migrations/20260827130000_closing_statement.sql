-- A closing statement on estimates and invoices.
--
-- `notes` already prints as "Description" above the line items - the narrative
-- of what we will do, read before the rates. There was no counterpart for what
-- is said after the money: terms, what happens next, who to call. People were
-- pushing that into the description, where the customer meets it before they
-- have any idea what the job is.
--
-- Nullable and no default: an estimate written before today has no closing
-- statement, and a backfilled sentence would be words nobody chose appearing on
-- documents that have already gone out.

alter table public.estimates add column if not exists closing_statement text;
alter table public.invoices  add column if not exists closing_statement text;

comment on column public.estimates.closing_statement is
  'Prints in its own section after the line items and totals. Customer-facing.';
comment on column public.invoices.closing_statement is
  'Prints in its own section after the line items and totals. Customer-facing.';
