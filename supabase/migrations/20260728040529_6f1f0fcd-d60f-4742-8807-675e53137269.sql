ALTER FUNCTION public.set_updated_at() SET search_path = public;

REVOKE ALL ON FUNCTION public.is_regional_for(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_regional_for(uuid, uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.search_accounts_minimal(text) FROM anon;
