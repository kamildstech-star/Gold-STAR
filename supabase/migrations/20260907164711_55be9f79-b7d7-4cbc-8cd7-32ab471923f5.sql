ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS position_key text;
ALTER TYPE public.share_link_kind ADD VALUE IF NOT EXISTS 'job_photos';