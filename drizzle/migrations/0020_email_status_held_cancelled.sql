ALTER TYPE public.email_status ADD VALUE IF NOT EXISTS 'held';
ALTER TYPE public.email_status ADD VALUE IF NOT EXISTS 'cancelled';