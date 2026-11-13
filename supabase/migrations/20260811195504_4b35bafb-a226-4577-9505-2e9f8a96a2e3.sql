CREATE OR REPLACE FUNCTION public.account_compliance_indicator(_account_id uuid)
RETURNS text
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH s AS (
    SELECT public.compliance_status_of(c.id IS NOT NULL, c.expiry_date,
             c.limit_occurrence, r.required_amount, r.renewal_lead_days) AS status
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
    WHEN NOT EXISTS (SELECT 1 FROM s WHERE status <> 'satisfied' AND status <> 'expiring_soon')
      THEN 'compliant'
    WHEN EXISTS (SELECT 1 FROM s WHERE status = 'expired')
      OR NOT EXISTS (SELECT 1 FROM s WHERE status IN ('satisfied','expiring_soon'))
      THEN 'not_compliant'
    ELSE 'in_progress'
  END;
$function$;

REVOKE EXECUTE ON FUNCTION public.account_compliance_indicator(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.account_compliance_indicator(uuid) TO authenticated, service_role;