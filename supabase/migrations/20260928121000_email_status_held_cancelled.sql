-- Two new states for an outbound email: 'held' (inside the undo window) and
-- 'cancelled' (the sender stopped it during the window).
--
-- David, 24 Sep: "Sending in 4:32 — Edit · Cancel."
--
-- In a file of its own on purpose: a value added by ALTER TYPE ... ADD VALUE
-- cannot be used in the same transaction that adds it, and the next migration
-- (20260928122000_email_send_delay.sql) uses both. Run this one first.

ALTER TYPE public.email_status ADD VALUE IF NOT EXISTS 'held';
ALTER TYPE public.email_status ADD VALUE IF NOT EXISTS 'cancelled';
