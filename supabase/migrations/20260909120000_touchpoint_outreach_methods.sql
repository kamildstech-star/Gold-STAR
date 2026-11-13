-- The outreach standard (Mark, 9 Sep): "Five attempts, using at least three
-- different methods, within thirty days, spread across at least five
-- separate days. ... The methods are phone, email, text, showing up in
-- person, LinkedIn, and mail."
--
-- Attempts are outbound touchpoints. touchpoint_type is a Postgres enum, so
-- the methods live there, not in an option list: call (phone), email and
-- meeting_in_person (showing up) already exist; text, LinkedIn and mail did
-- not. This file adds ONLY the enum values — Postgres will not let a value be
-- used in the transaction that created it, so everything that reads them is
-- in 20260909120100_pipeline_outreach_rules.sql.
--
-- The method a type counts as is public.touchpoint_method(type) — see the
-- next migration and src/lib/pipeline-rules.ts, which carry the same table.

ALTER TYPE public.touchpoint_type ADD VALUE IF NOT EXISTS 'text';
ALTER TYPE public.touchpoint_type ADD VALUE IF NOT EXISTS 'linkedin';
ALTER TYPE public.touchpoint_type ADD VALUE IF NOT EXISTS 'mail';
