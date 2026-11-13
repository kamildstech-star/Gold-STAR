ALTER TABLE public.option_list_values ADD COLUMN IF NOT EXISTS requires_detail boolean NOT NULL DEFAULT false;

UPDATE public.option_list_values SET requires_detail = true WHERE key = 'other' OR lower(label) = 'other';

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS referral_source_type_detail text,
  ADD COLUMN IF NOT EXISTS job_type_detail text,
  ADD COLUMN IF NOT EXISTS loss_type_detail text,
  ADD COLUMN IF NOT EXISTS loss_description_detail text,
  ADD COLUMN IF NOT EXISTS reported_source_detail text;

ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS loss_type_detail text;
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS decision_role_detail text;
ALTER TABLE public.equipment ADD COLUMN IF NOT EXISTS equipment_type_detail text;
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS account_type_detail text,
  ADD COLUMN IF NOT EXISTS no_service_reason_detail text;
ALTER TABLE public.incidents ADD COLUMN IF NOT EXISTS outcome_detail text;
ALTER TABLE public.account_focus_dismissals
  ADD COLUMN IF NOT EXISTS dismissal_reason text,
  ADD COLUMN IF NOT EXISTS dismissal_reason_detail text;

CREATE OR REPLACE VIEW public.option_other_details
WITH (security_invoker = true) AS
  SELECT 'referral_source_type'::text AS list_key, btrim(referral_source_type_detail) AS detail, count(*)::bigint AS uses, max(created_at) AS last_used
    FROM public.jobs WHERE btrim(coalesce(referral_source_type_detail,'')) <> '' GROUP BY 2
  UNION ALL
  SELECT 'job_type', btrim(job_type_detail), count(*), max(created_at) FROM public.jobs WHERE btrim(coalesce(job_type_detail,'')) <> '' GROUP BY 2
  UNION ALL
  SELECT 'loss_type', btrim(loss_type_detail), count(*), max(created_at) FROM public.jobs WHERE btrim(coalesce(loss_type_detail,'')) <> '' GROUP BY 2
  UNION ALL
  SELECT 'loss_description', btrim(loss_description_detail), count(*), max(created_at) FROM public.jobs WHERE btrim(coalesce(loss_description_detail,'')) <> '' GROUP BY 2
  UNION ALL
  SELECT 'reported_source', btrim(reported_source_detail), count(*), max(created_at) FROM public.jobs WHERE btrim(coalesce(reported_source_detail,'')) <> '' GROUP BY 2
  UNION ALL
  SELECT 'loss_type', btrim(loss_type_detail), count(*), max(created_at) FROM public.projects WHERE btrim(coalesce(loss_type_detail,'')) <> '' GROUP BY 2
  UNION ALL
  SELECT 'contact_decision_role', btrim(decision_role_detail), count(*), max(created_at) FROM public.contacts WHERE btrim(coalesce(decision_role_detail,'')) <> '' GROUP BY 2
  UNION ALL
  SELECT 'equipment_type', btrim(equipment_type_detail), count(*), max(created_at) FROM public.equipment WHERE btrim(coalesce(equipment_type_detail,'')) <> '' GROUP BY 2
  UNION ALL
  SELECT 'account_type', btrim(account_type_detail), count(*), max(created_at) FROM public.accounts WHERE btrim(coalesce(account_type_detail,'')) <> '' GROUP BY 2
  UNION ALL
  SELECT 'no_service_reason', btrim(no_service_reason_detail), count(*), max(created_at) FROM public.accounts WHERE btrim(coalesce(no_service_reason_detail,'')) <> '' GROUP BY 2
  UNION ALL
  SELECT 'chase_outcome', btrim(outcome_detail), count(*), max(reported_at) FROM public.incidents WHERE btrim(coalesce(outcome_detail,'')) <> '' GROUP BY 2
  UNION ALL
  SELECT 'dismissal_reason', btrim(dismissal_reason_detail), count(*), max(dismissed_at) FROM public.account_focus_dismissals WHERE btrim(coalesce(dismissal_reason_detail,'')) <> '' GROUP BY 2;

GRANT SELECT ON public.option_other_details TO authenticated;