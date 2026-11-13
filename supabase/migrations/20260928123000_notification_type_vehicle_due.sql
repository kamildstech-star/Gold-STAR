-- A notification type for vehicle inspection / registration / insurance /
-- service coming due. David, 24 Sep, on Fleet: vehicle maintenance tracking,
-- with his Fleet-Vehicle Info sheet (insurance policy, registration and
-- inspection dates) as the data it has to hold.
--
-- In its own file: an enum value added with ALTER TYPE ... ADD VALUE cannot be
-- used in the transaction that adds it, and the next migration
-- (20260928124000_vehicle_maintenance.sql) writes it. Run this one first.

ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'vehicle_due';
