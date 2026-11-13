-- A share link for a job's drying report.
--
-- WRITTEN, NOT APPLIED. One enum value. Nothing existing changes. Until this is
-- applied the drying report's "Share link" button says it is waiting on it.
--
-- David, 13 Oct: the drying report should go to the insurance company as a
-- LINK. The share_links table, its job-scoped RLS (can_view_job to read,
-- can_manage_job to create and revoke), the token, expiry and revoke, and the
-- public /share/<token> page already exist for the schedule and photos; this
-- is one more kind of the same link. The link names one filed copy of the
-- report (share_links.document_ids) — the customer version, with no entry
-- dates or weather-station details — and the public byte route streams only
-- that document, re-checking the token, revoke and expiry on every request.

ALTER TYPE public.share_link_kind ADD VALUE IF NOT EXISTS 'job_drying_report';
