ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS certificates_email text;

ALTER TABLE public.compliance_requirement_files
  ADD COLUMN IF NOT EXISTS cert_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS cert_sent_to text,
  ADD COLUMN IF NOT EXISTS cert_sent_by uuid;

CREATE OR REPLACE FUNCTION public.account_compliance_indicator(_account_id uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH s AS (
    SELECT public.compliance_status_of(c.id IS NOT NULL, c.expiry_date,
             c.limit_occurrence, r.required_amount, r.renewal_lead_days) AS status,
           LEAST(
             c.expiry_date,
             (SELECT MIN(f.expiry_date) FROM public.compliance_requirement_files f
               WHERE f.requirement_id = r.id AND f.slot = 'certificate' AND f.is_current)
           ) AS expiry
    FROM public.account_compliance_requirements r
    JOIN public.accounts a ON a.id = r.account_id
    LEFT JOIN LATERAL (
      SELECT cc.* FROM public.company_credentials cc
      WHERE cc.active AND cc.kind = r.requirement_type
        AND (cc.holder_location_id IS NULL OR cc.holder_location_id = a.location_id)
      ORDER BY (cc.limit_occurrence IS NOT NULL AND r.required_amount IS NOT NULL
                AND cc.limit_occurrence >= r.required_amount) DESC,
               cc.expiry_date DESC NULLS LAST, cc.created_at DESC
      LIMIT 1
    ) c ON true
    WHERE r.account_id = _account_id AND r.active
  )
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM s) THEN 'none'
    WHEN EXISTS (SELECT 1 FROM s WHERE status = 'expired' OR expiry <= current_date)
      OR NOT EXISTS (SELECT 1 FROM s WHERE status IN ('satisfied','expiring_soon'))
      THEN 'not_compliant'
    WHEN EXISTS (SELECT 1 FROM s WHERE expiry IS NOT NULL AND expiry <= current_date + 7)
      THEN 'expiring'
    WHEN NOT EXISTS (SELECT 1 FROM s WHERE status <> 'satisfied' AND status <> 'expiring_soon')
      THEN 'compliant'
    ELSE 'in_progress'
  END;
$function$;