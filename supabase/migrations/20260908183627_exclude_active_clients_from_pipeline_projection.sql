-- The cross-office projection must enforce the same lifecycle boundary as the
-- full-access query. It exposes only a withheld card, but showing a client on
-- the prospect board is still a workflow/data-classification error.
CREATE OR REPLACE FUNCTION public.pipeline_cards_minimal()
RETURNS TABLE(account_id uuid, account_name text, owning_location_id uuid,
              owning_location_code text, owning_location_name text,
              stage_id uuid, stage_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT a.id, a.name, l.id, l.code, l.name, a.stage_id, ps.name
  FROM public.accounts a
  JOIN public.locations l ON l.id = a.location_id
  LEFT JOIN public.pipeline_stages ps ON ps.id = a.stage_id
  WHERE auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.profiles profile
      WHERE profile.user_id = auth.uid()
        AND profile.is_active = true
        AND profile.approval_status = 'approved'
        AND profile.deactivated_at IS NULL
    )
    AND a.archived_at IS NULL
    AND a.health_stage_id IS NULL
    AND COALESCE(a.status::text, '') NOT IN ('active', 'onboarding')
    AND COALESCE(ps.is_won, false) = false
    AND NOT (COALESCE(a.created_by = auth.uid(), false)
             OR COALESCE(a.assigned_rep = auth.uid(), false)
             OR public.can_view_location(auth.uid(), a.location_id));
$$;

REVOKE ALL ON FUNCTION public.pipeline_cards_minimal() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pipeline_cards_minimal() TO authenticated, service_role;
