-- The first Job Calculator migration is already recorded in production.
-- Add the newly clarified workbook field without rewriting that history.
alter table public.job_calculations
  add column if not exists job_date date not null default current_date;
