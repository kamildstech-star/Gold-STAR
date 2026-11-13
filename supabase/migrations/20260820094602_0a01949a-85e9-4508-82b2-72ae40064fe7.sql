ALTER TYPE public.incident_outcome ADD VALUE IF NOT EXISTS 'not_owner';
ALTER TYPE public.incident_outcome ADD VALUE IF NOT EXISTS 'going_direct';
ALTER TYPE public.incident_outcome ADD VALUE IF NOT EXISTS 'damage_too_minor';
ALTER TYPE public.incident_outcome ADD VALUE IF NOT EXISTS 'wrong_address';