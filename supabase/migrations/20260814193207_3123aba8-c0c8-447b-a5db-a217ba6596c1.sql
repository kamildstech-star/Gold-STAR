CREATE OR REPLACE FUNCTION public.accounts_compliance_indicators(_ids uuid[])
RETURNS TABLE(account_id uuid, indicator text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT a.id, public.account_compliance_indicator(a.id)
  FROM public.accounts a
  WHERE a.id = ANY(_ids);
$$;

GRANT EXECUTE ON FUNCTION public.accounts_compliance_indicators(uuid[]) TO authenticated;