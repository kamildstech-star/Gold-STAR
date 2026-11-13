-- 1. tag scope enum additions
ALTER TYPE tag_scope ADD VALUE IF NOT EXISTS 'account';
ALTER TYPE tag_scope ADD VALUE IF NOT EXISTS 'opportunity';
