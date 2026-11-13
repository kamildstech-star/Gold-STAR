-- Kept separate from the trigger migration because PostgreSQL enum values
-- added in a transaction cannot safely be consumed until the transaction has
-- committed.
ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'task_completed';
